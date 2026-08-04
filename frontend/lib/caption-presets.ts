import type { SubtitleStyle } from '../types/project'

/**
 * #75: one-tap caption looks. Every preset leans on the fields the ffmpeg
 * burn-in actually honors (size, color, background box, position) so what
 * you see in playback is what the exported MP4 shows — no preview lies.
 */
export interface CaptionPreset {
  id: string
  label: string
  style: Partial<SubtitleStyle>
}

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: 'clean',
    label: 'Clean',
    style: { fontSize: 32, fontWeight: 'normal', italic: false, color: '#FFFFFF', backgroundColor: 'transparent', position: 'bottom' },
  },
  {
    id: 'boxed',
    label: 'Boxed',
    style: { fontSize: 32, fontWeight: 'bold', italic: false, color: '#FFFFFF', backgroundColor: '#000000B3', position: 'bottom' },
  },
  {
    id: 'bold-pop',
    label: 'Bold Pop',
    style: { fontSize: 44, fontWeight: 'bold', italic: false, color: '#FBBF24', backgroundColor: '#00000080', position: 'bottom' },
  },
  {
    id: 'headline',
    label: 'Headline',
    style: { fontSize: 40, fontWeight: 'bold', italic: false, color: '#FFFFFF', backgroundColor: 'transparent', position: 'top' },
  },
  {
    id: 'center-stage',
    label: 'Center Stage',
    style: { fontSize: 48, fontWeight: 'bold', italic: false, color: '#FFFFFF', backgroundColor: 'transparent', position: 'center' },
  },
  {
    id: 'whisper',
    label: 'Whisper',
    style: { fontSize: 24, fontWeight: 'normal', italic: true, color: '#D4D4D8', backgroundColor: 'transparent', position: 'bottom' },
  },
]

/** The karaoke word-pop look — stamped per-subtitle when captions are cut one word per cue. */
export const WORD_POP_STYLE: Partial<SubtitleStyle> = {
  fontSize: 54,
  fontWeight: 'bold',
  italic: false,
  color: '#FBBF24',
  backgroundColor: 'transparent',
  position: 'center',
}
