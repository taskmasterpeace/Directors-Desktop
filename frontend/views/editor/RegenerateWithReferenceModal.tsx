import { useState } from 'react'
import { RefreshCw, X, ImagePlus, Film, Plus } from 'lucide-react'
import { toImgSrc } from '../../lib/path-to-img-src'
import { validateRegenWithRef, clampRegenDuration, chooseRegenTarget, REF_CAPS, SEEDANCE_MAX_SECONDS, SEEDANCE_15_MAX_SECONDS } from '../../lib/regen-with-reference'

/**
 * "Regenerate with reference" — the approved agent-editor UX: this clip, redone
 * to follow a reference (a clip / a frame / a crop) with an optional note,
 * landing as a NEW TAKE so nothing else on the timeline moves. The panel
 * already knows the clip's length; the render matches it. It renders on Seedance
 * 2.0 (fal) omni-reference when a fal key is set; otherwise a still-image
 * reference falls back to Replicate's Seedance 1.5 (reference → first frame).
 */
export function RegenerateWithReferenceModal({
  clipDurationSeconds,
  clipLabel,
  hasFalApiKey = false,
  initialImagePaths = [],
  initialVideoPaths = [],
  onSubmit,
  onClose,
}: {
  clipDurationSeconds: number
  clipLabel: string
  hasFalApiKey?: boolean
  initialImagePaths?: string[]
  initialVideoPaths?: string[]
  onSubmit: (r: { referenceImagePaths: string[]; videoReferencePaths: string[]; note: string }) => void
  onClose: () => void
}) {
  const [images, setImages] = useState<string[]>(initialImagePaths)
  const [videos, setVideos] = useState<string[]>(initialVideoPaths)
  const [note, setNote] = useState('')
  const target = chooseRegenTarget({ videoReferencePaths: videos, falAvailable: hasFalApiKey })
  const cap = target.model === 'seedance-2.0' ? SEEDANCE_MAX_SECONDS : SEEDANCE_15_MAX_SECONDS
  const renderSeconds = clampRegenDuration(clipDurationSeconds, cap)
  const engineLabel = target.model === 'seedance-2.0'
    ? 'Seedance 2.0 (fal · omni-reference)'
    : 'Seedance 1.5 (Replicate · reference → first frame)'
  const errors = validateRegenWithRef({ referenceImagePaths: images, videoReferencePaths: videos })

  const addImage = async () => {
    const paths = await window.electronAPI.showOpenFileDialog({
      title: 'Reference image (frame or crop)',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (paths?.length) setImages((prev) => [...new Set([...prev, ...paths])].slice(0, REF_CAPS.image))
  }
  const addVideo = async () => {
    const paths = await window.electronAPI.showOpenFileDialog({
      title: 'Reference clip (≤15s)',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'm4v'] }],
      properties: ['openFile'],
    })
    if (paths?.length) setVideos((prev) => [...new Set([...prev, ...paths])].slice(0, REF_CAPS.video))
  }
  const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div className="w-[460px] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-4 py-3 border-b border-zinc-800">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Regenerate with reference</h3>
            <p className="mt-0.5 text-[11px] text-zinc-500 truncate max-w-[360px]">{clipLabel || 'this clip'}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-700 text-zinc-400"><X className="h-4 w-4" /></button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-[11px] text-zinc-400">
            Renders <span className="text-zinc-200 font-medium">{renderSeconds}s</span> (this clip's length) on{' '}
            <span className="text-zinc-300">{engineLabel}</span>, following your reference. The result lands as a{' '}
            <span className="text-zinc-200">new take</span> — the old one stays.
          </p>
          {!hasFalApiKey && (
            <p className="text-[10px] text-zinc-500">
              No fal key set — using Replicate. Video-clip references need Seedance 2.0 (add a fal key in Settings); a frame or crop works here now.
            </p>
          )}

          {/* Reference tray */}
          <div className="rounded-md border border-zinc-700/60 bg-zinc-800/40 p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-zinc-300">References</span>
              <div className="flex gap-1.5">
                <button onClick={() => void addImage()} disabled={images.length >= REF_CAPS.image}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-amber-400 border border-zinc-700 disabled:opacity-40">
                  <ImagePlus className="h-3 w-3" /> Frame/crop
                </button>
                <button onClick={() => void addVideo()} disabled={videos.length >= REF_CAPS.video}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-cyan-400 border border-zinc-700 disabled:opacity-40">
                  <Film className="h-3 w-3" /> Clip
                </button>
              </div>
            </div>
            {images.length === 0 && videos.length === 0 ? (
              <div className="flex items-center gap-2 py-3 justify-center text-[11px] text-zinc-600">
                <Plus className="h-3.5 w-3.5" /> Add a frame, a crop, or a clip to follow
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {images.map((p) => (
                  <span key={p} className="flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-300">
                    <img src={toImgSrc(p)} alt="" className="h-6 w-6 rounded object-cover" />
                    <span className="max-w-[80px] truncate">{basename(p)}</span>
                    <button onClick={() => setImages((prev) => prev.filter((x) => x !== p))} className="text-zinc-500 hover:text-red-400"><X className="h-3 w-3" /></button>
                  </span>
                ))}
                {videos.map((p) => (
                  <span key={p} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-cyan-300">
                    <Film className="h-3 w-3" />
                    <span className="max-w-[90px] truncate">{basename(p)}</span>
                    <button onClick={() => setVideos((prev) => prev.filter((x) => x !== p))} className="text-zinc-500 hover:text-red-400"><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <label className="block text-xs font-medium text-zinc-400">
            Note <span className="text-zinc-600">(optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder={'e.g. "more rain, keep the camera move"'}
              className="mt-1 w-full resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500 focus:outline-none"
            />
          </label>

          {errors.length > 0 && (
            <p className="text-[11px] text-amber-400/90">{errors[0]}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-800">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button
            onClick={() => onSubmit({ referenceImagePaths: images, videoReferencePaths: videos, note })}
            disabled={errors.length > 0}
            className="flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-40"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Render take
          </button>
        </div>
      </div>
    </div>
  )
}
