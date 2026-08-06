import { ipcMain } from 'electron'
import { getMainWindow } from '../window'

export function registerWindowHandlers(): void {
  // Windows taskbar progress fill — render state stays glanceable while the
  // user is alt-tabbed away from a 5-15 minute local render.
  // value: 0..1 = fraction, >1 = indeterminate pulse, <0 = clear.
  ipcMain.handle('set-taskbar-progress', async (_event, value: number) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    const v = typeof value === 'number' && Number.isFinite(value) ? value : -1
    win.setProgressBar(v < 0 ? -1 : Math.min(v, 2))
  })
}
