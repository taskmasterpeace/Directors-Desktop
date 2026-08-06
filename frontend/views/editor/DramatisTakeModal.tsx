import { useState } from 'react'
import { X, RefreshCw } from 'lucide-react'
import type { AssetOrigin } from '../../types/project'

/**
 * "New Take (Dramatis)" — direct one line's performance. The note goes to the
 * Studio verbatim ("more anger, through gritted teeth") and routes to an
 * engine that can actually perform it; blank = a fresh re-roll. The result
 * lands as a NEW take on the clip's asset — the old read is never lost.
 */
export function DramatisTakeModal({ origin, onSubmit, onClose }: {
  origin: AssetOrigin
  onSubmit: (note: string) => void
  onClose: () => void
}) {
  const [note, setNote] = useState('')

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[440px] rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">New take — {origin.entity}</h3>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              {origin.bookId} · chapter {origin.chapterNumber} · {origin.lineId}
              {origin.engine ? ` · currently ${origin.engine}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-700 text-zinc-400"><X className="h-4 w-4" /></button>
        </div>

        {origin.text && (
          <blockquote className="mt-3 rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs italic text-zinc-300 max-h-24 overflow-y-auto">
            “{origin.text}”
          </blockquote>
        )}

        <label className="mt-3 block text-xs font-medium text-zinc-400">
          Direction for this take
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={'e.g. "with more anger, through gritted teeth" — blank = fresh re-roll'}
            rows={3}
            className="mt-1 w-full resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-amber-500 focus:outline-none"
          />
        </label>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          Renders locally through the Dramatis Studio. The current read stays as a take —
          nothing is overwritten.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button onClick={() => onSubmit(note)}
            className="flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500">
            <RefreshCw className="h-3.5 w-3.5" /> Render take
          </button>
        </div>
      </div>
    </div>
  )
}
