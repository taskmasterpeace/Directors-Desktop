/**
 * Descript-style transcript panel.
 *
 * - Click a word to seek; shift-click to extend a selection.
 * - Double-click a word to EDIT its text (timestamps are preserved); edits persist via
 *   onWordsChange so they flow into any prompt built from the transcript.
 * - With a selection, build a generation prompt from the words. The prompt can be
 *   "Story-aware" (the whole transcript is sent as context so the image/video stays
 *   consistent with the story) or "Plain" (just the selected words), and targeted at an
 *   "Image" or "Video". From the prompt you can kick off the generate chain (image first,
 *   then video from that image) via onGenerate.
 * - Selecting a span + Delete ripple-removes it from the timeline (silence-snapped).
 *
 * Word timestamps are SOURCE-media seconds; mapping to/from timeline time uses the same
 * speed-aware math as the ripple engine.
 */

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Scissors, Mic, Wand2, Copy, ImageIcon, Film, BookOpen, Music } from 'lucide-react'
import { sourceTimeToTimelineTime, snapSpanToSilence, type RippleClip } from '../lib/transcript-ripple'
import { transcribeAudio, transcriptToPrompt, type TranscriptWord, type TranscriptMode } from '../lib/transcript-api'

interface TranscriptClip extends RippleClip {
  id: string
}

type MediaType = 'image' | 'video'

interface TranscriptPanelProps {
  clip: TranscriptClip
  /** Source audio/video path to transcribe (a clip's asset file). */
  audioPath: string | null
  /** Pre-loaded words (e.g. cached on the asset); when absent, a Transcribe button appears. */
  words?: TranscriptWord[]
  /** Current playhead time in timeline seconds (drives the active-word highlight). */
  currentTime: number
  onSeek: (timelineTime: number) => void
  onDeleteSpan: (clipId: string, spanStartSource: number, spanEndSource: number) => void
  onWordsLoaded?: (clipId: string, words: TranscriptWord[]) => void
  /** Fired when a word's text is edited (timestamps unchanged). */
  onWordsChange?: (clipId: string, words: TranscriptWord[]) => void
  /** Model the transcript→prompt bridge should target. */
  targetModel?: string
  /** Kick off the generate chain from a prompt: image first, then video-from-image. */
  onGenerate?: (prompt: string, mediaType: MediaType) => void
  /** True while the host is running a generation (disables the Generate button). */
  isBusy?: boolean
}

/** Inverse of sourceTimeToTimelineTime — map the timeline playhead back to source seconds. */
function timelineTimeToSourceTime(timelineTime: number, clip: RippleClip): number {
  return clip.trimStart + (timelineTime - clip.startTime) * (clip.speed || 1)
}

export function TranscriptPanel({
  clip,
  audioPath,
  words: providedWords,
  currentTime,
  onSeek,
  onDeleteSpan,
  onWordsLoaded,
  onWordsChange,
  targetModel = 'seedance-2.0',
  onGenerate,
  isBusy,
}: TranscriptPanelProps) {
  const [localWords, setLocalWords] = useState<TranscriptWord[]>(providedWords ?? [])
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selStart, setSelStart] = useState<number | null>(null)
  const [selEnd, setSelEnd] = useState<number | null>(null)
  const [generatedPrompt, setGeneratedPrompt] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<TranscriptMode>('story')
  const [lyrics, setLyrics] = useState('')
  const [mediaType, setMediaType] = useState<MediaType>('image')

  // Sync from the asset's cached words when the parent provides/updates them.
  useEffect(() => {
    if (providedWords && providedWords.length) setLocalWords(providedWords)
  }, [providedWords])

  const words = localWords
  const sourceNow = timelineTimeToSourceTime(currentTime, clip)
  const fullStory = useMemo(() => words.map((w) => w.text).join(' ').trim(), [words])

  const selection = useMemo(() => {
    if (selStart === null) return null
    const a = selStart
    const b = selEnd ?? selStart
    return { lo: Math.min(a, b), hi: Math.max(a, b) }
  }, [selStart, selEnd])

  const selectedText = useMemo(() => {
    if (!selection) return ''
    return words.slice(selection.lo, selection.hi + 1).map((w) => w.text).join(' ').trim()
  }, [selection, words])

  const handleTranscribe = async () => {
    if (!audioPath) return
    setIsTranscribing(true)
    setError(null)
    try {
      const result = await transcribeAudio(audioPath)
      setLocalWords(result)
      onWordsLoaded?.(clip.id, result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transcription failed')
    } finally {
      setIsTranscribing(false)
    }
  }

  const handleWordClick = (index: number, e: React.MouseEvent) => {
    if (editingIndex !== null) return
    const word = words[index]
    if (!word) return
    if (e.shiftKey && selStart !== null) {
      setSelEnd(index)
      return
    }
    setSelStart(index)
    setSelEnd(index)
    onSeek(sourceTimeToTimelineTime(word.start, clip))
  }

  const startEdit = (index: number) => {
    setEditingIndex(index)
    setDraft(words[index]?.text ?? '')
  }

  const commitEdit = () => {
    if (editingIndex === null) return
    const next = words.map((w, i) => (i === editingIndex ? { ...w, text: draft } : w))
    setLocalWords(next)
    onWordsChange?.(clip.id, next)
    setEditingIndex(null)
  }

  const handleDelete = () => {
    if (!selection) return
    const span = snapSpanToSilence(words, selection.lo, selection.hi)
    if (span.end <= span.start) return
    onDeleteSpan(clip.id, span.start, span.end)
    setSelStart(null)
    setSelEnd(null)
  }

  const handleGeneratePrompt = async () => {
    if (!selectedText) return
    setIsGenerating(true)
    setError(null)
    try {
      const prompt = await transcriptToPrompt(selectedText, {
        targetModel,
        mode,
        fullStory: mode === 'story' ? fullStory : undefined,
        lyrics: mode === 'music' ? lyrics : undefined,
        mediaType,
      })
      setGeneratedPrompt(prompt)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Prompt generation failed')
    } finally {
      setIsGenerating(false)
    }
  }

  const Segmented = ({
    value,
    options,
    onChange,
  }: {
    value: string
    options: { val: string; label: string; icon?: React.ReactNode }[]
    onChange: (v: string) => void
  }) => (
    <div className="inline-flex overflow-hidden rounded-md border" style={{ borderColor: 'var(--dp-border)' }}>
      {options.map((o) => (
        <button
          key={o.val}
          onClick={() => onChange(o.val)}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium transition-colors"
          style={{
            background: value === o.val ? 'var(--dp-accent-teal)' : 'transparent',
            color: value === o.val ? 'white' : 'var(--dp-muted, #a1a1aa)',
          }}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )

  return (
    <div
      className="rounded-[0.625rem] border p-3 text-sm"
      style={{ background: 'var(--dp-rail-surface)', borderColor: 'var(--dp-border)' }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--dp-accent-teal)' }}>
          <Mic className="h-3.5 w-3.5" /> Transcript
        </span>
        {selection && (
          <button
            onClick={handleDelete}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-white transition-colors"
            style={{ background: 'var(--dp-accent-teal)' }}
            title="Ripple-delete the selected words from the timeline"
          >
            <Scissors className="h-3 w-3" /> Delete
          </button>
        )}
      </div>

      {/* Prompt controls — only meaningful with a selection */}
      {selection && (
        <div className="mb-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as TranscriptMode)}
              options={[
                { val: 'story', label: 'Story', icon: <BookOpen className="h-3 w-3" /> },
                { val: 'music', label: 'Music', icon: <Music className="h-3 w-3" /> },
                { val: 'plain', label: 'Plain' },
              ]}
            />
            <Segmented
              value={mediaType}
              onChange={(v) => setMediaType(v as MediaType)}
              options={[
                { val: 'image', label: 'Image', icon: <ImageIcon className="h-3 w-3" /> },
                { val: 'video', label: 'Video', icon: <Film className="h-3 w-3" /> },
              ]}
            />
            <button
              onClick={handleGeneratePrompt}
              disabled={isGenerating || !selectedText}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-white transition-colors disabled:opacity-40"
              style={{ background: 'var(--dp-primary-amber)' }}
              title="Turn the selected words into a generation prompt"
            >
              {isGenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />} Prompt
            </button>
          </div>
          {mode === 'music' && (
            <textarea
              value={lyrics}
              onChange={(e) => setLyrics(e.target.value)}
              placeholder="Paste the song lyrics here — used as context for music-video shots…"
              rows={3}
              className="w-full rounded-md border bg-transparent px-2 py-1.5 text-[11px] text-zinc-200 outline-none"
              style={{ borderColor: 'var(--dp-border)' }}
            />
          )}
        </div>
      )}

      {generatedPrompt && (
        <div
          className="mb-2 rounded-md border p-2 text-[11px]"
          style={{ borderColor: 'var(--dp-border)', background: 'var(--dp-popover)' }}
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium" style={{ color: 'var(--dp-primary-amber)' }}>
              {mediaType === 'video' ? 'Video' : 'Image'} prompt · {mode}
            </span>
            <button
              onClick={() => void navigator.clipboard?.writeText(generatedPrompt)}
              className="flex items-center gap-1 text-zinc-400 hover:text-white"
              title="Copy prompt"
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
          </div>
          <p className="mb-2 text-zinc-200">{generatedPrompt}</p>
          {onGenerate && (
            <button
              onClick={() => onGenerate(generatedPrompt, mediaType)}
              disabled={isBusy}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium text-white transition-colors disabled:opacity-40"
              style={{ background: 'var(--dp-accent-teal)' }}
              title={mediaType === 'video' ? 'Generate an image, then a video from it' : 'Generate an image from this prompt'}
            >
              {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : mediaType === 'video' ? <Film className="h-3 w-3" /> : <ImageIcon className="h-3 w-3" />}
              {mediaType === 'video' ? 'Generate image → video' : 'Generate image'}
            </button>
          )}
        </div>
      )}

      {words.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <button
            onClick={handleTranscribe}
            disabled={!audioPath || isTranscribing}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-40"
            style={{ background: 'var(--dp-primary-amber)' }}
          >
            {isTranscribing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
            {isTranscribing ? 'Transcribing…' : 'Transcribe audio'}
          </button>
          {!audioPath && <p className="text-[11px] text-zinc-500">Select a clip with audio to transcribe.</p>}
        </div>
      ) : (
        <p className="leading-7">
          {words.map((word, i) => {
            if (editingIndex === i) {
              return (
                <input
                  key={`edit-${i}`}
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit()
                    else if (e.key === 'Escape') setEditingIndex(null)
                  }}
                  className="mx-0.5 w-20 rounded border bg-transparent px-1 text-sm text-white outline-none"
                  style={{ borderColor: 'var(--dp-primary-amber)' }}
                />
              )
            }
            const isActive = sourceNow >= word.start && sourceNow < word.end
            const isSelected = selection !== null && i >= selection.lo && i <= selection.hi
            return (
              <span
                key={`${i}-${word.start}`}
                onClick={(e) => handleWordClick(i, e)}
                onDoubleClick={() => startEdit(i)}
                className="cursor-text rounded px-0.5 transition-colors"
                style={{
                  background: isSelected
                    ? 'color-mix(in oklch, var(--dp-accent-teal) 35%, transparent)'
                    : isActive
                      ? 'color-mix(in oklch, var(--dp-primary-amber) 30%, transparent)'
                      : 'transparent',
                  color: isActive ? 'var(--dp-primary-amber)' : undefined,
                }}
                title={`${word.start.toFixed(2)}s – ${word.end.toFixed(2)}s · double-click to edit`}
              >
                {word.text}{' '}
              </span>
            )
          })}
        </p>
      )}
      <p className="mt-2 text-[10px] text-zinc-500">
        Click to seek · Shift-click to extend · Double-click to edit · Delete to ripple-cut
      </p>
    </div>
  )
}
