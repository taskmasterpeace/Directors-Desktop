/**
 * Smoke suite for the vendored OpenReel core (see ../PROVENANCE.md).
 *
 * This does NOT re-test OpenReel's engines (their own suite does that upstream).
 * It proves the vendoring actually works inside Directors Desktop's harness:
 * the `@openreel/core` Vite alias resolves, runtime dependencies (immer, uuid, …)
 * are installed, and the action-based editing loop — execute → undo → redo —
 * behaves on real engine objects. If this file fails, the vendor integration
 * broke, not the engines.
 */
import { describe, it, expect } from 'vitest'
import { ClipManager } from '@openreel/core/timeline'
import { ActionExecutor, ActionHistory } from '@openreel/core/actions'
import type { Timeline, Track, Project } from '@openreel/core/types'

function makeTrack(overrides?: Partial<Track>): Track {
  return {
    id: 'track-1',
    type: 'video',
    name: 'Video 1',
    clips: [],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    ...overrides,
  }
}

function makeTimeline(overrides?: Partial<Timeline>): Timeline {
  return {
    tracks: [makeTrack()],
    subtitles: [],
    duration: 0,
    markers: [],
    ...overrides,
  }
}

function makeProject(timeline: Timeline): Project {
  return {
    id: 'proj-1',
    name: 'Smoke Project',
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    // The action validator requires referenced media to exist in the library.
    mediaLibrary: {
      items: [
        {
          id: 'media-1',
          name: 'clip.mp4',
          type: 'video',
          fileHandle: null,
          blob: null,
          metadata: {
            duration: 5,
            width: 1920,
            height: 1080,
            frameRate: 30,
            codec: 'h264',
            sampleRate: 48000,
            channels: 2,
            fileSize: 1024,
          },
          thumbnailUrl: null,
          waveformData: null,
        },
      ],
    },
    timeline,
  }
}

describe('vendored @openreel/core: alias + engines resolve', () => {
  it('ClipManager adds and moves clips on a timeline', async () => {
    const cm = new ClipManager({ snapToGridEnabled: false })
    const timeline = makeTimeline()

    const added = await cm.addClip(timeline, {
      trackId: 'track-1',
      mediaId: 'media-1',
      startTime: 2,
      duration: 5,
    })
    expect(added.success).toBe(true)
    expect(timeline.tracks[0].clips).toHaveLength(1)
    expect(timeline.tracks[0].clips[0].startTime).toBe(2)

    const clipId = timeline.tracks[0].clips[0].id
    const moved = await cm.moveClip(timeline, { clipId, startTime: 10 })
    expect(moved.success).toBe(true)
    expect(timeline.tracks[0].clips[0].startTime).toBe(10)
  })

  it('rejects operations on a locked track', async () => {
    const cm = new ClipManager({ snapToGridEnabled: false })
    const timeline = makeTimeline({ tracks: [makeTrack({ locked: true })] })
    const result = await cm.addClip(timeline, {
      trackId: 'track-1',
      mediaId: 'media-1',
      startTime: 0,
    })
    expect(result.success).toBe(false)
  })
})

describe('vendored @openreel/core: action loop (execute → undo → redo)', () => {
  it('undoes and redoes a clip/add through the shared history', async () => {
    const history = new ActionHistory()
    const executor = new ActionExecutor(history)
    const timeline = makeTimeline()
    const project = makeProject(timeline)

    const result = await executor.execute(
      { type: 'clip/add', params: { trackId: 'track-1', mediaId: 'media-1', startTime: 0 } },
      project,
    )
    expect(result.success).toBe(true)
    expect(timeline.tracks[0].clips).toHaveLength(1)
    expect(history.canUndo()).toBe(true)

    const undone = await executor.undo(project)
    expect(undone.success).toBe(true)
    expect(timeline.tracks[0].clips).toHaveLength(0)
    expect(history.canRedo()).toBe(true)

    const redone = await executor.redo(project)
    expect(redone.success).toBe(true)
    expect(timeline.tracks[0].clips).toHaveLength(1)
  })
})
