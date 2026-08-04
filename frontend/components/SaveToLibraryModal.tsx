import { useEffect, useState } from 'react'
import { UserPlus, Images } from 'lucide-react'

/**
 * #73: turn any generated image into a library entity in one click — the
 * missing link between "I generated a great face" and "the Director can use
 * that face on every shot".
 */
export interface SaveToLibraryRequest {
  kind: 'character' | 'reference'
  imagePath: string
  suggestedName?: string
}

const REF_CATEGORIES = ['people', 'places', 'wardrobe', 'styles'] as const
type RefCategory = (typeof REF_CATEGORIES)[number]

export function SaveToLibraryModal({
  request,
  onClose,
  onSaved,
}: {
  request: SaveToLibraryRequest | null
  onClose: () => void
  onSaved?: (kind: 'character' | 'reference', name: string) => void
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState<RefCategory>('people')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (request) {
      setName(request.suggestedName ?? '')
      setError(null)
      setBusy(false)
    }
  }, [request])

  if (!request) return null
  const isCharacter = request.kind === 'character'

  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const base = await window.electronAPI.getBackendUrl()
      const res = isCharacter
        ? await fetch(`${base}/api/library/characters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim(), reference_image_paths: [request.imagePath] }),
          })
        : await fetch(`${base}/api/library/references`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim(), category, image_path: request.imagePath }),
          })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `Save failed (${res.status})`)
      }
      onSaved?.(request.kind, name.trim())
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[130] bg-black/70 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          {isCharacter ? <UserPlus className="h-4 w-4 text-amber-400" /> : <Images className="h-4 w-4 text-amber-400" />}
          <h3 className="text-sm font-semibold text-white">
            {isCharacter ? 'Save as Character' : 'Save to References'}
          </h3>
        </div>
        <label className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
          placeholder={isCharacter ? 'e.g. NOVA' : 'e.g. Neon rooftop'}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-sm text-zinc-200 focus:outline-none focus:border-amber-500/60"
        />
        {!isCharacter && (
          <>
            <label className="mt-3 block text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as RefCategory)}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-200"
            >
              {REF_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>
              ))}
            </select>
          </>
        )}
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 hover:bg-zinc-800">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!name.trim() || busy}
            className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 text-xs font-semibold disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
