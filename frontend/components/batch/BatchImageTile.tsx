import { RefreshCw, X, AlertTriangle } from 'lucide-react'
import type { CaptionTargetModel } from '@/lib/caption-api'
import { isCompatibleWithTarget, type AspectLabel } from '@/lib/aspect-ratio'

export interface BatchImage {
  id: string
  imagePath: string
  thumbnailUrl: string  // file:// URL for display
  width: number
  height: number
  aspectRatio: AspectLabel
  caption: string
  captioning: boolean
  captionError: string | null
  disposition: 'include' | 'skip' | 'crop'
}

interface BatchImageTileProps {
  image: BatchImage
  target: CaptionTargetModel
  onCaptionChange: (id: string, caption: string) => void
  onRegenerateCaption: (id: string) => void
  onRemove: (id: string) => void
  onDispositionChange: (id: string, disposition: BatchImage['disposition']) => void
}

export function BatchImageTile({
  image, target, onCaptionChange, onRegenerateCaption, onRemove, onDispositionChange,
}: BatchImageTileProps) {
  const compatible = isCompatibleWithTarget(image.aspectRatio, target)
  const showFlag = !compatible && image.disposition === 'include'

  return (
    <div
      className="rounded-lg overflow-hidden border flex flex-col"
      style={{ background: 'oklch(0.22 0.025 250)', borderColor: 'oklch(0.32 0.03 250)' }}
    >
      <div className="relative aspect-square bg-black">
        <img
          src={image.thumbnailUrl}
          alt={image.imagePath}
          className="w-full h-full object-contain"
        />
        <button
          onClick={() => onRemove(image.id)}
          title="Remove"
          className="absolute top-1 right-1 p-1 rounded-full bg-black/60 hover:bg-black/80 text-white"
        >
          <X className="w-3 h-3" />
        </button>
        {image.disposition === 'skip' && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <span className="text-xs font-medium text-white">SKIPPED</span>
          </div>
        )}
      </div>

      <div className="p-2 space-y-1.5 flex-1 flex flex-col">
        <div className="flex items-center justify-between text-[10px]" style={{ color: 'oklch(0.65 0.04 250)' }}>
          <span className="truncate">{image.imagePath.split(/[\\/]/).pop()}</span>
          <span>{image.width}×{image.height} · {image.aspectRatio}</span>
        </div>

        {showFlag && (
          <div
            className="flex flex-col gap-1 p-1.5 rounded border text-[11px]"
            style={{ background: 'oklch(0.3 0.15 30 / 0.3)', borderColor: 'oklch(0.6 0.2 30)' }}
          >
            <div className="flex items-center gap-1" style={{ color: 'oklch(0.85 0.15 30)' }}>
              <AlertTriangle className="w-3 h-3" />
              <span>Not compatible with {target}</span>
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => onDispositionChange(image.id, 'skip')}
                className="flex-1 px-1.5 py-0.5 rounded text-[10px]"
                style={{ background: 'oklch(0.25 0.02 250)', color: 'oklch(0.85 0.05 250)' }}
              >Skip</button>
              <button
                onClick={() => onDispositionChange(image.id, 'crop')}
                className="flex-1 px-1.5 py-0.5 rounded text-[10px]"
                style={{ background: 'oklch(0.25 0.02 250)', color: 'oklch(0.85 0.05 250)' }}
              >Auto-crop</button>
            </div>
          </div>
        )}
        {image.disposition === 'crop' && (
          <div className="text-[10px]" style={{ color: 'oklch(0.7 0.15 150)' }}>
            ✓ Will center-crop during generation
          </div>
        )}

        <textarea
          value={image.caption}
          onChange={e => onCaptionChange(image.id, e.target.value)}
          placeholder={image.captioning ? 'Captioning...' : 'Video prompt (motion, camera, action)'}
          disabled={image.captioning}
          rows={3}
          className="w-full rounded px-1.5 py-1 text-[11px] border resize-none flex-1"
          style={{ background: 'oklch(0.18 0.02 250)', borderColor: 'oklch(0.32 0.03 250)', color: 'oklch(0.92 0.02 250)' }}
        />

        {image.captionError && (
          <div className="text-[10px]" style={{ color: 'oklch(0.7 0.2 30)' }}>
            {image.captionError}
          </div>
        )}

        <button
          onClick={() => onRegenerateCaption(image.id)}
          disabled={image.captioning}
          className="flex items-center justify-center gap-1 py-1 rounded text-[10px] disabled:opacity-50"
          style={{ background: 'oklch(0.25 0.02 250)', color: 'oklch(0.75 0.05 250)' }}
        >
          <RefreshCw className={`w-3 h-3 ${image.captioning ? 'animate-spin' : ''}`} />
          Regenerate caption
        </button>
      </div>
    </div>
  )
}
