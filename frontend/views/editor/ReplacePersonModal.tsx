import { useEffect, useState } from 'react'
import { ImageIcon, Loader2, UserRound, X } from 'lucide-react'
import { toImgSrc } from '../../lib/path-to-img-src'
import { logger } from '../../lib/logger'

/**
 * Replace Person — swap the person in this clip's footage for a character.
 *
 * Cloud-rendered (fal): Wan 2.2 Animate Replace (standard) or SCAIL-2
 * (stylized characters / hard motion). The finished video comes back as a new
 * TAKE on the clip's asset, so flipping between original and replaced is the
 * normal take switcher.
 */

interface LibraryCharacter {
  id: string
  name: string
  reference_image_paths: string[]
}

export interface RecastModelOption {
  id: string
  label: string
  hint: string
  resolutions: string[]
  defaultResolution: string
}

export const RECAST_MODEL_OPTIONS: RecastModelOption[] = [
  {
    id: 'wan-animate-replace',
    label: 'Standard — Wan 2.2 Animate',
    hint: '$0.04–0.08 per second of footage. Best for realistic people.',
    resolutions: ['480p', '580p', '720p'],
    defaultResolution: '580p',
  },
  {
    id: 'scail-2-replace',
    label: 'SCAIL-2 — stylized / hard shots',
    hint: '$0.20 per second, max ~10s per clip. Handles stylized characters and wild motion.',
    resolutions: ['512p', '704p'],
    defaultResolution: '704p',
  },
]

export function ReplacePersonModal({
  videoLabel,
  onClose,
  onSubmit,
}: {
  videoLabel: string
  onClose: () => void
  /** Kick off the job; resolves once submitted (not completed). */
  onSubmit: (opts: { characterImagePath: string; model: string; resolution: string }) => Promise<void>
}) {
  const [characters, setCharacters] = useState<LibraryCharacter[]>([])
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null)
  const [customImagePath, setCustomImagePath] = useState<string | null>(null)
  const [model, setModel] = useState(RECAST_MODEL_OPTIONS[0].id)
  const [resolution, setResolution] = useState(RECAST_MODEL_OPTIONS[0].defaultResolution)
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const base = await window.electronAPI.getBackendUrl()
        const res = await fetch(`${base}/api/library/characters`)
        if (res.ok) {
          const data = (await res.json()) as { characters?: LibraryCharacter[] }
          setCharacters((data.characters ?? []).filter((c) => c.reference_image_paths?.length))
        }
      } catch {
        /* library unavailable — file picker still works */
      }
    })()
  }, [])

  const modelOption = RECAST_MODEL_OPTIONS.find((m) => m.id === model) ?? RECAST_MODEL_OPTIONS[0]
  const chosenPath =
    customImagePath ??
    characters.find((c) => c.id === selectedCharacterId)?.reference_image_paths[0] ??
    null

  const pickFile = async () => {
    const files = await window.electronAPI.showOpenFileDialog({
      title: 'Character image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile'],
    })
    if (files && files[0]) {
      setCustomImagePath(files[0])
      setSelectedCharacterId(null)
    }
  }

  const submit = async () => {
    if (!chosenPath || !consent || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({ characterImagePath: chosenPath, model, resolution })
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not start the replacement'
      setError(msg)
      logger.error(`Replace person submit failed: ${msg}`)
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100]" onClick={onClose}>
      <div
        className="bg-zinc-900 rounded-2xl border border-zinc-700/50 shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <UserRound className="h-4 w-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">Replace Person</h2>
            <span className="text-[11px] text-zinc-500 truncate max-w-[180px]">{videoLabel}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Replace with</label>
            {characters.length > 0 && (
              <div className="mt-2 grid grid-cols-4 gap-2">
                {characters.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setSelectedCharacterId(c.id); setCustomImagePath(null) }}
                    className={`rounded-lg border p-1 transition-colors ${
                      selectedCharacterId === c.id
                        ? 'border-emerald-400 bg-emerald-500/10'
                        : 'border-zinc-700 hover:border-zinc-500'
                    }`}
                    title={c.name}
                  >
                    <img
                      src={toImgSrc(c.reference_image_paths[0])}
                      alt={c.name}
                      className="h-16 w-full object-cover rounded-md"
                    />
                    <div className="text-[10px] text-zinc-300 truncate mt-1">{c.name}</div>
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={pickFile}
              className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-300 hover:text-white px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors"
            >
              <ImageIcon className="h-3 w-3" />
              {customImagePath ? customImagePath.split(/[\\/]/).pop() : 'Or pick an image file…'}
            </button>
          </div>

          <div>
            <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Model</label>
            <div className="mt-2 space-y-1.5">
              {RECAST_MODEL_OPTIONS.map((m) => (
                <label
                  key={m.id}
                  className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                    model === m.id ? 'border-emerald-400 bg-emerald-500/5' : 'border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  <input
                    type="radio"
                    checked={model === m.id}
                    onChange={() => { setModel(m.id); setResolution(m.defaultResolution) }}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm text-white">{m.label}</span>
                    <span className="block text-[11px] text-zinc-500">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Resolution</label>
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-2 text-xs text-zinc-200"
            >
              {modelOption.resolutions.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          <label className="flex items-start gap-2 text-[11px] text-zinc-400 cursor-pointer">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
            <span>
              I have the rights to this footage and any consent needed from people appearing in it.
              Replacing a real person's likeness without consent violates the provider's terms.
            </span>
          </label>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="px-5 py-4 border-t border-zinc-800 flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs text-zinc-400 hover:text-white px-3 py-2">Cancel</button>
          <button
            onClick={submit}
            disabled={!chosenPath || !consent || submitting}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold px-3.5 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserRound className="h-3.5 w-3.5" />}
            Replace
          </button>
        </div>
      </div>
    </div>
  )
}
