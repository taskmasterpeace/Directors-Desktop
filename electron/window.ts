import { app, BrowserWindow, nativeImage, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { isDev, getCurrentDir } from './config'
import { logger } from './logger'

let mainWindow: BrowserWindow | null = null

// Bound crash-reload retries so a renderer that crashes on load can't reload/
// crash forever (see disable-gpu-process-crash-limit in main.ts).
const MAX_RELOADS = 3
const RELOAD_WINDOW_MS = 30_000
let recentReloads: number[] = []

function isSameOrigin(target: string): boolean {
  try {
    const url = new URL(target)
    if (isDev) return url.origin === 'http://localhost:5173'
    return url.protocol === 'file:'
  } catch {
    return false
  }
}

export function createWindow(): BrowserWindow {
  // Get the path to preload script
  const preloadPath = isDev
    ? path.join(getCurrentDir(), 'dist-electron', 'preload.js')
    : path.join(app.getAppPath(), 'dist-electron', 'preload.js')

  // App icon — use .ico on Windows, .png elsewhere
  const iconExt = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const iconPath = path.join(getCurrentDir(), 'resources', iconExt)
  logger.info(`[icon] Loading app icon from: ${iconPath} | exists: ${fs.existsSync(iconPath)}`)
  const appIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    icon: appIcon,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: isDev ? false : true,
    },
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'default',
    show: false,
  })

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    // DevTools can be opened manually with Ctrl+Shift+I or F12
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Confine navigation to the app's own origin. External http(s) links open in
  // the user's browser; everything else is denied. Prevents a content-injection
  // foothold from navigating the window or spawning arbitrary native windows.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isSameOrigin(url)) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url)
      }
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Recover from a renderer/GPU crash instead of letting the app die (Windows GPU-process
  // flakiness, exit 0xC0000005). A transient crash reloads the page rather than taking
  // the whole window down; a clean exit is left alone. Cap retries so a renderer that
  // crashes deterministically on load doesn't reload/crash in a tight loop.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`[render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`)
    if (details.reason === 'clean-exit' || !mainWindow || mainWindow.isDestroyed()) return

    const now = Date.now()
    recentReloads = recentReloads.filter(t => now - t < RELOAD_WINDOW_MS)
    if (recentReloads.length >= MAX_RELOADS) {
      logger.error(
        `[render-process-gone] ${recentReloads.length} reloads within ${RELOAD_WINDOW_MS}ms — ` +
        'giving up to avoid a crash loop.',
      )
      return
    }
    recentReloads.push(now)
    mainWindow.webContents.reload()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
