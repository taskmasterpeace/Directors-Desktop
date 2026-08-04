import { describe, it, expect } from 'vitest'
import { directorRunToAlternateTrack, directorRunToTimeline } from './director-import'

const run = {
  id: 'dir_abc',
  concept: 'neon rooftop chase',
  audioPath: 'C:\\music\\song.mp3',
  songSeconds: 40,
  sections: [
    { start: 0, end: 16, label: 'intro' },
    { start: 16, end: 40, label: 'chorus' },
  ],
  shots: [
    { index: 0, start: 0, end: 5.5, sectionLabel: 'intro', shotType: 'establishing', prompt: 'p0', resultPath: 'C:\\out\\s0.mp4' },
    { index: 1, start: 5.5, end: 10, sectionLabel: 'intro', shotType: 'performance', prompt: 'p1', resultPath: 'C:\\out\\s1.mp4' },
    { index: 2, start: 10, end: 16, sectionLabel: 'intro', shotType: 'broll', prompt: 'p2', resultPath: null },
  ],
}

describe('directorRunToTimeline', () => {
  it('carries aspect and beats onto the timeline', () => {
    const timeline = directorRunToTimeline({ ...run, aspect: '9:16', beats: [0.5, 1.0, 1.5] })
    expect(timeline.aspectRatio).toBe('9:16')
    expect(timeline.beats).toEqual([0.5, 1.0, 1.5])
    const fallback = directorRunToTimeline(run)
    expect(fallback.aspectRatio).toBe('16:9')
  })

  it('places rendered shots as muted V1 clips at their beat positions', () => {
    const tl = directorRunToTimeline(run)
    const videos = tl.clips.filter((c) => c.type === 'video')
    expect(videos).toHaveLength(2) // the unrendered shot is skipped
    expect(videos[0].startTime).toBe(0)
    expect(videos[0].duration).toBe(5.5)
    expect(videos[0].trackIndex).toBe(0)
    expect(videos[0].muted).toBe(true)
    expect(videos[0].importedUrl).toBe('file:///C:/out/s0.mp4')
    expect(videos[1].startTime).toBe(5.5)
  })

  it('lays the song on A1 spanning the full runtime', () => {
    const tl = directorRunToTimeline(run)
    const audio = tl.clips.find((c) => c.type === 'audio')
    expect(audio).toBeDefined()
    expect(audio!.startTime).toBe(0)
    expect(audio!.duration).toBe(40)
    expect(audio!.trackIndex).toBe(3)
    expect(audio!.importedUrl).toBe('file:///C:/music/song.mp3')
  })

  it('turns sections into agent range markers with structural colors', () => {
    const tl = directorRunToTimeline(run)
    expect(tl.markers).toHaveLength(2)
    const chorus = tl.markers!.find((m) => m.title === 'chorus')!
    expect(chorus.time).toBe(16)
    expect(chorus.duration).toBe(24)
    expect(chorus.color).toBe('amber')
    expect(chorus.author).toBe('agent')
  })

  it('survives missing sections and songSeconds', () => {
    const tl = directorRunToTimeline({ ...run, sections: null, songSeconds: null })
    expect(tl.markers).toHaveLength(0)
    const audio = tl.clips.find((c) => c.type === 'audio')
    expect(audio!.duration).toBe(16) // falls back to the last shot's end
  })
})


describe('directorRunToAlternateTrack', () => {
  it('appends a new muted video lane at the same beat positions', () => {
    const existing = directorRunToTimeline(run)
    const alt = directorRunToAlternateTrack({ ...run, id: 'dir_second' }, existing)
    expect(alt.trackIndex).toBe(existing.tracks.length)
    expect(alt.track.name).toBe('Director Alt 1')
    expect(alt.clips).toHaveLength(2)
    expect(alt.clips[0].startTime).toBe(0)
    expect(alt.clips[0].trackIndex).toBe(alt.trackIndex)
    expect(alt.clips[0].muted).toBe(true)
    expect(alt.clips[0].id).toContain('dir_second')
  })

  it('numbers subsequent alternates', () => {
    const existing = directorRunToTimeline(run)
    const withAlt = {
      ...existing,
      tracks: [...existing.tracks, directorRunToAlternateTrack({ ...run, id: 'a' }, existing).track],
    }
    const second = directorRunToAlternateTrack({ ...run, id: 'b' }, withAlt)
    expect(second.track.name).toBe('Director Alt 2')
  })
})
