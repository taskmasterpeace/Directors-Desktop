import { useCallback, useEffect, useState } from 'react'
import { Upload, Sparkles } from 'lucide-react'
import type { BatchSubmitRequest, BatchJobItem } from '@/types/batch'
import type { CaptionTargetModel } from '@/lib/caption-api'
import { detectAspectRatio, suggestCompatibleRatio } from '@/lib/aspect-ratio'
import { useBatchCaptioner } from '@/hooks/use-batch-captioner'
import { BatchImageTile, type BatchImage } from './BatchImageTile'

export interface BatchAnimateTabProps {
  target: 'local' | 'cloud'
  onSubmit: (request: BatchSubmitRequest) => void
  isRunning: boolean
  // Optional: pre-loaded images from a Prompts → Images batch result
  initialImagePaths?: string[]
}

let tileIdCounter = 0
function nextTileId(): string {
  return `tile_${++tileIdCounter}`
}

const VIDEO_DURATIONS = [2, 3, 4, 5, 6, 8, 10] as const
const VIDEO_FPS = [24, 25, 30] as const
const CAMERA_MOTIONS = ['none', 'static', 'dolly_in', 'dolly_out', 'jib_up', 'jib_down'] as const

async function readImageDimensions(fileUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error(`Could not load image: ${fileUrl}`))
    img.src = fileUrl
  })
}

function pathToFileUrl(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

export function BatchAnimateTab({ target, onSubmit, isRunning, initialImagePaths }: BatchAnimateTabProps) {
  const [tiles, setTiles] = useState<BatchImage[]>([])
  const [targetModel, setTargetModel] = useState<CaptionTargetModel>('ltx-fast')
  const [duration, setDuration] = useState<number>(5)
  const [fps, setFps] = useState<number>(24)
  const [cameraMotion, setCameraMotion] = useState<string>('none')
  const [resolution, setResolution] = useState<string>('512p')
  const captioner = useBatchCaptioner()

  const addImagesFromPaths = useCallback(async (paths: string[]) => {
    const newTiles: BatchImage[] = []
    for (const p of paths) {
      try {
        const fileUrl = pathToFileUrl(p)
        const { width, height } = await readImageDimensions(fileUrl)
        const aspectRatio = detectAspectRatio(width, height)
        newTiles.push({
          id: nextTileId(),
          imagePath: p,
          thumbnailUrl: fileUrl,
          width,
          height,
          aspectRatio,
          caption: '',
          captioning: false,
          captionError: null,
          disposition: 'include',
        })
      } catch (err) {
        console.error('Failed to load', p, err)
      }
    }
    setTiles(prev => [...prev, ...newTiles])
  }, [])

  // Handle initial image paths (from Prompts tab handoff)
  const [hasLoadedInitial, setHasLoadedInitial] = useState(false)
  useEffect(() => {
    if (!hasLoadedInitial && initialImagePaths && initialImagePaths.length > 0) {
      setHasLoadedInitial(true)
      void addImagesFromPaths(initialImagePaths)
    }
  }, [hasLoadedInitial, initialImagePaths, addImagesFromPaths])

  const handleAddImages = async () => {
    const paths = await window.electronAPI.showOpenFileDialog({
      title: 'Select images to animate',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (paths && paths.length > 0) {
      await addImagesFromPaths(paths)
    }
  }

  const updateTile = useCallback((id: string, updates: Partial<BatchImage>) => {
    setTiles(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t))
  }, [])

  const handleCaptionChange = (id: string, caption: string) => updateTile(id, { caption })
  const handleRemove = (id: string) => setTiles(prev => prev.filter(t => t.id !== id))
  const handleDispositionChange = (id: string, disposition: BatchImage['disposition']) =>
    updateTile(id, { disposition })

  const handleCaptionAll = async () => {
    const items = tiles
      .filter(t => t.disposition !== 'skip')
      .map(t => ({ id: t.id, imagePath: t.imagePath }))
    if (items.length === 0) return

    items.forEach(i => updateTile(i.id, { captioning: true, captionError: null }))

    await captioner.captionAll(
      items,
      targetModel,
      (id, caption) => updateTile(id, { caption, captioning: false }),
      (id, error) => updateTile(id, { captionError: error, captioning: false }),
    )
  }

  const handleRegenerateOne = async (id: string) => {
    const tile = tiles.find(t => t.id === id)
    if (!tile) return
    updateTile(id, { captioning: true, captionError: null })
    await captioner.captionAll(
      [{ id, imagePath: tile.imagePath }],
      targetModel,
      (tid, caption) => updateTile(tid, { caption, captioning: false }),
      (tid, error) => updateTile(tid, { captionError: error, captioning: false }),
    )
  }

  const handleClearAll = () => setTiles([])

  const activeTiles = tiles.filter(t => t.disposition !== 'skip')
  const canRun = activeTiles.length > 0 && activeTiles.every(t => t.caption.trim().length > 0)

  const handleSubmit = () => {
    const jobs: BatchJobItem[] = activeTiles.map(tile => {
      // For crop: use suggested compatible ratio; backend _prepare_image handles actual crop
      const effectiveRatio = tile.disposition === 'crop'
        ? suggestCompatibleRatio(tile.width, tile.height, targetModel)
        : tile.aspectRatio
      return {
        type: 'video',
        model: targetModel,
        params: {
          prompt: tile.caption,
          imagePath: tile.imagePath,
          duration: String(duration),
          resolution,
          fps: String(fps),
          cameraMotion,
          aspectRatio: effectiveRatio,
          audio: 'false',
        },
      }
    })
    const request: BatchSubmitRequest = { mode: 'list', target, jobs }
    onSubmit(request)
  }

  return (
    <div className="space-y-3">
      {/* Top bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 250)' }}>Animate with</label>
          <select
            value={targetModel}
            onChange={e => setTargetModel(e.target.value as CaptionTargetModel)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 250)', borderColor: 'oklch(0.32 0.03 250)', color: 'oklch(0.92 0.02 250)' }}
          >
            <option value="ltx-fast">LTX-2 Fast (local)</option>
            <option value="seedance-1.5-pro">Seedance 1.5 Pro (cloud)</option>
          </select>
        </div>
        <button
          onClick={handleAddImages}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium self-end"
          style={{ background: 'oklch(0.22 0.025 250)', border: '1px solid oklch(0.32 0.03 250)', color: 'oklch(0.92 0.02 250)' }}
        >
          <Upload className="w-4 h-4" /> Add images
        </button>
        <button
          onClick={handleClearAll}
          disabled={tiles.length === 0}
          className="px-3 py-2 rounded-lg text-sm self-end disabled:opacity-40"
          style={{ background: 'oklch(0.22 0.025 250)', border: '1px solid oklch(0.32 0.03 250)', color: 'oklch(0.65 0.04 250)' }}
        >
          Clear all
        </button>
      </div>

      {/* Auto-caption bar */}
      {tiles.length > 0 && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleCaptionAll}
            disabled={captioner.progress.running}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            style={{ background: 'oklch(0.6 0.2 250 / 0.3)', color: 'oklch(0.85 0.1 250)', border: '1px solid oklch(0.6 0.2 250 / 0.5)' }}
          >
            <Sparkles className="w-4 h-4" />
            Generate prompts for all
          </button>
          {captioner.progress.running && (
            <span className="text-xs" style={{ color: 'oklch(0.65 0.04 250)' }}>
              Captioning {captioner.progress.completed + captioner.progress.failed} of {captioner.progress.total}...
            </span>
          )}
        </div>
      )}

      {/* Grid */}
      {tiles.length === 0 ? (
        <div
          className="h-48 rounded-lg border-dashed border-2 flex flex-col items-center justify-center gap-1 text-sm"
          style={{ borderColor: 'oklch(0.32 0.03 250)', color: 'oklch(0.55 0.04 250)' }}
        >
          <span>Click "Add images" to get started</span>
          <span className="text-[11px]">Tip: generate a batch in the Prompts tab first, then add those images here from the gallery</span>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 max-h-[50vh] overflow-y-auto pr-1">
          {tiles.map(tile => (
            <BatchImageTile
              key={tile.id}
              image={tile}
              target={targetModel}
              onCaptionChange={handleCaptionChange}
              onRegenerateCaption={handleRegenerateOne}
              onRemove={handleRemove}
              onDispositionChange={handleDispositionChange}
            />
          ))}
        </div>
      )}

      {/* Video settings */}
      <div className="grid grid-cols-4 gap-2">
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 250)' }}>Duration (s)</label>
          <select value={duration} onChange={e => setDuration(Number(e.target.value))}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 250)', borderColor: 'oklch(0.32 0.03 250)', color: 'oklch(0.92 0.02 250)' }}>
            {VIDEO_DURATIONS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 250)' }}>FPS</label>
          <select value={fps} onChange={e => setFps(Number(e.target.value))}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 250)', borderColor: 'oklch(0.32 0.03 250)', color: 'oklch(0.92 0.02 250)' }}>
            {VIDEO_FPS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 250)' }}>Resolution</label>
          <select value={resolution} onChange={e => setResolution(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 250)', borderColor: 'oklch(0.32 0.03 250)', color: 'oklch(0.92 0.02 250)' }}>
            <option value="512p">512p</option>
            <option value="720p">720p</option>
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 250)' }}>Camera motion</label>
          <select value={cameraMotion} onChange={e => setCameraMotion(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 250)', borderColor: 'oklch(0.32 0.03 250)', color: 'oklch(0.92 0.02 250)' }}>
            {CAMERA_MOTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={!canRun || isRunning}
        className="w-full py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50"
        style={{ background: 'oklch(0.6 0.2 250)', color: 'oklch(0.98 0.01 250)' }}
      >
        {!canRun && tiles.length > 0
          ? 'All active tiles need a caption'
          : `Animate ${activeTiles.length} video${activeTiles.length === 1 ? '' : 's'}`}
      </button>
    </div>
  )
}
