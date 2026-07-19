/**
 * Camera Angle helper — ported 1:1 from Palette Shot Creator
 * (src/features/shot-creator/helpers/camera-angle.helper.ts).
 *
 * Maps azimuth/elevation/distance to text tokens for the Qwen Image Edit 2511
 * Multiple-Angles LoRA (96 poses = 8 azimuths × 4 elevations × 3 distances).
 * Prompt format: "<sks> [azimuth] [elevation] [distance]".
 */

export interface CameraAngle {
  /** 0-360 degrees (horizontal rotation) */
  azimuth: number
  /** -30 to 60 degrees (vertical tilt) */
  elevation: number
  /** 0-10 (zoom: 0 = wide, 10 = close-up) */
  distance: number
}

export const DEFAULT_CAMERA_ANGLE: CameraAngle = {
  azimuth: 0,
  elevation: 0,
  distance: 5,
}

const AZIMUTH_SEGMENTS = [
  { min: 337.5, max: 360, label: 'front view' },
  { min: 0, max: 22.5, label: 'front view' },
  { min: 22.5, max: 67.5, label: 'front-right quarter view' },
  { min: 67.5, max: 112.5, label: 'right side view' },
  { min: 112.5, max: 157.5, label: 'back-right quarter view' },
  { min: 157.5, max: 202.5, label: 'back view' },
  { min: 202.5, max: 247.5, label: 'back-left quarter view' },
  { min: 247.5, max: 292.5, label: 'left side view' },
  { min: 292.5, max: 337.5, label: 'front-left quarter view' },
] as const

const ELEVATION_THRESHOLDS = [
  { max: -15, label: 'low-angle shot' },
  { max: 15, label: 'eye-level shot' },
  { max: 45, label: 'elevated shot' },
  { max: 90, label: 'high-angle shot' },
] as const

const DISTANCE_THRESHOLDS = [
  { max: 3.33, label: 'wide shot' },
  { max: 6.67, label: 'medium shot' },
  { max: 10, label: 'close-up' },
] as const

/** Convert azimuth degrees to a text token (wrapping-segment aware). */
export function getAzimuthLabel(azimuth: number): string {
  const normalized = ((azimuth % 360) + 360) % 360
  for (const seg of AZIMUTH_SEGMENTS) {
    if (seg.min <= seg.max) {
      if (normalized >= seg.min && normalized < seg.max) return seg.label
    } else if (normalized >= seg.min || normalized < seg.max) {
      return seg.label
    }
  }
  return 'front view'
}

/** Convert elevation degrees to a text token. */
export function getElevationLabel(elevation: number): string {
  const clamped = Math.max(-30, Math.min(60, elevation))
  for (const t of ELEVATION_THRESHOLDS) {
    if (clamped <= t.max) return t.label
  }
  return 'eye-level shot'
}

/** Convert distance value to a text token. */
export function getDistanceLabel(distance: number): string {
  const clamped = Math.max(0, Math.min(10, distance))
  for (const t of DISTANCE_THRESHOLDS) {
    if (clamped <= t.max) return t.label
  }
  return 'medium shot'
}

/** Full camera-angle prompt token: "<sks> [azimuth] [elevation] [distance]". */
export function buildCameraAnglePrompt(angle: CameraAngle): string {
  return `<sks> ${getAzimuthLabel(angle.azimuth)} ${getElevationLabel(angle.elevation)} ${getDistanceLabel(angle.distance)}`
}

/** Human-readable description for the UI (no <sks> token). */
export function getCameraAngleDescription(angle: CameraAngle): string {
  return `${getAzimuthLabel(angle.azimuth)}, ${getElevationLabel(angle.elevation)}, ${getDistanceLabel(angle.distance)}`
}

export const CAMERA_PRESETS = [
  { name: 'Front', angle: { azimuth: 0, elevation: 0, distance: 5 } },
  { name: 'Right', angle: { azimuth: 90, elevation: 0, distance: 5 } },
  { name: 'Back', angle: { azimuth: 180, elevation: 0, distance: 5 } },
  { name: 'Left', angle: { azimuth: 270, elevation: 0, distance: 5 } },
  { name: 'Hero Low', angle: { azimuth: 30, elevation: -20, distance: 7 } },
  { name: "Bird's Eye", angle: { azimuth: 0, elevation: 55, distance: 3 } },
  { name: 'Close-up', angle: { azimuth: 0, elevation: 0, distance: 9 } },
  { name: 'Wide', angle: { azimuth: 0, elevation: 0, distance: 1 } },
] as const
