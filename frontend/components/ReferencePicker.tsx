import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Image as ImageIcon, Music, AlertTriangle } from 'lucide-react'
import { toImgSrc } from '../lib/path-to-img-src'
import { CAPS } from '../lib/positional-tags'

const TEAL = 'oklch(0.65 0.12 195)'
const AMBER = 'oklch(0.75 0.16 75)'
const POPOVER = 'oklch(0.18 0.02 250)'
const RAIL = 'oklch(0.15 0.015 250)'
const DP_BORDER = 'oklch(0.28 0.02 250)'

interface LibraryImage {
  path: string
  label: string
}

export interface ReferencePickerProps {
  model: string
  referenceImagePaths: string[]
  audioReferencePaths: string[]
  onChange: (next: { referenceImagePaths: string[]; audioReferencePaths: string[] }) => void
}

const isSeedance2 = (m: string) => m === 'seedance-2.0' || m === 'seedance-2.0-fast'

export function ReferencePicker({ model, referenceImagePaths, audioReferencePaths, onChange }: ReferencePickerProps) {
  const [open, setOpen] = useState(false)
  const [library, setLibrary] = useState<LibraryImage[]>([])
  const [loading, setLoading] = useState(false)
  const audioInputRef = useRef<HTMLInputElement>(null)

  const loadLibrary = useCallback(async () => {
    setLoading(true)
    try {
      const base = await window.electronAPI.getBackendUrl()
      const [charsRes, refsRes] = await Promise.all([
        fetch(`${base}/api/library/characters`),
        fetch(`${base}/api/library/references`),
      ])
      const images: LibraryImage[] = []
      if (charsRes.ok) {
        const data = await charsRes.json()
        for (const c of data.characters ?? []) {
          for (const p of c.reference_image_paths ?? []) images.push({ path: p, label: c.name })
        }
      }
      if (refsRes.ok) {
        const data = await refsRes.json()
        for (const r of data.references ?? []) {
          if (r.image_path) images.push({ path: r.image_path, label: r.name })
        }
      }
      setLibrary(images)
    } catch {
      setLibrary([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && library.length === 0) void loadLibrary()
  }, [open, library.length, loadLibrary])

  if (!isSeedance2(model)) return null

  const addImage = (path: string) => {
    if (referenceImagePaths.includes(path)) return
    if (referenceImagePaths.length >= CAPS.image) return
    onChange({ referenceImagePaths: [...referenceImagePaths, path], audioReferencePaths })
    setOpen(false)
  }
  const removeImage = (path: string) =>
    onChange({ referenceImagePaths: referenceImagePaths.filter((p) => p !== path), audioReferencePaths })
  const addAudio = (path: string) => {
    if (audioReferencePaths.includes(path) || audioReferencePaths.length >= CAPS.audio) return
    onChange({ referenceImagePaths, audioReferencePaths: [...audioReferencePaths, path] })
  }
  const removeAudio = (path: string) =>
    onChange({ referenceImagePaths, audioReferencePaths: audioReferencePaths.filter((p) => p !== path) })

  const onAudioFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] as (File & { path?: string }) | undefined
    if (file?.path) addAudio(file.path)
    if (audioInputRef.current) audioInputRef.current.value = ''
  }

  const audioNeedsImage = audioReferencePaths.length > 0 && referenceImagePaths.length === 0

  return (
    <div className="rounded-[0.625rem] p-2.5 mt-2" style={{ background: RAIL, border: `1px solid ${DP_BORDER}` }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-medium" style={{ color: '#d4d4d8' }}>
          Omni references <span style={{ color: '#71717a' }}>— up to 9 images · 3 audio</span>
        </span>
        <div className="flex gap-1.5">
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={referenceImagePaths.length >= CAPS.image}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] disabled:opacity-40"
            style={{ border: `1px solid ${DP_BORDER}`, color: AMBER }}
          >
            <ImageIcon className="h-3 w-3" /> Image
          </button>
          <button
            onClick={() => audioInputRef.current?.click()}
            disabled={audioReferencePaths.length >= CAPS.audio}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] disabled:opacity-40"
            style={{ border: `1px solid ${DP_BORDER}`, color: AMBER }}
          >
            <Music className="h-3 w-3" /> Audio
          </button>
          <input ref={audioInputRef} type="file" accept="audio/*" className="hidden" onChange={onAudioFile} />
        </div>
      </div>

      {(referenceImagePaths.length > 0 || audioReferencePaths.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {referenceImagePaths.map((p, i) => (
            <ChipImage key={p} src={toImgSrc(p)} tag={`@Image${i + 1}`} onRemove={() => removeImage(p)} />
          ))}
          {audioReferencePaths.map((p, i) => (
            <ChipAudio key={p} tag={`@Audio${i + 1}`} onRemove={() => removeAudio(p)} />
          ))}
        </div>
      )}

      {audioNeedsImage && (
        <div className="flex items-center gap-1.5 mt-2 text-[11px]" style={{ color: AMBER }}>
          <AlertTriangle className="h-3 w-3" /> Add at least one reference image to use audio.
        </div>
      )}

      {open && (
        <div className="mt-2 rounded-[0.625rem] p-2" style={{ background: POPOVER, border: `1px solid ${DP_BORDER}` }}>
          {loading ? (
            <div className="text-[11px] py-3 text-center" style={{ color: '#a1a1aa' }}>Loading library…</div>
          ) : library.length === 0 ? (
            <div className="text-[11px] py-3 text-center" style={{ color: '#a1a1aa' }}>
              No characters or references — add some in the Characters / References library.
            </div>
          ) : (
            <div className="grid grid-cols-5 gap-2 max-h-40 overflow-y-auto">
              {library.map((img) => (
                <button
                  key={img.path}
                  onClick={() => addImage(img.path)}
                  className="relative aspect-square rounded-md overflow-hidden"
                  style={{ border: `1px solid ${DP_BORDER}` }}
                  title={img.label}
                >
                  <img src={toImgSrc(img.path)} alt={img.label} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ChipImage({ src, tag, onRemove }: { src: string; tag: string; onRemove: () => void }) {
  return (
    <div className="relative rounded-md overflow-hidden" style={{ width: 64, height: 64, border: `1px solid ${DP_BORDER}` }}>
      <img src={src} alt={tag} className="w-full h-full object-cover" />
      <span className="absolute bottom-1 left-1 text-[9px] font-medium px-1 rounded" style={{ color: TEAL, background: '#0c0c10cc' }}>{tag}</span>
      <button onClick={onRemove} className="absolute top-0.5 right-0.5 rounded-full p-0.5" style={{ background: '#0c0c10cc', color: '#e4e4e7' }}>
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  )
}

function ChipAudio({ tag, onRemove }: { tag: string; onRemove: () => void }) {
  return (
    <div className="relative rounded-md flex flex-col items-center justify-center" style={{ width: 64, height: 64, background: '#1f2937', border: `1px solid ${DP_BORDER}` }}>
      <Music className="h-5 w-5" style={{ color: '#94a3b8' }} />
      <span className="absolute bottom-1 left-1 text-[9px] font-medium px-1 rounded" style={{ color: TEAL, background: '#0c0c10cc' }}>{tag}</span>
      <button onClick={onRemove} className="absolute top-0.5 right-0.5 rounded-full p-0.5" style={{ background: '#0c0c10cc', color: '#e4e4e7' }}>
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  )
}
