import { ipcMain, dialog, BrowserWindow, session } from 'electron'
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import { getAllowedRoots } from '../config'
import { logger } from '../logger'
import { getMainWindow } from '../window'
import { validatePath, approvePath } from '../path-validation'

// Active fs.watch watchers, keyed by the absolute file path being watched.
const storyWatchers = new Map<string, fs.FSWatcher>()

// Walk up from a file until we find the aiobr repo root (the dir holding
// scripts/build_timeline_from_story.js). Returns null if not found.
function findRepoRoot(startFile: string): string | null {
  let dir = path.dirname(startFile)
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'scripts', 'build_timeline_from_story.js'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
}

function readLocalFileAsBase64(filePath: string): { data: string; mimeType: string } {
  const data = fs.readFileSync(filePath)
  const base64 = data.toString('base64')
  const ext = path.extname(filePath).toLowerCase()
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream'
  return { data: base64, mimeType }
}

function searchDirectoryForFiles(dir: string, filenames: string[]): Record<string, string> {
  const results: Record<string, string> = {}
  const remaining = new Set(filenames.map(f => f.toLowerCase()))

  const walk = (currentDir: string, depth: number) => {
    if (remaining.size === 0 || depth > 10) return // max depth to avoid infinite loops
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      for (const entry of entries) {
        if (remaining.size === 0) break
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isFile()) {
          const lower = entry.name.toLowerCase()
          if (remaining.has(lower)) {
            results[lower] = fullPath
            remaining.delete(lower)
          }
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walk(fullPath, depth + 1)
        }
      }
    } catch {
      // Skip directories we can't read (permissions, etc.)
    }
  }

  walk(dir, 0)
  return results
}


export function registerFileHandlers(): void {
  ipcMain.handle('open-ltx-api-key-page', async () => {
    const { shell } = await import('electron')
    await shell.openExternal('https://console.ltx.video/api-keys/')
    return true
  })

  ipcMain.handle('open-replicate-api-key-page', async () => {
    const { shell } = await import('electron')
    await shell.openExternal('https://replicate.com/account/api-tokens')
    return true
  })

  ipcMain.handle('open-palette-login-page', async () => {
    const PALETTE_URL = 'https://directorspal.com'
    const mainWindow = getMainWindow()

    // Create a dedicated login session so we don't pollute the main session
    const loginSession = session.fromPartition('palette-login')

    const loginWindow = new BrowserWindow({
      width: 500,
      height: 700,
      parent: mainWindow ?? undefined,
      modal: true,
      show: false,
      webPreferences: {
        session: loginSession,
        nodeIntegration: false,
        contextIsolation: true,
      },
      backgroundColor: '#1a1a1a',
      title: "Sign In to Director's Palette",
    })

    loginWindow.setMenuBarVisibility(false)
    loginWindow.once('ready-to-show', () => loginWindow.show())

    // Poll for the Supabase session from cookies or localStorage.
    // @supabase/ssr stores auth tokens as cookies on the Palette domain,
    // either as a single cookie or chunked (sb-<ref>-auth-token.0, .1, etc.)
    const checkForToken = async (): Promise<string | null> => {
      try {
        const allCookies = await loginSession.cookies.get({})

        logger.info(`[palette-login] Found ${allCookies.length} cookies`)

        // Look for Supabase SSR auth cookies (sb-<ref>-auth-token or chunked .0, .1, ...)
        const baseCookies = allCookies.filter(c =>
          c.name.startsWith('sb-') && c.name.includes('-auth-token')
        )

        if (baseCookies.length > 0) {
          // Check for a single (non-chunked) cookie first
          const single = baseCookies.find(c =>
            c.name.match(/^sb-[^.]+$/) && c.name.endsWith('-auth-token')
          )
          let cookieValue: string | null = null

          if (single?.value) {
            cookieValue = single.value
          } else {
            // Reassemble chunked cookies: sb-<ref>-auth-token.0, .1, .2, ...
            const chunks = baseCookies
              .filter(c => /\.\d+$/.test(c.name))
              .sort((a, b) => {
                const aIdx = parseInt(a.name.split('.').pop() || '0', 10)
                const bIdx = parseInt(b.name.split('.').pop() || '0', 10)
                return aIdx - bIdx
              })

            if (chunks.length > 0) {
              cookieValue = chunks.map(c => c.value).join('')
            }
          }

          if (cookieValue) {
            try {
              const decoded = decodeURIComponent(cookieValue)
              const parsed = JSON.parse(decoded)
              if (parsed.access_token) {
                logger.info('[palette-login] Token found in Supabase SSR cookie')
                return parsed.access_token as string
              }
            } catch {
              // Try base64 decode
              try {
                const decoded = Buffer.from(cookieValue, 'base64').toString('utf-8')
                const parsed = JSON.parse(decoded)
                if (parsed.access_token) {
                  logger.info('[palette-login] Token found in base64 cookie')
                  return parsed.access_token as string
                }
              } catch { /* not parseable */ }
            }
          }
        }

        // Fallback: check localStorage (older Supabase clients store tokens there)
        const token = await loginWindow.webContents.executeJavaScript(`
          (function() {
            try {
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
                  const raw = localStorage.getItem(key);
                  if (raw) {
                    try {
                      const parsed = JSON.parse(raw);
                      if (parsed.access_token) return parsed.access_token;
                    } catch(e) {}
                  }
                }
              }
            } catch(e) {}
            return null;
          })()
        `).catch(() => null)

        return token as string | null
      } catch {
        return null
      }
    }

    let pollTimer: ReturnType<typeof setInterval> | null = null
    let resolved = false

    const onTokenFound = (token: string) => {
      if (resolved) return
      resolved = true
      if (pollTimer) clearInterval(pollTimer)
      logger.info('[palette-login] Token captured successfully')
      if (mainWindow) {
        mainWindow.webContents.send('palette-auth-callback', { token })
      }
      loginWindow.close()
    }

    // Start polling after each navigation completes
    loginWindow.webContents.on('did-finish-load', () => {
      const url = loginWindow.webContents.getURL()
      logger.info(`[palette-login] Navigated to: ${url}`)

      // Start polling aggressively on any Palette domain page
      if (url.startsWith(PALETTE_URL)) {
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = setInterval(async () => {
          const token = await checkForToken()
          if (token) onTokenFound(token)
        }, 500)
        // Also check immediately
        void checkForToken().then(t => { if (t) onTokenFound(t) })
      }
    })

    // Also check after any redirect (with delay for cookie to be set)
    loginWindow.webContents.on('did-navigate', async (_event, url) => {
      logger.info(`[palette-login] did-navigate: ${url}`)
      // Check immediately
      let token = await checkForToken()
      if (token) { onTokenFound(token); return }
      // Cookies may not be set yet — retry after a short delay
      await new Promise(r => setTimeout(r, 1000))
      token = await checkForToken()
      if (token) onTokenFound(token)
    })

    // Check on in-page navigation too (SPA redirects)
    loginWindow.webContents.on('did-navigate-in-page', async (_event, url) => {
      logger.info(`[palette-login] did-navigate-in-page: ${url}`)
      let token = await checkForToken()
      if (token) { onTokenFound(token); return }
      await new Promise(r => setTimeout(r, 1000))
      token = await checkForToken()
      if (token) onTokenFound(token)
    })

    loginWindow.on('closed', () => {
      if (pollTimer) clearInterval(pollTimer)
      // Clear the login session cookies
      loginSession.cookies.flushStore().catch(() => {})
    })

    await loginWindow.loadURL(`${PALETTE_URL}/auth/signin`)
    return true
  })

  ipcMain.handle('open-palette-api-key-page', async () => {
    const { shell } = await import('electron')
    await shell.openExternal('https://directorspal.com/settings/api-keys')
    return true
  })

  ipcMain.handle('open-parent-folder-of-file', async (_event, filePath: string) => {
    const { shell } = await import('electron')
    const normalizedPath = validatePath(filePath, getAllowedRoots())
    const parentDir = path.dirname(normalizedPath)
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
      throw new Error(`Parent directory not found: ${parentDir}`)
    }
    shell.openPath(parentDir)
  })

  ipcMain.handle('show-item-in-folder', async (_event, filePath: string) => {
    const { shell } = await import('electron')
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('read-local-file', async (_event, filePath: string) => {
    try {
      const normalizedPath = validatePath(filePath, getAllowedRoots())

      if (!fs.existsSync(normalizedPath)) {
        throw new Error(`File not found: ${normalizedPath}`)
      }

      return readLocalFileAsBase64(normalizedPath)
    } catch (error) {
      logger.error( `Error reading local file: ${error}`)
      throw error
    }
  })

  ipcMain.handle('show-save-dialog', async (_event, options: {
    title?: string
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }) => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || 'Save File',
      defaultPath: options.defaultPath,
      filters: options.filters || [],
    })
    if (result.canceled || !result.filePath) return null
    approvePath(result.filePath)
    return result.filePath
  })

  ipcMain.handle('save-file', async (_event, filePath: string, data: string, encoding?: string) => {
    try {
      validatePath(filePath, getAllowedRoots())
      if (encoding === 'base64') {
        fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
      } else {
        fs.writeFileSync(filePath, data, 'utf-8')
      }
      return { success: true, path: filePath }
    } catch (error) {
      logger.error( `Error saving file: ${error}`)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('save-binary-file', async (_event, filePath: string, data: ArrayBuffer) => {
    try {
      validatePath(filePath, getAllowedRoots())
      fs.writeFileSync(filePath, Buffer.from(data))
      return { success: true, path: filePath }
    } catch (error) {
      logger.error( `Error saving binary file: ${error}`)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('show-open-directory-dialog', async (_event, options: { title?: string }) => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Select Folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    approvePath(result.filePaths[0])
    return result.filePaths[0]
  })

  ipcMain.handle('search-directory-for-files', async (_event, dir: string, filenames: string[]) => {
    return searchDirectoryForFiles(dir, filenames)
  })

  ipcMain.handle('copy-file', async (_event, src: string, dest: string) => {
    try {
      validatePath(src, getAllowedRoots())
      validatePath(dest, getAllowedRoots())
      const dir = path.dirname(dest)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(src, dest)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('check-files-exist', async (_event, filePaths: string[]) => {
    const results: Record<string, boolean> = {}
    for (const p of filePaths) {
      try {
        results[p] = fs.existsSync(p)
      } catch {
        results[p] = false
      }
    }
    return results
  })

  ipcMain.handle('show-open-file-dialog', async (_event, options: {
    title?: string
    filters?: { name: string; extensions: string[] }[]
    properties?: string[]
  }) => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null
    const props: any[] = ['openFile']
    if (options.properties?.includes('multiSelections')) props.push('multiSelections')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Select File',
      filters: options.filters || [],
      properties: props,
    })
    if (result.canceled || result.filePaths.length === 0) return null
    for (const fp of result.filePaths) {
      approvePath(fp)
    }
    return result.filePaths
  })

  ipcMain.handle('ensure-directory', async (_event, dirPath: string) => {
    try {
      validatePath(dirPath, getAllowedRoots())
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // --- Story file bridge (the "living medium" for AIOBR story production) ---

  // Read a text file (e.g. a .story.json) as a UTF-8 string.
  ipcMain.handle('read-text-file', async (_event, filePath: string) => {
    try {
      const normalizedPath = validatePath(filePath, getAllowedRoots())
      if (!fs.existsSync(normalizedPath)) {
        return { success: false, error: `File not found: ${normalizedPath}` }
      }
      return { success: true, content: fs.readFileSync(normalizedPath, 'utf-8') }
    } catch (error) {
      logger.error(`Error reading text file: ${error}`)
      return { success: false, error: String(error) }
    }
  })

  // Watch a story file for external edits (e.g. Claude editing the JSON).
  // Emits 'story-file-changed' to the renderer (debounced) on change.
  ipcMain.handle('watch-file', async (_event, filePath: string) => {
    try {
      const normalizedPath = validatePath(filePath, getAllowedRoots())
      // Drop any prior watcher for this path so re-loading doesn't stack them.
      const existing = storyWatchers.get(normalizedPath)
      if (existing) {
        existing.close()
        storyWatchers.delete(normalizedPath)
      }
      let debounce: ReturnType<typeof setTimeout> | null = null
      const watcher = fs.watch(normalizedPath, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          const win = getMainWindow()
          if (win) win.webContents.send('story-file-changed', { path: normalizedPath })
        }, 200)
      })
      storyWatchers.set(normalizedPath, watcher)
      return { success: true }
    } catch (error) {
      logger.error(`Error watching file: ${error}`)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('unwatch-file', async (_event, filePath: string) => {
    try {
      const normalizedPath = validatePath(filePath, getAllowedRoots())
      const watcher = storyWatchers.get(normalizedPath)
      if (watcher) {
        watcher.close()
        storyWatchers.delete(normalizedPath)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Export the story file to a DaVinci-ready FCP7 XML by shelling out to the
  // canonical Node exporter + verifier in the aiobr repo. Correctness lives in
  // those scripts, not in the app — so app flakiness can't break the export.
  ipcMain.handle('run-story-export', async (_event, storyPath: string) => {
    const normalizedPath = validatePath(storyPath, getAllowedRoots())
    const repoRoot = findRepoRoot(normalizedPath)
    if (!repoRoot) {
      return { success: false, error: `Could not locate aiobr repo root above ${normalizedPath}` }
    }
    const relStory = path.relative(repoRoot, normalizedPath).replace(/\\/g, '/')

    const runNode = (scriptRelPath: string, args: string[]): Promise<{ code: number; out: string }> =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [path.join(repoRoot, scriptRelPath), ...args],
          { cwd: repoRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 1024 * 1024 * 16 },
          (err, stdout, stderr) => {
            resolve({ code: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0, out: `${stdout || ''}${stderr || ''}` })
          }
        )
      })

    try {
      const build = await runNode('scripts/build_timeline_from_story.js', ['--story', relStory])
      if (build.code !== 0) {
        return { success: false, stage: 'build', output: build.out, error: 'Timeline build failed' }
      }
      // Exporter writes stories/<slug>/<slug>_timeline.xml by default.
      const slug = path.basename(normalizedPath).replace(/\.story\.json$/, '')
      const xmlPath = path.join(path.dirname(normalizedPath), `${slug}_timeline.xml`)
      const xmlRel = path.relative(repoRoot, xmlPath).replace(/\\/g, '/')
      const verify = await runNode('scripts/verify_timeline_inputs.js', [`--xml=${xmlRel}`])
      return {
        success: verify.code === 0,
        stage: 'verify',
        xmlPath,
        output: `${build.out}\n${verify.out}`,
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
