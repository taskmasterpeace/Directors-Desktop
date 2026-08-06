import { describe, it, expect } from 'vitest'
import { directorRunToAlternateTrack, directorRunToTimeline } from './director-import'

const run = {
  id: 'dir_abc',
  concept: 'neon rooftop chase',
  audioPath: 'C:\\music\\song.mp3',
  songSeconds: 40,
  model: 'ltx-fast',
  resolution: '480p',
  sections: [
    { start: 0, end: 16, label: 'intro' },
    { start: 16, end: 40, label: 'chorus' },
  ],
  shots: [
    { index: 0, start: 0, end: 5.5, sectionLabel: 'intro', shotType: 'establishing', prompt: 'p0', resultPath: 'C:\\out\\s0.mp4', keyframePath: 'C:\\out\\k0.png', generateSeconds: 6 },
    { index: 1, start: 5.5, end: 10, sectionLabel: 'intro', shotType: 'performance', prompt: 'p1', resultPath: 'C:\\out\\s1.mp4' },
    { index: 2, start: 10, end: 16, sectionLabel: 'intro', shotType: 'broll', prompt: 'p2', resultPath: null },
  ],
}

describe('directorRunToTimeline', () => {
  it('carries aspect and beats onto the timeline', () => {
    const { timeline } = directorRunToTimeline({ ...run, aspect: '9:16', beats: [0.5, 1.0, 1.5] })
    expect(timeline.aspectRatio).toBe('9:16')
    expect(timeline.beats).toEqual([0.5, 1.0, 1.5])
    const { timeline: fallback } = directorRunToTimeline(run)
    expect(fallback.aspectRatio).toBe('16:9')
  })

  it('places rendered shots as muted V1 clips at their beat positions', () => {
    const { timeline: tl } = directorRunToTimeline(run)
    const videos = tl.clips.filter((c) => c.type === 'video')
    expect(videos).toHaveLength(2) // the unrendered shot is skipped
    expect(videos[0].startTime).toBe(0)
    expect(videos[0].duration).toBe(5.5)
    expect(videos[0].trackIndex).toBe(0)
    expect(videos[0].muted).toBe(true)
    expect(videos[0].importedUrl).toBe('file:///C:/out/s0.mp4')
    expect(videos[1].startTime).toBe(5.5)
  })

  it('every rendered shot is a real Asset with regen params — takes need assets', () => {
    const { timeline: tl, assets } = directorRunToTimeline(run)
    expect(assets).toHaveLength(2)
    for (const clip of tl.clips.filter((c) => c.type === 'video')) {
      const asset = assets.find((a) => a.id === clip.assetId)!
      expect(asset, `clip ${clip.id} must reference an asset`).toBeDefined()
      expect(asset.origin).toMatchObject({ app: 'director', runId: 'dir_abc', model: 'ltx-fast' })
    }
    // Keyframed shot regenerates as I2V with its own keyframe + window
    const s0 = assets.find((a) => a.origin!.shotIndex === 0)!
    expect(s0.generationParams).toMatchObject({
      mode: 'image-to-video',
      prompt: 'p0',
      model: 'ltx-fast',
      duration: 6,
      resolution: '480p',
      inputImageUrl: 'file:///C:/out/k0.png',
    })
    // Keyframe-less shot regenerates as T2V, duration from its cut window
    const s1 = assets.find((a) => a.origin!.shotIndex === 1)!
    expect(s1.generationParams).toMatchObject({ mode: 'text-to-video', duration: 5 })
  })

  it('a run without model info still imports — assets carry origin, no regen params', () => {
    const { assets } = directorRunToTimeline({ ...run, model: undefined, resolution: undefined })
    expect(assets).toHaveLength(2)
    expect(assets[0].generationParams).toBeUndefined()
    expect(assets[0].origin!.app).toBe('director')
  })

  it('lays the song on A1 spanning the full runtime', () => {
    const { timeline: tl } = directorRunToTimeline(run)
    const audio = tl.clips.find((c) => c.type === 'audio')
    expect(audio).toBeDefined()
    expect(audio!.startTime).toBe(0)
    expect(audio!.duration).toBe(40)
    expect(audio!.trackIndex).toBe(3)
    expect(audio!.importedUrl).toBe('file:///C:/music/song.mp3')
  })

  it('turns sections into agent range markers with structural colors', () => {
    const { timeline: tl } = directorRunToTimeline(run)
    expect(tl.markers).toHaveLength(2)
    const chorus = tl.markers!.find((m) => m.title === 'chorus')!
    expect(chorus.time).toBe(16)
    expect(chorus.duration).toBe(24)
    expect(chorus.color).toBe('amber')
    expect(chorus.author).toBe('agent')
  })

  it('survives missing sections and songSeconds', () => {
    const { timeline: tl } = directorRunToTimeline({ ...run, sections: null, songSeconds: null })
    expect(tl.markers).toHaveLength(0)
    const audio = tl.clips.find((c) => c.type === 'audio')
    expect(audio!.duration).toBe(16) // falls back to the last shot's end
  })
})


describe('directorRunToAlternateTrack', () => {
  it('appends a new muted video lane at the same beat positions', () => {
    const { timeline: existing } = directorRunToTimeline(run)
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
    const { timeline: existing } = directorRunToTimeline(run)
    const withAlt = {
      ...existing,
      tracks: [...existing.tracks, directorRunToAlternateTrack({ ...run, id: 'a' }, existing).track],
    }
    const second = directorRunToAlternateTrack({ ...run, id: 'b' }, withAlt)
    expect(second.track.name).toBe('Director Alt 2')
  })
})
