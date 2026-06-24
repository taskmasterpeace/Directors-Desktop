/**
 * Transcript API — word-level transcription + transcript→prompt bridge (Phases 2 & 3).
 * Auth is attached globally by installBackendAuthInterceptor.
 */

const getBaseUrl = async (): Promise<string> => {
  if (window.electronAPI) {
    return await window.electronAPI.getBackendUrl()
  }
  return 'http://localhost:8000'
}

export interface TranscriptWord {
  text: string
  /** seconds into the SOURCE media (survives trim/split/speed) */
  start: number
  end: number
}

export async function transcribeAudio(audioPath: string): Promise<TranscriptWord[]> {
  const base = await getBaseUrl()
  const resp = await fetch(`${base}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioPath }),
  })
  if (!resp.ok) {
    throw new Error(`Transcription failed: ${resp.status} ${await resp.text()}`)
  }
  const data: { words: TranscriptWord[] } = await resp.json()
  return data.words
}

export type TranscriptMode = 'story' | 'music' | 'plain'

export interface TranscriptToPromptOptions {
  targetModel: string
  /** Context mode: 'story' (full transcript), 'music' (lyrics), or 'plain' (none). */
  mode?: TranscriptMode
  /** Whole transcript, sent as context in 'story' mode. */
  fullStory?: string
  /** Song lyrics, sent as context in 'music' mode. */
  lyrics?: string
  /** Tailors the prompt for a still image or a motion video. */
  mediaType?: 'image' | 'video'
}

export async function transcriptToPrompt(
  text: string,
  opts: TranscriptToPromptOptions,
): Promise<string> {
  const base = await getBaseUrl()
  const resp = await fetch(`${base}/api/transcript/to-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      targetModel: opts.targetModel,
      mode: opts.mode ?? 'plain',
      fullStory: opts.fullStory,
      lyrics: opts.lyrics,
      mediaType: opts.mediaType ?? 'image',
    }),
  })
  if (!resp.ok) {
    throw new Error(`Transcript→prompt failed: ${resp.status} ${await resp.text()}`)
  }
  const data: { prompt: string } = await resp.json()
  return data.prompt
}
