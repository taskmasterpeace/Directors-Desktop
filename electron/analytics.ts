// Directors Desktop: Lightricks telemetry has been removed entirely. The
// analytics state file and IPC surface remain (the Settings toggle still
// reads/writes them) but no network request is ever made.
import { randomUUID } from 'crypto';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

interface AppState {
  analyticsEnabled?: boolean
  installationId?: string
  [key: string]: unknown
}

function getAppStatePath(): string {
  return path.join(app.getPath('userData'), 'app_state.json')
}

function readAppState(): AppState {
  const statePath = getAppStatePath()
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as AppState
    }
  } catch (err) {
    console.warn('[analytics] failed to read app state:', err)
  }
  return {}
}

function writeAppState(state: AppState): void {
  fs.writeFileSync(getAppStatePath(), JSON.stringify(state, null, 2))
}

export function getAnalyticsState(): { analyticsEnabled: boolean; installationId: string } {
  const state = readAppState()
  return {
    analyticsEnabled: state.analyticsEnabled !== false,
    installationId: state.installationId ?? '',
  }
}

export function setAnalyticsEnabled(enabled: boolean): void {
  const state = readAppState()
  state.analyticsEnabled = enabled
  // Generate installationId on first enable; persist forever after
  if (enabled && !state.installationId) {
    state.installationId = randomUUID()
  }
  writeAppState(state)
}

export async function sendAnalyticsEvent(
  eventName: string,
  extraDetails?: Record<string, unknown> | null,
): Promise<void> {
  // Directors Desktop policy: telemetry to Lightricks is permanently disabled.
  // Nothing leaves this machine. The IPC surface stays so callers don't break.
  void eventName
  void extraDetails
}
