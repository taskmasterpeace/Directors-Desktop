import { describe, it, expect } from 'vitest'
import { directorRunToTimeline } from './director-import'

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
