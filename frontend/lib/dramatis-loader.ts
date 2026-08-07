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
  Asset,
  AssetOrigin,
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

/** Generation record a v2 manifest carries per line (null on v1 exports). */
export interface DramatisGen {
  engine: string
  engineTag: string
  voiceKey: string
  key: string
  direction: string | null
  rawWav: string
}

export interface DramatisLine {
  id: string
  entity: string
  start: number
  dur: number
  text: string
  wav: string
  missing?: boolean
  // v2 manifest fields — absent on v1 exports, every consumer tolerates that
  kind?: string | null
  sceneId?: string | null
  cite?: [number, number] | null
  emotion?: Record<string, number> | null
  gen?: DramatisGen | null
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
  // v2 manifest header (+ chapterNumber injected by the DD backend — the
  // 1-based ordinal the takes API addresses; `chapter` is the TITLE)
  sourceApp?: string
  generatedAt?: string
  bookTitle?: string | null
  configHash?: string | null
  chapterNumber?: number
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
  /** Real Assets, one per placed element — clips reference them by id, so the
   *  whole takes machinery (stepper, addTakeToAsset, regen) works on imported
   *  dramatis audio exactly like on generated video. */
  assets: Asset[]
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

// DEFAULT_TRACKS-compatible: video 0-2, audio from 3. Audio tracks are built
// PER PRODUCTION: narrator first, then one lane per speaking character (order
// of first line), then SFX / Ambience / Music. Robert's first real edit
// session (2026-08-06): everything on one dialogue lane reads like a haystack;
// per-character lanes read like a script.
export const DRAMATIS_VIDEO_TRACKS: Track[] = [
  { id: 'track-v1', name: 'V1', muted: false, locked: false, sourcePatched: true, kind: 'video' },
  { id: 'track-v2', name: 'V2', muted: false, locked: false, sourcePatched: false, kind: 'video' },
  { id: 'track-v3', name: 'V3', muted: false, locked: false, sourcePatched: false, kind: 'video' },
]

/** Calibration from the first human listen (2026-08-06, Robert): the manifest's
 *  stemGains model dramatis's OWN mix — where stems are ducked under dialog and
 *  the master adds makeup gain. The DD timeline performs neither, so applying
 *  those offsets raw buried every cue ("the knocking… too low. I don't hear
 *  anything"). This lift re-anchors non-dialog stems to be plainly audible
 *  against the −20 LUFS levelled dialogue; clips stay user-trimmable. */
export const NON_DIALOG_LIFT_DB = 9

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
  const assets: Asset[] = []
  let missingMedia = 0

  // One audio lane per speaker, narrator first, others in order of first line.
  const seen = new Set<string>()
  const speakers: string[] = []
  for (const l of data.lines) {
    if (!seen.has(l.entity)) { seen.add(l.entity); speakers.push(l.entity) }
  }
  speakers.sort((a, b) => (a === 'narrator' ? -1 : b === 'narrator' ? 1 : 0))
  const trackForSpeaker = new Map<string, number>()
  speakers.forEach((s, i) => trackForSpeaker.set(s, DRAMATIS_VIDEO_TRACKS.length + i))
  const TRACK_SFX = DRAMATIS_VIDEO_TRACKS.length + speakers.length
  const TRACK_AMBIENCE = TRACK_SFX + 1
  const TRACK_MUSIC = TRACK_SFX + 2
  const tracks: Track[] = [
    ...DRAMATIS_VIDEO_TRACKS.map((t) => ({ ...t })),
    ...speakers.map((s, i) => ({
      id: `track-a-${s}`,
      name: `A${i + 1} ${speakerName(s, data.entities)}`,
      muted: false, locked: false, sourcePatched: i === 0, kind: 'audio' as const,
    })),
    { id: 'track-a-sfx', name: `A${speakers.length + 1} SFX`, muted: false, locked: false, sourcePatched: false, kind: 'audio' as const },
    { id: 'track-a-ambience', name: `A${speakers.length + 2} Ambience`, muted: false, locked: false, sourcePatched: false, kind: 'audio' as const },
    { id: 'track-a-music', name: `A${speakers.length + 3} Music`, muted: false, locked: false, sourcePatched: false, kind: 'audio' as const },
  ]

  const flag = (missing: boolean | undefined, name: string): string => {
    if (!missing) return name
    missingMedia += 1
    return `MISSING — ${name}`
  }

  // Every element becomes a REAL Asset the clip references: takes, the take
  // stepper and surgical regeneration all live on assets, and provenance
  // (origin) is what lets DD say "Scene 14, Maya's third line, qwen3" instead
  // of audio_48392.wav. importedUrl stays as the media fallback.
  const makeAsset = (id: string, filePath: string, prompt: string, dur: number, origin: AssetOrigin): Asset => {
    const asset: Asset = {
      id,
      type: 'audio',
      path: filePath,
      url: pathToFileUrl(filePath),
      prompt,
      resolution: '',
      duration: dur,
      createdAt: Date.now(),
      origin,
    }
    assets.push(asset)
    return asset
  }
  const common = {
    app: 'dramatis' as const,
    bookId: data.book,
    chapterNumber: data.chapterNumber,
    configHash: data.configHash ?? undefined,
  }

  for (const line of data.lines) {
    const who = speakerName(line.entity, data.entities)
    const dur = Math.max(0.04, line.dur)
    const asset = makeAsset(`dram-asset-${line.id}`, line.wav, line.text, dur, {
      ...common,
      elementKind: 'line',
      lineId: line.id,
      entity: line.entity,
      sceneId: line.sceneId ?? undefined,
      text: line.text,
      engine: line.gen?.engine,
      voiceKey: line.gen?.voiceKey,
      cacheKey: line.gen?.key,
    })
    clips.push({
      ...baseClip({
        id: `dram-line-${line.id}`,
        type: 'audio',
        startTime: line.start,
        duration: dur,
        trackIndex: trackForSpeaker.get(line.entity) ?? DRAMATIS_VIDEO_TRACKS.length,
        importedUrl: pathToFileUrl(line.wav),
        importedName: flag(line.missing, `${who}: ${snippet(line.text)}`),
      }),
      assetId: asset.id,
      asset,
    })
    subtitles.push({
      id: `dram-sub-${line.id}`,
      text: `${who}: ${line.text}`,
      startTime: line.start,
      endTime: line.start + dur,
      trackIndex: 0,
    })
  }

  for (const cue of data.cues) {
    const dur = Math.max(0.04, cue.dur)
    const asset = makeAsset(`dram-asset-cue-${cue.id}`, cue.file, `SFX: ${cue.sfx}`, dur,
      { ...common, elementKind: 'cue', text: cue.sfx })
    clips.push({
      ...baseClip({
        id: `dram-cue-${cue.id}`,
        type: 'audio',
        startTime: cue.at,
        duration: dur,
        trackIndex: TRACK_SFX,
        volume: dbToLinear(cue.gainDb + data.stemGains.sfx + NON_DIALOG_LIFT_DB),
        importedUrl: pathToFileUrl(cue.file),
        importedName: flag(cue.missing, `SFX: ${cue.sfx}`),
      }),
      assetId: asset.id,
      asset,
    })
  }

  for (const bed of data.beds) {
    const dur = Math.max(0.04, bed.dur)
    const asset = makeAsset(`dram-asset-bed-${bed.sceneId}`, bed.file, `Ambience: ${bed.type}`, dur,
      { ...common, elementKind: 'bed', sceneId: bed.sceneId, text: bed.type })
    clips.push({
      ...baseClip({
        id: `dram-bed-${bed.sceneId}`,
        type: 'audio',
        startTime: bed.start,
        duration: dur,
        trackIndex: TRACK_AMBIENCE,
        volume: dbToLinear(data.stemGains.ambience + NON_DIALOG_LIFT_DB),
        importedUrl: pathToFileUrl(bed.file),
        importedName: flag(bed.missing, `Ambience: ${bed.type} (${bed.sceneId})`),
      }),
      assetId: asset.id,
      asset,
    })
  }

  for (const mc of data.music) {
    const dur = Math.max(0.04, mc.dur)
    const asset = makeAsset(`dram-asset-music-${mc.id}`, mc.file, `Score: ${mc.spec}`, dur,
      { ...common, elementKind: 'music', text: mc.spec })
    clips.push({
      ...baseClip({
        id: `dram-music-${mc.id}`,
        type: 'audio',
        startTime: mc.at,
        duration: dur,
        trackIndex: TRACK_MUSIC,
        volume: dbToLinear(mc.gainDb + data.stemGains.music + NON_DIALOG_LIFT_DB),
        importedUrl: pathToFileUrl(mc.file),
        importedName: flag(mc.missing, `Score: ${snippet(mc.spec, 36)}`),
      }),
      assetId: asset.id,
      asset,
    })
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
    tracks,
    clips,
    subtitles,
  }

  return {
    timeline,
    assets,
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
