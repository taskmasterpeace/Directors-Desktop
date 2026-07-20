import './app-paths'
import { app } from 'electron'
import { setupCSP } from './csp'
import { registerFileProtocol } from './file-protocol'
import { registerExportHandlers } from './export/export-handler'
import { stopExportProcess } from './export/ffmpeg-utils'
import { registerAppHandlers } from './ipc/app-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerLogHandlers } from './ipc/log-handlers'
import { registerVideoProcessingHandlers } from './ipc/video-processing-handlers'
import { initSessionLog } from './logging-management'
import { registerPaletteAuthHandlers } from './palette-auth-server'
import { consumeDeepLinkState } from './palette-auth-state'
import { stopPythonBackend } from './python-backend'
import { initAutoUpdater } from './updater'
import { createWindow, getMainWindow } from './window'
import { sendAnalyticsEvent } from './analytics'
import { logger } from './logger'

// --- GPU crash resilience (Windows) ---
// A transient GPU-process fault (driver/ANGLE) — most reliably reproduced right as the home
// view's hardware-decoded hero video starts — was taking the whole app down with exit
// 0xC0000005, because Chromium kills the browser process once GPU-process crashes exceed a
// small limit. In dev that exit also tripped the vite-electron relaunch loop. Lifting the
// crash limit lets the GPU process restart transparently; the renderer recovery handler in
// window.ts reloads the page if a render/GPU crash does surface. These switches MUST be set
// before app 'ready'.
app.commandLine.appendSwitch('disable-gpu-process-crash-limit')

// Register directorsdesktop:// protocol for auth callbacks
if (process.defaultApp) {
  // Dev mode: pass the app path so Electron can find us
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('directorsdesktop', process.execPath, [
      path.resolve(process.argv[1]),
    ])
  }
} else {
  app.setAsDefaultProtocolClient('directorsdesktop')
}

import path from 'path'

/** Extract auth token from a directorsdesktop:// deep link URL. */
function handleDeepLink(url: string): void {
  // Redact query params (may contain auth tokens)
  const safeUrl = url.split('?')[0] + (url.includes('?') ? '?<redacted>' : '')
  logger.info(`[deep-link] Received: ${safeUrl}`)
  try {
    const parsed = new URL(url)
    // Expected: directorsdesktop://auth/callback?state=NONCE&token=XXX[&refresh=YYY]
    if (parsed.hostname === 'auth' && parsed.pathname === '/callback') {
      // Session-fixation guard: any local app/web page can fire this protocol,
      // so the callback must echo the single-use state nonce we issued in
      // 'open-palette-auth'. Unsolicited or mismatched tokens are dropped.
      const state = parsed.searchParams.get('state')
      if (!consumeDeepLinkState(state)) {
        logger.error('[deep-link] Rejected auth callback: missing or invalid state nonce')
        return
      }
      const token = parsed.searchParams.get('token')
      // The refresh token lets the app stay signed in past the ~1h access-token expiry.
      const refresh = parsed.searchParams.get('refresh') ?? undefined
      if (token) {
        const mainWindow = getMainWindow()
        if (mainWindow) {
          mainWindow.webContents.send('palette-auth-callback', { token, refresh })
          logger.info('[deep-link] Auth token forwarded to renderer')
        }
      }
    }
  } catch (err) {
    logger.error(`[deep-link] Failed to parse URL: ${err}`)
  }
}

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  initSessionLog()

  registerAppHandlers()
  registerFileHandlers()
  registerLogHandlers()
  registerExportHandlers()
  registerVideoProcessingHandlers()
  registerPaletteAuthHandlers()

  // Surface (but don't die from) GPU/utility child-process crashes — see the crash-limit
  // switch above and the renderer recovery in window.ts.
  app.on('child-process-gone', (_event, details) => {
    logger.error(
      `[child-process-gone] type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
    )
  })

  app.on('second-instance', (_event, commandLine) => {
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show()
      }
      mainWindow.focus()
    } else if (app.isReady()) {
      createWindow()
    }

    // On Windows, the deep link URL is in the command line args
    const deepLinkUrl = commandLine.find((arg) => arg.startsWith('directorsdesktop://'))
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl)
    }
  })

  // macOS: handle protocol URL via open-url event
  app.on('open-url', (_event, url) => {
    handleDeepLink(url)
  })

  app.whenReady().then(async () => {
    setupCSP()

    // Allow file:// URLs to load when the page is served from http://localhost (dev mode)
    // and, for media, serve them with the correct Content-Type + Range/206 support so
    // <video>/<audio> can load, seek, and report duration. Non-media requests fall back to
    // the net.fetch passthrough (with bypassCustomProtocolHandlers, so it can't recurse into
    // this handler and overflow the stack — the old 0xC0000005 startup crash).
    registerFileProtocol()

    createWindow()
    initAutoUpdater()
    // Python setup + backend start are now driven by the renderer via IPC

    // Fire analytics event. NOTE: analytics is opt-OUT — enabled unless the
    // user has explicitly disabled it (see getAnalyticsState / sendAnalyticsEvent).
    void sendAnalyticsEvent('ltxdesktop_app_launched')
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      stopPythonBackend()
      app.quit()
    }
  })

  app.on('activate', () => {
    if (getMainWindow() === null) {
      createWindow()
    }
  })

  app.on('before-quit', () => {
    stopExportProcess()
    stopPythonBackend()
  })
}
