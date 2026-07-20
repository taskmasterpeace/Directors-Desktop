/**
 * Director run → editable timeline.
 *
 * A finished (or even partial) Director build is already a cut: every shot has
 * its beat-snapped window and rendered clip, the song is the soundtrack, and
 * the analysis sections describe the structure. This maps that run onto the
 * editor's native timeline — shots as V1 clips at their planned positions,
 * the song on A1, sections as range markers — so the "output" is not a
 * flattened mp4 but a real, re-editable project.
 */

import { baseClip } from './story-loader'
import { DEFAULT_TRACKS, type MarkerColor, type Timeline, type TimelineClip, type TimelineMarker } from '../types/project'

export interface DirectorRunForImport {
  id: string
  concept: string
  audioPath: string
  songSeconds: number | null
  sections: { start: number; end: number; label: string }[] | null
  shots: {
    index: number
    start: number
    end: number
    sectionLabel: string
    shotType: string
    prompt: string
    resultPath: string | null
  }[]
}

const SECTION_COLOR: Record<string, MarkerColor> = {
  intro: 'zinc',
  verse: 'blue',
  chorus: 'amber',
  bridge: 'green',
  outro: 'zinc',
}

function pathToFileUrl(filePath: string): string {
  if (/^(file|https?|data|blob):/i.test(filePath)) return filePath
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

export function directorRunToTimeline(run: DirectorRunForImport): Timeline {
  const clips: TimelineClip[] = []

  // V1: each rendered shot at its planned beat-snapped position, trimmed to
  // the exact cut length (the generated file is always >= the window).
  for (const shot of run.shots) {
    if (!shot.resultPath) continue
    clips.push(
      baseClip({
        id: `dshot-${run.id}-${shot.index}`,
        type: 'video',
        startTime: shot.start,
        duration: Math.max(0.04, shot.end - shot.start),
        trackIndex: 0,
        muted: true, // the song is the soundtrack; generated clips stay silent
        importedUrl: pathToFileUrl(shot.resultPath),
        importedName: `Shot ${shot.index + 1} · ${shot.sectionLabel}`,
      })
    )
  }

  // A1: the song, one clip spanning the full runtime.
  const runtime =
    run.songSeconds ?? (run.shots.length ? run.shots[run.shots.length - 1].end : 0)
  if (run.audioPath && runtime > 0) {
    clips.push(
      baseClip({
        id: `dsong-${run.id}`,
        type: 'audio',
        startTime: 0,
        duration: runtime,
        trackIndex: 3,
        importedUrl: pathToFileUrl(run.audioPath),
        importedName: basename(run.audioPath),
      })
    )
  }

  // Sections become range markers so the structure reads on the ruler.
  const markers: TimelineMarker[] = (run.sections ?? []).map((section, i) => ({
    id: `dsec-${run.id}-${i}`,
    time: section.start,
    duration: Math.max(0, section.end - section.start) || undefined,
    title: section.label,
    color: SECTION_COLOR[section.label] ?? 'zinc',
    author: 'agent' as const,
    createdAt: Date.now(),
  }))

  return {
    id: `director-${run.id}`,
    name: run.concept.slice(0, 40) || 'Director cut',
    createdAt: Date.now(),
    tracks: DEFAULT_TRACKS.map((t) => ({ ...t })),
    clips,
    subtitles: [],
    markers,
  }
}
