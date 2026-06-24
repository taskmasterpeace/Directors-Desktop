/**
 * story-loader.ts — map an AIOBR <slug>.story.json into a Directors Desktop Timeline.
 *
 * The story file is the shared "living medium" (script + audio + beats + stills +
 * videos in one document). This module is the read side: it turns that document
 * into the app's Timeline model so Robert can hear/see/scrub it. The write side
 * (drag a video to a different beat → serialize back) lives in ProjectContext.
 *
 * Pure + framework-free on purpose: no React, no Electron. Give it the parsed
 * story object plus the story file's absolute path (so repo-relative asset paths
 * can be resolved to file:// URLs) and it returns a Timeline + a beat index.
 *
 * Track layout mirrors the canonical exporter (scripts/build_timeline_from_story.js):
 *   V1 (trackIndex 0) = stills, always-on, one per beat over its narration window
 *   V2 (trackIndex 1) = videos, overlay, only where a beat has a placed clip
 *   A1 (trackIndex 3) = the single narration audio clip spanning the whole runtime
 * Beat text rides the subtitles[] array (trackIndex 0) so it shows synced to the playhead.
 */
import {
  Timeline,
  TimelineClip,
  SubtitleClip,
  DEFAULT_TRACKS,
  DEFAULT_COLOR_CORRECTION,
} from '../types/project'

// ── Story file shape (subset we consume; see stories/_schema/story.schema.json) ──
export interface StoryBeat {
  beat_id: string
  chapter: string
  chapter_title?: string
  slot: { start_seconds: number; end_seconds: number }
  text: string
  still: string | null
  video: string | null
  video_conf: 'high' | 'med' | 'low' | 'manual' | null
  alts?: string[]
  notes?: string | null
  /** Canonical character tags on screen in this beat (keys into StoryFile.characters). */
  characters?: string[]
}

/** A first-class chapter: a contiguous run of beats sharing a `chapter` id, with a title-card slot. */
export interface StoryChapter {
  id: string
  index: number
  title: string
  start_seconds: number
  end_seconds: number
  beat_count: number
  key_visual?: string | null
  tonal_register?: string | null
  /** Repo-relative path to the chapter's title-card image, or null if none generated. */
  title_card?: string | null
}

export interface StoryFile {
  slug: string
  title: string
  fps: number
  width: number
  height: number
  audio: string
  timestamps?: string | null
  style?: { style_id?: string | null; style_name?: string | null }
  /** Story cast: canonical character tag -> canonical reference image URL (DP sheet). */
  characters?: Record<string, string>
  total_runtime_seconds: number
  /** First-class chapters in timeline order; each owns a title-card slot. */
  chapters?: StoryChapter[]
  beats: StoryBeat[]
}

// One row in the beat strip overlay (chapter/beat boundaries + state).
export interface BeatInfo {
  beatId: string
  chapter: string
  chapterTitle: string
  startSeconds: number
  endSeconds: number
  text: string
  hasStill: boolean
  hasVideo: boolean
  videoConf: StoryBeat['video_conf']
  altCount: number
  notes: string | null
  /** Cast on screen in this beat: canonical tag + resolved ref URL (url null if not in cast map). */
  characters: { tag: string; ref: string | null }[]
}

export interface LoadedStory {
  timeline: Timeline
  beats: BeatInfo[]
  /** Absolute path of the story file this was loaded from (for write-back). */
  storyPath: string
  /** The aiobr repo root derived from the story path. */
  repoRoot: string
  durationSeconds: number
  /** Story cast: canonical character tag -> canonical reference image URL. */
  characters: Record<string, string>
}

// ── Repo root: the story file always lives at <repoRoot>/stories/<slug>/<slug>.story.json ──
export function repoRootFromStoryPath(storyAbsPath: string): string {
  const norm = storyAbsPath.replace(/\\/g, '/')
  const idx = norm.toLowerCase().lastIndexOf('/stories/')
  if (idx >= 0) return norm.slice(0, idx)
  // Fallback: two directories up from the file.
  return norm.split('/').slice(0, -3).join('/')
}

// Mirror ProjectContext.pathToFileUrl so loaded media resolves the same way.
function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p
}

// Shared clip defaults so every emitted clip is a valid TimelineClip.
function baseClip(overrides: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'type' | 'startTime' | 'duration' | 'trackIndex'>): TimelineClip {
  return {
    assetId: null,
    trimStart: 0,
    trimEnd: 0,
    speed: 1,
    reversed: false,
    muted: false,
    volume: 1,
    asset: null,
    flipH: false,
    flipV: false,
    transitionIn: { type: 'none', duration: 0.5 },
    transitionOut: { type: 'none', duration: 0.5 },
    colorCorrection: { ...DEFAULT_COLOR_CORRECTION },
    opacity: 100,
    ...overrides,
  }
}

/**
 * Build a Timeline (+ beat index) from a parsed story file.
 * @param story        parsed <slug>.story.json
 * @param storyAbsPath absolute path of that file on disk (for asset resolution + write-back)
 */
export function loadStoryToTimeline(story: StoryFile, storyAbsPath: string): LoadedStory {
  const repoRoot = repoRootFromStoryPath(storyAbsPath)
  const abs = (rel: string) => pathToFileUrl(`${repoRoot}/${rel.replace(/^\/+/, '')}`)

  const cast = story.characters ?? {}
  const beats = [...story.beats].sort((a, b) => a.slot.start_seconds - b.slot.start_seconds)
  const clips: TimelineClip[] = []
  const subtitles: SubtitleClip[] = []
  const beatInfos: BeatInfo[] = []

  for (const b of beats) {
    const start = b.slot.start_seconds
    const end = b.slot.end_seconds
    const dur = Math.max(0.04, end - start) // never zero-length; min ~1 frame @24fps

    // V1 still (always-on under the window)
    if (b.still) {
      clips.push(
        baseClip({
          id: `v1-${b.beat_id}`,
          type: 'image',
          startTime: start,
          duration: dur,
          trackIndex: 0,
          importedUrl: abs(b.still),
          importedName: b.beat_id,
        })
      )
    }

    // V2 video overlay (preview duration = window; the exporter probes real frames
    // and caps to the window, so app preview length matches export intent).
    if (b.video) {
      clips.push(
        baseClip({
          id: `v2-${b.beat_id}`,
          type: 'video',
          startTime: start,
          duration: dur,
          trackIndex: 1,
          importedUrl: abs(b.video),
          importedName: basename(b.video),
        })
      )
    }

    // Beat text → subtitle cue on the V1 subtitle lane
    if (b.text) {
      subtitles.push({
        id: `sub-${b.beat_id}`,
        text: b.text,
        startTime: start,
        endTime: end,
        trackIndex: 0,
      })
    }

    beatInfos.push({
      beatId: b.beat_id,
      chapter: b.chapter,
      chapterTitle: b.chapter_title || b.chapter,
      startSeconds: start,
      endSeconds: end,
      text: b.text || '',
      hasStill: !!b.still,
      hasVideo: !!b.video,
      videoConf: b.video_conf ?? null,
      altCount: b.alts?.length ?? 0,
      notes: b.notes ?? null,
      // Resolve each on-screen tag to its canonical ref URL (null if absent from the cast map).
      characters: (b.characters ?? []).map((tag) => ({ tag, ref: cast[tag] ?? null })),
    })
  }

  // A1 narration — one clip spanning the full runtime
  const runtime = story.total_runtime_seconds || (beats.length ? beats[beats.length - 1].slot.end_seconds : 0)
  if (story.audio) {
    clips.push(
      baseClip({
        id: 'a1-narration',
        type: 'audio',
        startTime: 0,
        duration: runtime,
        trackIndex: 3,
        importedUrl: abs(story.audio),
        importedName: basename(story.audio),
      })
    )
  }

  const timeline: Timeline = {
    id: `story-${story.slug}`,
    name: story.title || story.slug,
    createdAt: Date.now(),
    tracks: DEFAULT_TRACKS.map((t) => ({ ...t })),
    clips,
    subtitles,
  }

  return { timeline, beats: beatInfos, storyPath: storyAbsPath, repoRoot, durationSeconds: runtime, characters: cast }
}
