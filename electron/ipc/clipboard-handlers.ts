import { app, clipboard, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'

export function registerClipboardHandlers(): void {
  // One-click paste: the renderer can read text via navigator.clipboard, but
  // IMAGES on the Windows clipboard (screenshot tools, right-click-copy-image)
  // are only reliably reachable from the main process. We land the bitmap in a
  // temp PNG and hand back a real path so it flows through the same file://
  // pipeline as a dropped or browsed image.
  ipcMain.handle('clipboard-read-text', async () => clipboard.readText())

  ipcMain.handle('clipboard-read-image', async (): Promise<string | null> => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const dir = path.join(app.getPath('userData'), 'clipboard-paste')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `paste-${Date.now()}.png`)
    fs.writeFileSync(file, img.toPNG())
    return file
  })
}
