/**
 * dramatis-loader.ts — map a dramatis dd-elements.json chapter export onto a
 * Directors Desktop Timeline as SEPARATE ELEMENTS, never a mixdown.
 *
 * dd-elements.json is emitted by dramatis's own mix stage (the same code that
 * placed the audio), so times here are the single timing authority: every
 * attributed dialogue line, SFX cue, ambience bed and music placement with an
 * absolute media path.
 *
 * Track layout keeps DEFAULT_TRACKS' shape (3 video + audio from index 3) so
 * nothing that assumes "audio starts at trackIndex 3" is surprised:
 *   V1/V2/V3 (0-2)  = empty — the motion phase (scene stills / H3 video) lands here
 *   A1 Dialogue (3) = one clip per attributed line, at its true start
 *   A2 SFX (4)      = one clip per placed cue (word-onset time, cue gain)
 *   A3 Ambience (5) = scene beds
 *   A4 Music (6)    = score cues
 * Every line also becomes a subtitle ("Speaker: text") synced to the playhead,
 * so the editor doubles as a read-along script view.
 *
 * Pure + framework-free like story-loader: parsed export in, Timeline out.
 */
import {
  Timeline,
  TimelineClip,
  SubtitleClip,
  Track,
} from '../types/project'
import { baseClip } from './story-loader'

// ── dd-elements.json shape (mirrors backend server_utils/dramatis_bridge.py) ──
export interface DramatisEntity {
  id: string
  kind: string
  names: string[]
  visual: string | null
}

export interface DramatisScene {
  id: string
  start: number
  end: number
  visual: string | null
  ambience: string
}

export interface DramatisLine {
  id: string
  entity: string
  start: number
  dur: number
  text: string
  wav: string
  missing?: boolean
}

export interface DramatisCue {
  id: string
  sfx: string
  at: number
  dur: number
  file: string
  confidence: number | null
  gainDb: number
  missing?: boolean
}

export interface DramatisBed {
  sceneId: string
  type: string
  start: number
  dur: number
  file: string
  source: string
  missing?: boolean
}

export interface DramatisMusic {
  id: string
  at: number
  dur: number
  file: string
  spec: string
  license: string | null
  gainDb: number
  missing?: boolean
}

export interface DramatisExport {
  version: number
  book: string
  chapter: string
  durationSec: number
  stemGains: { ambience: number; sfx: number; music: number }
  entities: DramatisEntity[]
  scenes: DramatisScene[]
  lines: DramatisLine[]
  cues: DramatisCue[]
  beds: DramatisBed[]
  music: DramatisMusic[]
  media?: { total: number; missing: number }
  stale?: boolean
}

export interface DramatisCastMember {
  id: string
  kind: string
  displayName: string
  visual: string | null
  lineCount: number
}

export interface LoadedDramatisChapter {
  timeline: Timeline
  cast: DramatisCastMember[]
  scenes: DramatisScene[]
  durationSeconds: number
  report: {
    lines: number
    cues: number
    beds: number
    music: number
    missingMedia: number
  }
}

// DEFAULT_TRACKS-compatible: video 0-2, audio from 3 — plus the extra stems.
export const DRAMATIS_TRACKS: Track[] = [
  { id: 'track-v1', name: 'V1', muted: false, locked: false, sourcePatched: true, kind: 'video' },
  { id: 'track-v2', name: 'V2', muted: false, locked: false, sourcePatched: false, kind: 'video' },
  { id: 'track-v3', name: 'V3', muted: false, locked: false, sourcePatched: false, kind: 'video' },
  { id: 'track-a1', name: 'A1 Dialogue', muted: false, locked: false, sourcePatched: true, kind: 'audio' },
  { id: 'track-a2', name: 'A2 SFX', muted: false, locked: false, sourcePatched: false, kind: 'audio' },
  { id: 'track-a3', name: 'A3 Ambience', muted: false, locked: false, sourcePatched: false, kind: 'audio' },
  { id: 'track-a4', name: 'A4 Music', muted: false, locked: false, sourcePatched: false, kind: 'audio' },
]

const TRACK_DIALOGUE = 3
const TRACK_SFX = 4
const TRACK_AMBIENCE = 5
const TRACK_MUSIC = 6

function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

/** dramatis gains are dB; TimelineClip.volume is a linear multiplier. */
export function dbToLinear(db: number): number {
  const v = Math.pow(10, db / 20)
  return Math.min(2, Math.max(0, +v.toFixed(4)))
}

/** "mr_white" -> "Mr. White" via the entity's own names, else title-cased id. */
export function speakerName(entity: string, entities: DramatisEntity[]): string {
  const e = entities.find((x) => x.id === entity)
  if (e && e.names.length > 0) return e.names[0]
  return entity
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

function snippet(text: string, max = 42): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/**
 * Build a Timeline from a chapter export. Missing media (flagged by the
 * backend's existence check) still gets a clip — placed, named, and counted in
 * the report — so the timeline SHAPE survives a pruned cache and the user sees
 * exactly what a re-render would restore.
 */
export function loadDramatisChapter(data: DramatisExport): LoadedDramatisChapter {
  const clips: TimelineClip[] = []
  const subtitles: SubtitleClip[] = []
  let missingMedia = 0

  const flag = (missing: boolean | undefined, name: string): string => {
    if (!missing) return name
    missingMedia += 1
    return `MISSING — ${name}`
  }

  for (const line of data.lines) {
    const who = speakerName(line.entity, data.entities)
    clips.push(baseClip({
      id: `dram-line-${line.id}`,
      type: 'audio',
      startTime: line.start,
      duration: Math.max(0.04, line.dur),
      trackIndex: TRACK_DIALOGUE,
      importedUrl: pathToFileUrl(line.wav),
      importedName: flag(line.missing, `${who}: ${snippet(line.text)}`),
    }))
    subtitles.push({
      id: `dram-sub-${line.id}`,
      text: `${who}: ${line.text}`,
      startTime: line.start,
      endTime: line.start + Math.max(0.04, line.dur),
      trackIndex: 0,
    })
  }

  for (const cue of data.cues) {
    clips.push(baseClip({
      id: `dram-cue-${cue.id}`,
      type: 'audio',
      startTime: cue.at,
      duration: Math.max(0.04, cue.dur),
      trackIndex: TRACK_SFX,
      volume: dbToLinear(cue.gainDb + data.stemGains.sfx),
      importedUrl: pathToFileUrl(cue.file),
      importedName: flag(cue.missing, `SFX: ${cue.sfx}`),
    }))
  }

  for (const bed of data.beds) {
    clips.push(baseClip({
      id: `dram-bed-${bed.sceneId}`,
      type: 'audio',
      startTime: bed.start,
      duration: Math.max(0.04, bed.dur),
      trackIndex: TRACK_AMBIENCE,
      volume: dbToLinear(data.stemGains.ambience),
      importedUrl: pathToFileUrl(bed.file),
      importedName: flag(bed.missing, `Ambience: ${bed.type} (${bed.sceneId})`),
    }))
  }

  for (const mc of data.music) {
    clips.push(baseClip({
      id: `dram-music-${mc.id}`,
      type: 'audio',
      startTime: mc.at,
      duration: Math.max(0.04, mc.dur),
      trackIndex: TRACK_MUSIC,
      volume: dbToLinear(mc.gainDb + data.stemGains.music),
      importedUrl: pathToFileUrl(mc.file),
      importedName: flag(mc.missing, `Score: ${snippet(mc.spec, 36)}`),
    }))
  }

  const lineCounts = new Map<string, number>()
  for (const line of data.lines) {
    lineCounts.set(line.entity, (lineCounts.get(line.entity) ?? 0) + 1)
  }
  const cast: DramatisCastMember[] = data.entities.map((e) => ({
    id: e.id,
    kind: e.kind,
    displayName: speakerName(e.id, data.entities),
    visual: e.visual,
    lineCount: lineCounts.get(e.id) ?? 0,
  }))

  const timeline: Timeline = {
    id: `timeline-dramatis-${data.book}-${Date.now()}`,
    name: data.chapter,
    createdAt: Date.now(),
    tracks: DRAMATIS_TRACKS.map((t) => ({ ...t })),
    clips,
    subtitles,
  }

  return {
    timeline,
    cast,
    scenes: data.scenes,
    durationSeconds: data.durationSec,
    report: {
      lines: data.lines.length,
      cues: data.cues.length,
      beds: data.beds.length,
      music: data.music.length,
      missingMedia,
    },
  }
}
