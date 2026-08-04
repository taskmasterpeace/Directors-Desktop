/**
 * Directors Palette points — the app's cost language for anything cloud.
 *
 * Source of truth for the rate: directors-palette-v2
 * `features/credits/types/credits.types.ts` — `balance: number // Credits in
 * cents (100 = $1.00)`. One point = one cent, always. Image model costs in
 * `lib/image-models.ts` (10 pts / 5 pts / 2 pts) already follow this.
 *
 * SECURITY MODEL (do not weaken): points shown client-side are ESTIMATES for
 * the user; real charging must happen SERVER-SIDE (Palette v2 deducts before
 * dispatching, exactly like dp- image models). A desktop binary can always be
 * patched, so nothing here is enforcement — enforcement is that end-user
 * builds have no provider keys and can only reach providers through Palette.
 * BYO-key mode (your own fal/Replicate keys in Settings) is owner/dev mode
 * and bills the key directly.
 */

export const POINTS_PER_DOLLAR = 100

export function dollarsToPoints(dollars: number): number {
  return Math.ceil(Math.max(0, dollars) * POINTS_PER_DOLLAR)
}

export function formatPoints(points: number): string {
  return `${points} pt${points === 1 ? '' : 's'}`
}

export interface CloudVideoRate {
  /** $ per second of output footage, by resolution key. */
  dollarsPerSecond: Record<string, number>
  /** True when the number is an estimate, not provider-published-and-verified. */
  approx?: boolean
}

/**
 * Per-second rates for the cloud video models DD can submit.
 * wan-animate-replace: fal published pricing, verified July 2026.
 * seedance: fal partner pricing varies by tier and inputs — flagged approx.
 */
export const CLOUD_VIDEO_RATES: Record<string, CloudVideoRate> = {
  'wan-animate-replace': {
    dollarsPerSecond: { '480p': 0.04, '580p': 0.06, '720p': 0.08 },
  },
  'seedance-2.0': {
    dollarsPerSecond: { '480p': 0.08, '720p': 0.15, '1080p': 0.25 },
    approx: true,
  },
  'seedance-2.0-fast': {
    dollarsPerSecond: { '480p': 0.04, '720p': 0.08, '1080p': 0.13 },
    approx: true,
  },
  // fal-hosted H3 (the only compliant H3 path — its open-weights license
  // excludes the US). fal publishes $0.26/s at 2K; the 768P tier's rate is
  // unpublished, so we quote the 2K rate as a worst case rather than invent a
  // cheaper number. DD requests <=768 vertical map to fal's 768P tier.
  'minimax-h3': {
    dollarsPerSecond: { '480p': 0.26, '720p': 0.26, '1080p': 0.26 },
    approx: true,
  },
}

/** Points for `seconds` of footage on a cloud model (null when unknown/local). */
export function estimateCloudPoints(
  model: string,
  resolution: string,
  seconds: number,
): { points: number; approx: boolean } | null {
  const rate = CLOUD_VIDEO_RATES[model]
  if (!rate) return null
  const perSecond =
    rate.dollarsPerSecond[resolution] ?? Object.values(rate.dollarsPerSecond)[0]
  if (perSecond === undefined) return null
  return { points: dollarsToPoints(perSecond * seconds), approx: rate.approx ?? true }
}
