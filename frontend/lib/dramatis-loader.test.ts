import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  loadDramatisChapter,
  dbToLinear,
  speakerName,
  DRAMATIS_VIDEO_TRACKS,
  MAX_SPEAKER_LANES,
  NON_DIALOG_LIFT_DB,
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
  it('gives the narrator and each character their own lane, stems after', () => {
    const loaded = loadDramatisChapter(sampleExport())
    const byTrack = (n: number) => loaded.timeline.clips.filter((c) => c.trackIndex === n)

    // narrator=3, mr_white=4, then SFX=5 / Ambience=6 / Music=7
    expect(byTrack(3)).toHaveLength(1) // narrator line
    expect(byTrack(4)).toHaveLength(1) // mr_white line
    expect(byTrack(5)).toHaveLength(1) // sfx
    expect(byTrack(6)).toHaveLength(1) // ambience
    expect(byTrack(7)).toHaveLength(1) // music

    const tracks = loaded.timeline.tracks
    expect(tracks[3].name).toBe('A1 Narrator')
    expect(tracks[4].name).toBe('A2 Mr. White')
    expect(tracks[5].name).toContain('SFX')
    expect(tracks[6].name).toContain('Ambience')
    expect(tracks[7].name).toContain('Music')

    const line0 = byTrack(3)[0]
    expect(line0.startTime).toBe(1)
    expect(line0.duration).toBeCloseTo(24.86)
    expect(line0.type).toBe('audio')
    expect(line0.importedUrl).toBe('file:///D:/out/cache/a.wav')

    const cue = byTrack(5)[0]
    expect(cue.startTime).toBeCloseTo(7.82)
    expect(cue.importedName).toContain('fireplace')
  })

  it('keeps DEFAULT_TRACKS compatibility: video 0-2, audio from 3', () => {
    expect(DRAMATIS_VIDEO_TRACKS).toHaveLength(3)
    expect(DRAMATIS_VIDEO_TRACKS.every((t) => t.kind === 'video')).toBe(true)
    // No clips ever land on the video tracks — that is the motion phase.
    const loaded = loadDramatisChapter(sampleExport())
    expect(loaded.timeline.clips.some((c) => c.trackIndex < 3)).toBe(false)
    expect(loaded.timeline.tracks.slice(3).every((t) => t.kind === 'audio')).toBe(true)
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

  it('stem + cue gains land LIFTED — the raw mix offsets buried every cue', () => {
    expect(dbToLinear(0)).toBe(1)
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 3)
    const loaded = loadDramatisChapter(sampleExport())
    const cue = loaded.timeline.clips.find((c) => c.id === 'dram-cue-p1-fire')!
    // cue gain -15 + sfx stem -6 + calibration lift (DD has no duck/makeup)
    expect(cue.volume).toBeCloseTo(dbToLinear(-21 + NON_DIALOG_LIFT_DB), 4)
    const music = loaded.timeline.clips.find((c) => c.id === 'dram-music-theme')!
    expect(music.volume).toBeCloseTo(dbToLinear(-20 + NON_DIALOG_LIFT_DB), 4)
    const bed = loaded.timeline.clips.find((c) => c.id === 'dram-bed-p1-parlor')!
    expect(bed.volume).toBeCloseTo(dbToLinear(-16 + NON_DIALOG_LIFT_DB), 4)
  })

  it('cast index counts lines per speaker and carries visuals', () => {
    const loaded = loadDramatisChapter(sampleExport())
    const white = loaded.cast.find((c) => c.id === 'mr_white')!
    expect(white.displayName).toBe('Mr. White')
    expect(white.lineCount).toBe(1)
    expect(white.visual).toContain('Elderly')
  })

  it('every element becomes a real Asset the clip references — takes need assets', () => {
    const loaded = loadDramatisChapter({ ...sampleExport(), chapterNumber: 2, configHash: 'cfg-1' })
    expect(loaded.assets).toHaveLength(5) // 2 lines + cue + bed + music
    for (const clip of loaded.timeline.clips) {
      expect(clip.assetId, `clip ${clip.id} must reference an asset`).toBeTruthy()
      const asset = loaded.assets.find((a) => a.id === clip.assetId)!
      expect(asset.type).toBe('audio')
      expect(clip.asset).toBe(asset)
    }
    const line = loaded.assets.find((a) => a.id === 'dram-asset-lin_0001')!
    expect(line.origin).toMatchObject({
      app: 'dramatis',
      bookId: 'monkeys-paw',
      chapterNumber: 2,
      configHash: 'cfg-1',
      elementKind: 'line',
      lineId: 'lin_0001',
      entity: 'mr_white',
      text: 'Hark at the wind.',
    })
    // v1 export: no gen block — origin still identifies the line, engine absent
    expect(line.origin!.engine).toBeUndefined()
    const cue = loaded.assets.find((a) => a.id === 'dram-asset-cue-p1-fire')!
    expect(cue.origin!.elementKind).toBe('cue')
  })

  it('a thirty-member cast collapses into capped lanes + one shared Cast lane', () => {
    const data = sampleExport()
    data.lines = []
    for (let i = 0; i < 30; i++) {
      // speaker i speaks i+1 lines: spk29 is the lead, spk0 barely speaks
      for (let j = 0; j <= i; j++) {
        data.lines.push({
          id: `lin_${i}_${j}`, entity: `spk${i}`, start: i * 40 + j, dur: 1,
          text: `line ${j}`, wav: `D:\\out\\c\\${i}-${j}.wav`,
        })
      }
    }
    const loaded = loadDramatisChapter(data)
    const audioTracks = loaded.timeline.tracks.filter((t) => t.kind === 'audio')
    // capped lanes + Cast + SFX/Ambience/Music — NOT 33 audio tracks
    expect(audioTracks).toHaveLength(MAX_SPEAKER_LANES + 1 + 3)
    const cast = loaded.timeline.tracks.find((t) => t.id === 'track-a-cast')!
    expect(cast.name).toContain(`${30 - MAX_SPEAKER_LANES} more`)
    // the lead speaker holds a lane; the quietest lands on the shared lane
    const castIndex = loaded.timeline.tracks.indexOf(cast)
    const lead = loaded.timeline.clips.find((c) => c.id === 'dram-line-lin_29_0')!
    const quiet = loaded.timeline.clips.find((c) => c.id === 'dram-line-lin_0_0')!
    expect(lead.trackIndex).toBeLessThan(castIndex)
    expect(quiet.trackIndex).toBe(castIndex)
  })

  it('chapter + scenes land as range markers the ruler and the TOC can read', () => {
    const loaded = loadDramatisChapter({ ...sampleExport(), chapterNumber: 2 })
    const markers = loaded.timeline.markers!
    const chapter = markers.find((m) => m.id === 'dram-chapter-2')!
    expect(chapter.title).toBe('Chapter 2 — Part I')
    expect(chapter.time).toBe(0)
    expect(chapter.duration).toBeCloseTo(638.82)
    const scene = markers.find((m) => m.id === 'dram-scene-p1-parlor')!
    expect(scene.title).toContain('Snug parlour')
    expect(scene.time).toBe(1)
  })

  it('a v2 manifest threads the generation record into origin', () => {
    const data = { ...sampleExport(), version: 2, chapterNumber: 1, configHash: 'h' }
    data.lines[0] = {
      ...data.lines[0],
      kind: 'narration',
      sceneId: 'p1-parlor',
      gen: { engine: 'kokoro', engineTag: 'kokoro-onnx@2', voiceKey: 'am_michael', key: 'k123', direction: null, rawWav: 'D:\\out\\cache\\a-raw.wav' },
    }
    const loaded = loadDramatisChapter(data)
    const asset = loaded.assets.find((a) => a.id === 'dram-asset-lin_0000')!
    expect(asset.origin).toMatchObject({ engine: 'kokoro', voiceKey: 'am_michael', cacheKey: 'k123', sceneId: 'p1-parlor' })
  })

  // Integration: the REAL export produced by the dramatis pipeline (v2
  // manifest). Skipped on machines without the dramatis checkout — the shape
  // tests above are the portable guarantee; this one proves the artifact loads.
  const realExport = 'D:/git/dramatis/out/monkeys-paw/ch-01/dd-elements.json'
  it.skipIf(!existsSync(realExport))('loads the real monkeys-paw ch-01 export', () => {
    const data = JSON.parse(readFileSync(realExport, 'utf8')) as DramatisExport
    const loaded = loadDramatisChapter(data)
    expect(loaded.report.lines).toBe(146)
    expect(loaded.report.cues).toBeGreaterThanOrEqual(1)
    expect(loaded.timeline.clips.length).toBeGreaterThanOrEqual(148)
    expect(loaded.timeline.subtitles).toHaveLength(146)
    // durations shift when performances re-render — same ballpark, not byte-equal
    expect(loaded.durationSeconds).toBeGreaterThan(500)
    // Five distinct speakers held their attribution through the pipeline.
    const speakers = new Set(loaded.timeline.subtitles!.map((s) => s.text.split(':')[0]))
    expect(speakers.size).toBeGreaterThanOrEqual(5)
    // v2: every line asset knows its engine and cache key
    const lineAssets = loaded.assets.filter((a) => a.origin?.elementKind === 'line')
    expect(lineAssets.length).toBe(146)
    expect(lineAssets.every((a) => a.origin!.engine && a.origin!.cacheKey)).toBe(true)
  })
})
