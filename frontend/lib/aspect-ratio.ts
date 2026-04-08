import type { CaptionTargetModel } from './caption-api'

export type AspectLabel = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '4:5' | '5:4' | '21:9' | 'other'

const LTX_COMPATIBLE: ReadonlySet<AspectLabel> = new Set(['9:16', '16:9'])
const SEEDANCE_COMPATIBLE: ReadonlySet<AspectLabel> = new Set([
  '16:9', '9:16', '1:1', '4:3', '3:4', '21:9',
])

// Label a (width, height) pair with the closest canonical aspect ratio.
// Tolerance is 3% — enough to catch slightly off sizes (e.g. 1024x576 vs 1920x1080).
export function detectAspectRatio(width: number, height: number): AspectLabel {
  if (width <= 0 || height <= 0) return 'other'
  const ratio = width / height
  const candidates: Array<[AspectLabel, number]> = [
    ['1:1', 1],
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['4:3', 4 / 3],
    ['3:4', 3 / 4],
    ['4:5', 4 / 5],
    ['5:4', 5 / 4],
    ['21:9', 21 / 9],
  ]
  for (const [label, value] of candidates) {
    if (Math.abs(ratio - value) / value < 0.03) return label
  }
  return 'other'
}

export function isCompatibleWithTarget(
  ratio: AspectLabel,
  target: CaptionTargetModel,
): boolean {
  const set = target === 'ltx-fast' ? LTX_COMPATIBLE : SEEDANCE_COMPATIBLE
  return set.has(ratio)
}

// Pick the best compatible ratio for a source image + target model.
// Rule: match landscape/portrait orientation of the source.
export function suggestCompatibleRatio(
  width: number,
  height: number,
  target: CaptionTargetModel,
): AspectLabel {
  const isPortrait = height > width
  if (target === 'ltx-fast') {
    return isPortrait ? '9:16' : '16:9'
  }
  // Seedance supports more — prefer the closest canonical to source
  const current = detectAspectRatio(width, height)
  if (SEEDANCE_COMPATIBLE.has(current)) return current
  return isPortrait ? '9:16' : '16:9'
}

export function labelForTarget(target: CaptionTargetModel): string {
  return target === 'ltx-fast' ? 'LTX-2 Fast' : 'Seedance 1.5 Pro'
}

export function compatibleRatiosForTarget(target: CaptionTargetModel): AspectLabel[] {
  return target === 'ltx-fast'
    ? ['9:16', '16:9']
    : ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
}
