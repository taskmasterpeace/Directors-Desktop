import { existsSync } from 'fs'

/**
 * Resolve real font files for burned-in captions.
 *
 * ffmpeg's `drawtext` has no bold/italic switch — weight and slant live in the
 * font FILE. Without this the export ignored `fontWeight` and `italic` entirely,
 * so five of the six caption presets burned in as plain regular text and
 * misrepresented what the editor showed.
 *
 * I/O lives here so `buildVideoFilterGraph` can stay pure.
 */
export interface FontSet {
  regular?: string
  bold?: string
  italic?: string
  boldItalic?: string
}

/** Candidate files per platform, best first. */
const CANDIDATES: Record<string, Record<keyof FontSet, string[]>> = {
  win32: {
    regular: ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf'],
    bold: ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/segoeuib.ttf'],
    italic: ['C:/Windows/Fonts/ariali.ttf', 'C:/Windows/Fonts/segoeuii.ttf'],
    boldItalic: ['C:/Windows/Fonts/arialbi.ttf', 'C:/Windows/Fonts/segoeuiz.ttf'],
  },
  darwin: {
    regular: ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf'],
    bold: ['/System/Library/Fonts/Supplemental/Arial Bold.ttf'],
    italic: ['/System/Library/Fonts/Supplemental/Arial Italic.ttf'],
    boldItalic: ['/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf'],
  },
  linux: {
    regular: ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
    bold: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
    italic: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf'],
    boldItalic: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf'],
  },
}

/**
 * Find the best available font file for each style on this machine.
 *
 * Anything unresolved is simply absent; the filter builder falls back to a
 * stroke-thickened approximation rather than silently rendering plain text.
 */
export function resolveFontSet(platform: string = process.platform): FontSet {
  const table = CANDIDATES[platform] ?? CANDIDATES.linux
  const out: FontSet = {}
  for (const key of Object.keys(table) as (keyof FontSet)[]) {
    out[key] = table[key].find((p) => {
      try {
        return existsSync(p)
      } catch {
        return false
      }
    })
  }
  return out
}
