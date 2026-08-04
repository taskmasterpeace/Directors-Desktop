import { describe, it, expect } from 'vitest'
import { buildVideoFilterGraph, type ExportSubtitle } from './video-filter'
import type { FlatSegment } from './timeline'

/**
 * F6 — burned-in captions dropped bold/italic/font at export, so five of the six
 * presets rendered as plain regular text and misrepresented the editor.
 * drawtext takes weight and slant from the font FILE, not from a flag.
 */
const segment: FlatSegment = {
  src: 'C:/media/clip.mp4',
  startTime: 0,
  duration: 5,
  trimStart: 0,
  speed: 1,
  reversed: false,
  muted: false,
  volume: 1,
} as unknown as FlatSegment

function sub(style: Partial<ExportSubtitle['style']>): ExportSubtitle {
  return {
    text: 'hello',
    startTime: 0,
    endTime: 2,
    style: {
      fontSize: 32,
      fontFamily: 'Arial',
      fontWeight: 'normal',
      color: '#FFFFFF',
      backgroundColor: 'transparent',
      position: 'bottom',
      italic: false,
      ...style,
    },
  }
}

const opts = { width: 1920, height: 1080, fps: 24 }
const FONTS = {
  regular: 'C:/Windows/Fonts/arial.ttf',
  bold: 'C:/Windows/Fonts/arialbd.ttf',
  italic: 'C:/Windows/Fonts/ariali.ttf',
  boldItalic: 'C:/Windows/Fonts/arialbi.ttf',
}

describe('caption styling reaches the ffmpeg filter', () => {
  it('uses the bold font file for a bold preset', () => {
    const { filterScript } = buildVideoFilterGraph([segment], {
      ...opts, subtitles: [sub({ fontWeight: 'bold' })], fonts: FONTS,
    })
    expect(filterScript).toContain('arialbd.ttf')
  })

  it('uses the italic font file for an italic preset', () => {
    const { filterScript } = buildVideoFilterGraph([segment], {
      ...opts, subtitles: [sub({ italic: true })], fonts: FONTS,
    })
    expect(filterScript).toContain('ariali.ttf')
  })

  it('uses the bold-italic file when both are set', () => {
    const { filterScript } = buildVideoFilterGraph([segment], {
      ...opts, subtitles: [sub({ fontWeight: 'bold', italic: true })], fonts: FONTS,
    })
    expect(filterScript).toContain('arialbi.ttf')
  })

  it('treats a numeric weight of 600+ as bold', () => {
    const { filterScript } = buildVideoFilterGraph([segment], {
      ...opts, subtitles: [sub({ fontWeight: '700' })], fonts: FONTS,
    })
    expect(filterScript).toContain('arialbd.ttf')
  })

  it('escapes the drive colon so ffmpeg does not read it as an option break', () => {
    const { filterScript } = buildVideoFilterGraph([segment], {
      ...opts, subtitles: [sub({ fontWeight: 'bold' })], fonts: FONTS,
    })
    expect(filterScript).not.toMatch(/fontfile='C:\//)
    expect(filterScript).toContain('C\\\\:/Windows/Fonts/arialbd.ttf')
  })

  it('approximates bold with a stroke when no font file is available', () => {
    // Better a visibly heavier caption than silently plain text.
    const { filterScript } = buildVideoFilterGraph([segment], {
      ...opts, subtitles: [sub({ fontWeight: 'bold' })], fonts: {},
    })
    expect(filterScript).toContain('borderw=')
  })

  it('does not thicken normal-weight text', () => {
    const { filterScript } = buildVideoFilterGraph([segment], {
      ...opts, subtitles: [sub({})], fonts: {},
    })
    expect(filterScript).not.toContain('borderw=')
  })
})
