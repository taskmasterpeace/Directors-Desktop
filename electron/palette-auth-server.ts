/**
 * Director's Palette Google/email sign-in via a loopback redirect (RFC 8252).
 *
 * Google OAuth refuses to run inside an embedded webview, so sign-in must happen in the user's
 * REAL system browser. Rather than rely on the directorsdesktop:// custom protocol (which only
 * registers reliably in a packaged/installed build — not in `npm run dev`), we spin up a tiny
 * one-shot HTTP server bound to 127.0.0.1 on an ephemeral port and use it as the OAuth redirect.
 * This is the same pattern the gcloud / GitHub CLIs use, and it works in dev and packaged builds
 * with no OS protocol registration.
 *
 * Flow:
 *   1. Start a server on http://127.0.0.1:<port>/auth/callback with a random `state` nonce.
 *   2. Open the system browser at directorspal.com/auth/desktop?redirect=<that loopback URL>.
 *   3. The web bridge signs the user in (Google/email) then redirects the browser to the
 *      loopback URL with ?token=&refresh=&state=.
 *   4. We verify `state`, forward { token, refresh } to the renderer (same `palette-auth-callback`
 *      channel the deep-link handler uses), show a success page, and shut the server down.
 *
 * SECURITY: bound to 127.0.0.1 only (never 0.0.0.0), so only local processes can reach it; the
 * `state` nonce prevents a stray local page from injecting a session; the server lives only for
 * the duration of one sign-in (or a 5-minute timeout).
 */

import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'
import { ipcMain, shell } from 'electron'
import { getMainWindow } from './window'
import { logger } from './logger'

const PALETTE_BASE = 'https://directorspal.com'
const LOGIN_TIMEOUT_MS = 5 * 60_000

let activeServer: Server | null = null
let activeTimeout: ReturnType<typeof setTimeout> | null = null

const SUCCESS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Signed in — Director's Desktop</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0b0b0c; color:#ededed;
    display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
  .card { text-align:center; padding:2rem 2.5rem; border:1px solid #27272a; border-radius:16px; background:#18181b; }
  .check { width:44px; height:44px; border-radius:9999px; background:rgba(245,178,26,.15); color:#f5b21a;
    display:flex; align-items:center; justify-content:center; margin:0 auto .9rem; font-size:1.5rem; }
  h1 { font-size:1.05rem; margin:.2rem 0; }
  p { color:#a1a1aa; font-size:.9rem; margin:.3rem 0 0; }
</style></head>
<body><div class="card"><div class="check">&#10003;</div>
<h1>You&rsquo;re signed in</h1><p>Return to Director&rsquo;s Desktop &mdash; you can close this tab.</p></div></body></html>`

const ERROR_HTML = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0b0c;color:#ededed;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><p>Sign-in could not be completed. Please return to Director's Desktop and try again.</p></body>`

function cleanup(): void {
  if (activeTimeout) {
    clearTimeout(activeTimeout)
    activeTimeout = null
  }
  if (activeServer) {
    activeServer.close()
    activeServer = null
  }
}

function startPaletteGoogleLogin(): Promise<{ ok: boolean; error?: string }> {
  // Only one sign-in flow at a time — tear down any prior server first.
  cleanup()
  const state = randomBytes(16).toString('hex')

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/auth/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not found')
          return
        }

        const token = url.searchParams.get('token')
        const refresh = url.searchParams.get('refresh') ?? undefined
        const returnedState = url.searchParams.get('state')

        if (!token || returnedState !== state) {
          logger.warn('[palette-auth] callback rejected (missing token or state mismatch)')
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(ERROR_HTML)
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(SUCCESS_HTML)

        const mainWindow = getMainWindow()
        if (mainWindow) {
          mainWindow.webContents.send('palette-auth-callback', { token, refresh })
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          logger.info('[palette-auth] Loopback token forwarded to renderer')
        }
        cleanup()
      } catch (err) {
        logger.error(`[palette-auth] callback error: ${err}`)
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Error')
        } catch {
          /* response already sent */
        }
      }
    })

    server.on('error', (err) => {
      logger.error(`[palette-auth] server error: ${err}`)
      cleanup()
      resolve({ ok: false, error: String(err) })
    })

    // Ephemeral port on loopback only.
    server.listen(0, '127.0.0.1', () => {
      activeServer = server
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      if (!port) {
        cleanup()
        resolve({ ok: false, error: 'Could not bind a local port' })
        return
      }

      const redirect = `http://127.0.0.1:${port}/auth/callback?state=${state}`
      const authUrl = `${PALETTE_BASE}/auth/desktop?redirect=${encodeURIComponent(redirect)}`

      activeTimeout = setTimeout(() => {
        logger.info('[palette-auth] sign-in timed out — closing loopback server')
        cleanup()
      }, LOGIN_TIMEOUT_MS)

      logger.info(`[palette-auth] loopback listening on 127.0.0.1:${port}; opening browser`)
      void shell.openExternal(authUrl)
      resolve({ ok: true })
    })
  })
}

export function registerPaletteAuthHandlers(): void {
  ipcMain.handle('start-palette-google-login', () => startPaletteGoogleLogin())
}
