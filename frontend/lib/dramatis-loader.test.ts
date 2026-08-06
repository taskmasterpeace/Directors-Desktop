import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  loadDramatisChapter,
  dbToLinear,
  speakerName,
  DRAMATIS_TRACKS,
  type DramatisExport,
} from './dramatis-loader'

function sampleExport(): DramatisExport {
  return {
    version: 1,
    book: 'monkeys-paw',
    chapter: 'Part I',
    durationSec: 638.82,
    stemGains: { ambience: -16, sfx: -6, music: -20 },
    entities: [
      { id: 'narrator', kind: 'narrator', names: [], visual: null },
      { id: 'mr_white', kind: 'character', names: ['Mr. White', 'the old man'], visual: 'Elderly Englishman by the fire.' },
    ],
    scenes: [
      { id: 'p1-parlor', start: 1, end: 96.87, visual: 'Snug parlour at night', ambience: 'silence' },
    ],
    lines: [
      { id: 'lin_0000', entity: 'narrator', start: 1, dur: 24.86, text: 'Without, the night was cold and wet.', wav: 'D:\\out\\cache\\a.wav' },
      { id: 'lin_0001', entity: 'mr_white', start: 26.31, dur: 3.1, text: 'Hark at the wind.', wav: 'D:\\out\\cache\\b.wav', missing: true },
    ],
    cues: [
      { id: 'p1-fire', sfx: 'fireplace fire crackling', at: 7.82, dur: 18.02, file: 'D:\\out\\cache\\fire.wav', confidence: 0.94, gainDb: -15 },
    ],
    beds: [
      { sceneId: 'p1-parlor', type: 'rain', start: 0, dur: 98.4, file: 'D:\\out\\cache\\rain.wav', source: 'retrieval' },
    ],
    music: [
      { id: 'theme', at: 1, dur: 30, file: 'D:\\out\\cache\\theme.wav', spec: 'sombre strings', license: 'unverified', gainDb: 0 },
    ],
  }
}

describe('dramatis-loader', () => {
  it('places every element type on its own track with true times', () => {
    const loaded = loadDramatisChapter(sampleExport())
    const byTrack = (n: number) => loaded.timeline.clips.filter((c) => c.trackIndex === n)

    expect(byTrack(3)).toHaveLength(2) // dialogue
    expect(byTrack(4)).toHaveLength(1) // sfx
    expect(byTrack(5)).toHaveLength(1) // ambience
    expect(byTrack(6)).toHaveLength(1) // music

    const line0 = byTrack(3)[0]
    expect(line0.startTime).toBe(1)
    expect(line0.duration).toBeCloseTo(24.86)
    expect(line0.type).toBe('audio')
    expect(line0.importedUrl).toBe('file:///D:/out/cache/a.wav')

    const cue = byTrack(4)[0]
    expect(cue.startTime).toBeCloseTo(7.82)
    expect(cue.importedName).toContain('fireplace')
  })

  it('keeps DEFAULT_TRACKS compatibility: audio starts at trackIndex 3', () => {
    expect(DRAMATIS_TRACKS[3].kind).toBe('audio')
    expect(DRAMATIS_TRACKS.slice(0, 3).every((t) => t.kind === 'video')).toBe(true)
    // No clips ever land on the video tracks — that is the motion phase.
    const loaded = loadDramatisChapter(sampleExport())
    expect(loaded.timeline.clips.some((c) => c.trackIndex < 3)).toBe(false)
  })

  it('speaker names come from entity names, else title-cased ids', () => {
    const data = sampleExport()
    expect(speakerName('mr_white', data.entities)).toBe('Mr. White')
    expect(speakerName('narrator', data.entities)).toBe('Narrator')
    expect(speakerName('company_man', data.entities)).toBe('Company Man')
  })

  it('subtitles carry the attributed script, synced to each line', () => {
    const loaded = loadDramatisChapter(sampleExport())
    expect(loaded.timeline.subtitles).toHaveLength(2)
    const sub = loaded.timeline.subtitles![1]
    expect(sub.text).toBe('Mr. White: Hark at the wind.')
    expect(sub.startTime).toBeCloseTo(26.31)
    expect(sub.endTime).toBeCloseTo(29.41)
  })

  it('missing media is placed, labeled, and counted — never dropped', () => {
    const loaded = loadDramatisChapter(sampleExport())
    const missingClip = loaded.timeline.clips.find((c) => c.id === 'dram-line-lin_0001')
    expect(missingClip).toBeDefined()
    expect(missingClip!.importedName).toMatch(/^MISSING — /)
    expect(loaded.report.missingMedia).toBe(1)
  })

  it('stem + cue gains become linear clip volume', () => {
    expect(dbToLinear(0)).toBe(1)
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 3)
    const loaded = loadDramatisChapter(sampleExport())
    const cue = loaded.timeline.clips.find((c) => c.id === 'dram-cue-p1-fire')!
    // cue gain -15 dB + sfx stem -6 dB = -21 dB
    expect(cue.volume).toBeCloseTo(dbToLinear(-21), 4)
    const music = loaded.timeline.clips.find((c) => c.id === 'dram-music-theme')!
    expect(music.volume).toBeCloseTo(dbToLinear(-20), 4)
  })

  it('cast index counts lines per speaker and carries visuals', () => {
    const loaded = loadDramatisChapter(sampleExport())
    const white = loaded.cast.find((c) => c.id === 'mr_white')!
    expect(white.displayName).toBe('Mr. White')
    expect(white.lineCount).toBe(1)
    expect(white.visual).toContain('Elderly')
  })

  // Integration: the REAL export produced by the dramatis pipeline tonight.
  // Skipped on machines without the dramatis checkout — the shape test above
  // is the portable guarantee; this one proves the actual artifact loads.
  const realExport = 'D:/git/dramatis/out/monkeys-paw/ch-01/dd-elements.json'
  it.skipIf(!existsSync(realExport))('loads the real monkeys-paw ch-01 export', () => {
    const data = JSON.parse(readFileSync(realExport, 'utf8')) as DramatisExport
    const loaded = loadDramatisChapter(data)
    expect(loaded.report.lines).toBe(146)
    expect(loaded.report.cues).toBe(4)
    expect(loaded.timeline.clips).toHaveLength(150)
    expect(loaded.timeline.subtitles).toHaveLength(146)
    expect(loaded.durationSeconds).toBeCloseTo(638.82)
    // Five distinct speakers held their attribution through the pipeline.
    const speakers = new Set(loaded.timeline.subtitles!.map((s) => s.text.split(':')[0]))
    expect(speakers.size).toBeGreaterThanOrEqual(5)
  })
})
