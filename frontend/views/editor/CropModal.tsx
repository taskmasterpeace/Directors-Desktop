import { useCallback, useEffect, useRef, useState } from 'react'
import { Crop as CropIcon, X, Check } from 'lucide-react'

/**
 * Crop a captured still before it becomes a reference — "take the screenshot,
 * crop it, then send it over." Aspect presets snap the crop box to the ratios
 * the video models actually output (16:9 / 9:16 / 1:1 / 21:9), plus free-form,
 * so a reference matches the target frame instead of surprising you later.
 *
 * Input is any image src (data:, file://, http). Output is a JPEG data URL of
 * the cropped region — the caller persists it exactly like a full frame.
 */

// [label, ratio = width/height]; null = free-form.
const ASPECTS: { label: string; ratio: number | null }[] = [
  { label: 'Free', ratio: null },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '1:1', ratio: 1 },
  { label: '21:9', ratio: 21 / 9 },
]

interface Box { x: number; y: number; w: number; h: number } // rendered px, relative to the image

export function CropModal({ src, onConfirm, onCancel }: {
  src: string
  onConfirm: (croppedDataUrl: string) => void
  onCancel: () => void
}) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [rendered, setRendered] = useState<{ w: number; h: number } | null>(null)
  const [aspect, setAspect] = useState<number | null>(16 / 9)
  const [box, setBox] = useState<Box | null>(null)
  const drag = useRef<{ mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; sx: number; sy: number; start: Box } | null>(null)

  // Center a crop box of the given aspect inside the rendered image.
  const centeredBox = useCallback((r: { w: number; h: number }, a: number | null): Box => {
    if (a === null) {
      const w = r.w * 0.8, h = r.h * 0.8
      return { x: (r.w - w) / 2, y: (r.h - h) / 2, w, h }
    }
    // Largest a-ratio box that fits within 90% of the image.
    let w = r.w * 0.9
    let h = w / a
    if (h > r.h * 0.9) { h = r.h * 0.9; w = h * a }
    return { x: (r.w - w) / 2, y: (r.h - h) / 2, w, h }
  }, [])

  const onImgLoad = useCallback(() => {
    const el = imgRef.current
    if (!el) return
    const r = { w: el.clientWidth, h: el.clientHeight }
    setRendered(r)
    setBox(centeredBox(r, aspect))
  }, [aspect, centeredBox])

  // Re-fit the box when the aspect preset changes.
  useEffect(() => {
    if (rendered) setBox(centeredBox(rendered, aspect))
  }, [aspect, rendered, centeredBox])

  const clampBox = useCallback((b: Box, r: { w: number; h: number }): Box => {
    const w = Math.min(b.w, r.w)
    const h = Math.min(b.h, r.h)
    const x = Math.max(0, Math.min(b.x, r.w - w))
    const y = Math.max(0, Math.min(b.y, r.h - h))
    return { x, y, w, h }
  }, [])

  useEffect(() => {
    if (!drag.current) return
    const move = (e: MouseEvent) => {
      const d = drag.current
      if (!d || !rendered) return
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      if (d.mode === 'move') {
        setBox(clampBox({ ...d.start, x: d.start.x + dx, y: d.start.y + dy }, rendered))
        return
      }
      // Corner resize. Keep the opposite corner fixed; honor aspect lock.
      let { x, y, w, h } = d.start
      const right = x + w, bottom = y + h
      if (d.mode === 'se') { w = d.start.w + dx; h = aspect ? w / aspect : d.start.h + dy }
      else if (d.mode === 'sw') { w = d.start.w - dx; x = right - w; h = aspect ? w / aspect : d.start.h + dy }
      else if (d.mode === 'ne') { w = d.start.w + dx; h = aspect ? w / aspect : d.start.h - dy; y = bottom - h }
      else if (d.mode === 'nw') { w = d.start.w - dx; x = right - w; h = aspect ? w / aspect : d.start.h - dy; y = bottom - h }
      if (w < 24 || h < 24) return
      setBox(clampBox({ x, y, w, h }, rendered))
    }
    const up = () => { drag.current = null }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [rendered, aspect, clampBox, box])

  const startDrag = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    if (!box) return
    drag.current = { mode, sx: e.clientX, sy: e.clientY, start: box }
    // nudge state so the effect re-subscribes with the fresh drag ref
    setBox({ ...box })
  }

  const confirm = () => {
    const el = imgRef.current
    if (!el || !box || !rendered) return
    const scale = el.naturalWidth / rendered.w // rendered px → source px (uniform, object-contain fit)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(box.w * scale))
    canvas.height = Math.max(1, Math.round(box.h * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(el, box.x * scale, box.y * scale, box.w * scale, box.h * scale, 0, 0, canvas.width, canvas.height)
    onConfirm(canvas.toDataURL('image/jpeg', 0.92))
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70" onMouseDown={onCancel}>
      <div className="w-[min(90vw,860px)] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl flex flex-col" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <CropIcon className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-semibold text-white">Crop reference</span>
          </div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-zinc-700 text-zinc-400"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-zinc-800/60">
          <span className="text-[10px] text-zinc-500 mr-1">Aspect:</span>
          {ASPECTS.map((a) => (
            <button
              key={a.label}
              onClick={() => setAspect(a.ratio)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                aspect === a.ratio ? 'bg-cyan-500 text-zinc-950 font-semibold' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>

        <div className="relative p-4 flex items-center justify-center bg-zinc-950/60" style={{ minHeight: 320 }}>
          <div className="relative inline-block select-none">
            <img ref={imgRef} src={src} onLoad={onImgLoad} alt="" className="max-h-[60vh] max-w-full block" draggable={false} />
            {box && rendered && (
              <>
                {/* dim outside the crop */}
                <div className="absolute inset-0 pointer-events-none" style={{
                  boxShadow: `0 0 0 9999px rgba(0,0,0,0.55)`,
                  clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${box.x}px ${box.y}px, ${box.x}px ${box.y + box.h}px, ${box.x + box.w}px ${box.y + box.h}px, ${box.x + box.w}px ${box.y}px, ${box.x}px ${box.y}px)`,
                }} />
                <div
                  className="absolute border-2 border-cyan-400 cursor-move"
                  style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                  onMouseDown={startDrag('move')}
                >
                  {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                    <div
                      key={corner}
                      onMouseDown={startDrag(corner)}
                      className="absolute w-3 h-3 bg-cyan-400 rounded-sm"
                      style={{
                        cursor: `${corner}-resize`,
                        left: corner.includes('w') ? -6 : undefined,
                        right: corner.includes('e') ? -6 : undefined,
                        top: corner.includes('n') ? -6 : undefined,
                        bottom: corner.includes('s') ? -6 : undefined,
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-800">
          <span className="text-[11px] text-zinc-500">Drag to move · corners to resize · a preset locks the ratio</span>
          <div className="flex gap-2">
            <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
            <button onClick={confirm} className="flex items-center gap-1.5 rounded-md bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-500">
              <Check className="h-3.5 w-3.5" /> Use crop
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
