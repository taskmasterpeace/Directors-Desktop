import { logger } from './logger';

export type UpdateChannel = 'latest' | 'beta' | 'alpha'

/**
 * Directors Desktop policy: auto-update is disabled. The upstream updater
 * pointed at Lightricks' release feed (electron-builder `publish` was
 * Lightricks/ltx-desktop) and would have phoned home on a timer and installed
 * THEIR builds over this fork. Updates for this fork are pulled manually via
 * git / releases on taskmasterpeace/Directors-Desktop.
 */
export function initAutoUpdater(channel: UpdateChannel = 'latest'): void {
  void channel
  logger.info('[updater] Auto-update disabled by policy — no update checks are made.')
}
