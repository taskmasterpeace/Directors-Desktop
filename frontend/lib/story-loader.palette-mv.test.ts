// Verifies the "Open Palette MV" import path: loadStoryToTimeline consuming a
// Directors Palette music-video export (StoryFile with REMOTE http clip URLs).
// This is exactly what ProjectContext.importPaletteMv() runs after reading the
// .story.json — so it covers the whole import minus the file dialog + editor
// mount (which need the Electron GUI). Guards the abs() http-passthrough fix.
import { describe, it, expect } from 'vitest'
import { loadStoryToTimeline, type StoryFile } from './story-loader'

// A realistic Palette MV export: remote R2/Supabase URLs, chapters=pillar
// regions, beats=shots with slot timings + lyric text + storyboard still.
const paletteExport: StoryFile = {
  slug: 'real-steppa',
  title: 'Real Steppa — TEST',
  fps: 24,
  width: 1920,
  height: 1080,
  audio: 'https://pub-xyz.r2.dev/song.mp3',
  characters: { '@artist': 'https://tarohelkwuurakbxjyxm.supabase.co/storage/v1/object/public/directors-palette/sheet.jpg' },
  total_runtime_seconds: 30,
  chapters: [
    { id: 'performance-0', index: 0, title: 'performance', start_seconds: 0, end_seconds: 15, beat_count: 1 },
    { id: 'b-roll-1', index: 1, title: 'b-roll', start_seconds: 15, end_seconds: 30, beat_count: 1 },
  ],
  beats: [
    { beat_id: 'chunk-0', chapter: 'performance-0', chapter_title: 'performance', slot: { start_seconds: 0, end_seconds: 15 }, text: 'Keep a bag for the mood', still: 'https://pub-xyz.r2.dev/board-0.jpg', video: 'https://pub-xyz.r2.dev/clip-0.mp4', video_conf: 'high', notes: 'performance shot prompt', characters: ['@artist'] },
    { beat_id: 'chunk-1', chapter: 'b-roll-1', chapter_title: 'b-roll', slot: { start_seconds: 15, end_seconds: 30 }, text: 'Catch me steppin heavy', still: 'https://pub-xyz.r2.dev/board-1.jpg', video: 'https://pub-xyz.r2.dev/clip-1.mp4', video_conf: 'high', notes: 'b-roll shot prompt', characters: [] },
  ],
}

describe('loadStoryToTimeline — Palette MV import', () => {
  const loaded = loadStoryToTimeline(paletteExport, 'C:/whatever/stories/real-steppa/real-steppa.story.json')

  it('builds an editable timeline with clips + subtitles', () => {
    expect(loaded.timeline).toBeTruthy()
    expect(loaded.timeline.clips.length).toBeGreaterThan(0)
    expect(loaded.durationSeconds).toBe(30)
  })

  it('places each shot video as a positioned clip on the timeline', () => {
    const videoClips = loaded.timeline.clips.filter((c) => c.type === 'video')
    expect(videoClips).toHaveLength(2)
    const first = videoClips.find((c) => c.id.includes('chunk-0'))!
    expect(first.startTime).toBe(0)
    expect(first.duration).toBe(15)
    const second = videoClips.find((c) => c.id.includes('chunk-1'))!
    expect(second.startTime).toBe(15)
    expect(second.duration).toBe(15)
  })

  it('passes REMOTE http(s) URLs through unchanged (no file:// mangling)', () => {
    // The abs() http-passthrough fix: a Palette clip lives on R2/Supabase, so it
    // must NOT be rewritten to file://<repoRoot>/https://…
    const allUrls = loaded.timeline.clips.map((c) => c.importedUrl).filter(Boolean) as string[]
    expect(allUrls.length).toBeGreaterThan(0)
    for (const u of allUrls) {
      expect(u.startsWith('https://')).toBe(true)
      expect(u).not.toContain('file://')
    }
    // The rendered clip URLs specifically survived intact.
    expect(allUrls).toContain('https://pub-xyz.r2.dev/clip-0.mp4')
    expect(allUrls).toContain('https://pub-xyz.r2.dev/clip-1.mp4')
  })

  it('carries each beat text as a subtitle synced to the playhead', () => {
    const subs = loaded.timeline.subtitles ?? []
    expect(subs.length).toBe(2)
    expect(subs[0].text).toBe('Keep a bag for the mood')
    expect(subs[0].startTime).toBe(0)
    expect(subs[0].endTime).toBe(15)
  })

  it('adds the song as an audio clip spanning the runtime (remote URL intact)', () => {
    const audio = loaded.timeline.clips.find((c) => c.type === 'audio')
    expect(audio).toBeTruthy()
    expect(audio!.importedUrl).toBe('https://pub-xyz.r2.dev/song.mp3')
  })
})
