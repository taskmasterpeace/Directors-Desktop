import { useRef, useState, useMemo, useEffect } from 'react'
import { Upload } from 'lucide-react'
import { parseBlankLineSeparated } from '@/lib/batch-import'
import type { BatchSubmitRequest, BatchJobItem } from '@/types/batch'

type SeedMode = 'locked' | 'random' | 'sequential'
type Variations = 1 | 2 | 4

export interface BatchPromptsTabProps {
  target: 'local' | 'cloud'
  onSubmit: (request: BatchSubmitRequest) => void
  isRunning: boolean
}

// Image models supported in batch mode
const IMAGE_MODELS = [
  { value: 'flux-klein-9b', label: 'FLUX.2 Klein 9B' },
  { value: 'flux-dev', label: 'FLUX.1 Dev' },
  { value: 'z-image-turbo', label: 'Z-Image Turbo' },
  { value: 'nano-banana-2', label: 'Nano Banana 2' },
] as const

// All aspect ratios for image gen
const ALL_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5', '21:9'] as const
// Restricted set when "for animation" toggle is on
const ANIMATION_ASPECT_RATIOS = ['16:9', '9:16'] as const

const RESOLUTIONS = ['1080p', '1440p', '2048p'] as const

export function BatchPromptsTab({ target, onSubmit, isRunning }: BatchPromptsTabProps) {
  const [text, setText] = useState('')
  const [model, setModel] = useState<string>('flux-klein-9b')
  const [loraPath, setLoraPath] = useState('')
  const [loraWeight, _setLoraWeight] = useState(1.0)
  const [resolution, setResolution] = useState<string>('1080p')
  const [aspectRatio, setAspectRatio] = useState<string>('16:9')
  const [steps, setSteps] = useState(28)
  const [variations, setVariations] = useState<Variations>(1)
  const [seedMode, setSeedMode] = useState<SeedMode>('locked')
  const [baseSeed, setBaseSeed] = useState(42)
  const [forAnimation, setForAnimation] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const prompts = useMemo(() => parseBlankLineSeparated(text), [text])
  const totalImages = prompts.length * variations

  const availableAspects: readonly string[] = forAnimation
    ? ANIMATION_ASPECT_RATIOS
    : ALL_ASPECT_RATIOS

  // If the user flips the toggle on and current aspect is incompatible, snap to 16:9
  useEffect(() => {
    if (forAnimation && !ANIMATION_ASPECT_RATIOS.includes(aspectRatio as '16:9' | '9:16')) {
      setAspectRatio('16:9')
    }
  }, [forAnimation, aspectRatio])

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setText(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  const computeDimensions = (): { width: number; height: number } => {
    const shortSide = resolution === '1080p' ? 1080 : resolution === '1440p' ? 1440 : 2048
    const ratioMap: Record<string, number> = {
      '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3,
      '3:4': 3 / 4, '4:5': 4 / 5, '21:9': 21 / 9,
    }
    const ratio = ratioMap[aspectRatio] ?? 1
    return ratio >= 1
      ? { width: Math.round(shortSide * ratio), height: shortSide }
      : { width: shortSide, height: Math.round(shortSide / ratio) }
  }

  const computeSeed = (index: number): number => {
    if (seedMode === 'locked') return baseSeed
    if (seedMode === 'sequential') return baseSeed + index
    // random
    return Math.floor(Math.random() * 2_147_483_647)
  }

  const handleSubmit = () => {
    if (prompts.length === 0) return
    const dims = computeDimensions()
    const jobs: BatchJobItem[] = []
    let jobIndex = 0
    for (const prompt of prompts) {
      for (let v = 0; v < variations; v++) {
        jobs.push({
          type: 'image',
          model,
          params: {
            prompt,
            width: dims.width,
            height: dims.height,
            numSteps: steps,
            numImages: 1,
            seed: computeSeed(jobIndex),
            ...(loraPath ? { loraPath, loraWeight } : {}),
          },
        })
        jobIndex++
      }
    }
    const request: BatchSubmitRequest = { mode: 'list', target, jobs }
    onSubmit(request)
  }

  return (
    <div className="space-y-4">
      {/* Load from file */}
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium" style={{ color: 'oklch(0.75 0.05 290)' }}>
          Prompts (separate with blank lines)
        </label>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style={{
            background: 'oklch(0.22 0.025 290)',
            color: 'oklch(0.75 0.05 290)',
            border: '1px solid oklch(0.32 0.03 290)',
          }}
        >
          <Upload className="w-3.5 h-3.5" />
          Load from .txt
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,text/plain"
          onChange={handleFileUpload}
          className="hidden"
        />
      </div>

      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={12}
        placeholder={'A cinematic wide shot of...\n\nA close-up of...\n\nA gritty noir detective...'}
        className="w-full rounded-lg px-3 py-2 text-sm font-mono border"
        style={{
          background: 'oklch(0.22 0.025 290)',
          borderColor: 'oklch(0.32 0.03 290)',
          color: 'oklch(0.92 0.02 290)',
        }}
      />

      <div className="text-xs" style={{ color: 'oklch(0.65 0.04 290)' }}>
        {prompts.length === 0
          ? 'No prompts yet — paste some text above'
          : `${prompts.length} prompt${prompts.length === 1 ? '' : 's'} detected`}
      </div>

      {/* Settings grid */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Model</label>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            {IMAGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Resolution</label>
          <select
            value={resolution}
            onChange={e => setResolution(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Aspect ratio</label>
          <select
            value={aspectRatio}
            onChange={e => setAspectRatio(e.target.value)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            {availableAspects.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Steps</label>
          <input
            type="number"
            value={steps}
            onChange={e => setSteps(Math.max(1, Math.min(100, Number(e.target.value))))}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          />
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Variations per prompt</label>
          <select
            value={variations}
            onChange={e => setVariations(Number(e.target.value) as Variations)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={4}>4</option>
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>Seed mode</label>
          <select
            value={seedMode}
            onChange={e => setSeedMode(e.target.value as SeedMode)}
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          >
            <option value="locked">Locked (same every job)</option>
            <option value="sequential">Sequential (base+i)</option>
            <option value="random">Random</option>
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>
            {seedMode === 'sequential' ? 'Base seed' : seedMode === 'locked' ? 'Seed' : 'Seed (ignored)'}
          </label>
          <input
            type="number"
            value={baseSeed}
            onChange={e => setBaseSeed(Math.max(0, Math.min(2_147_483_647, Number(e.target.value))))}
            disabled={seedMode === 'random'}
            className="w-full rounded-lg px-2 py-1.5 text-sm border disabled:opacity-50"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          />
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'oklch(0.65 0.04 290)' }}>LoRA path (optional)</label>
          <input
            value={loraPath}
            onChange={e => setLoraPath(e.target.value)}
            placeholder="E:\fluxdev\my_lora.safetensors"
            className="w-full rounded-lg px-2 py-1.5 text-sm border"
            style={{ background: 'oklch(0.22 0.025 290)', borderColor: 'oklch(0.32 0.03 290)', color: 'oklch(0.92 0.02 290)' }}
          />
        </div>
      </div>

      {/* Animation lock toggle */}
      <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'oklch(0.75 0.05 290)' }}>
        <input
          type="checkbox"
          checked={forAnimation}
          onChange={e => setForAnimation(e.target.checked)}
        />
        These images are for animation — restrict aspect ratio to 16:9 / 9:16
      </label>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={prompts.length === 0 || isRunning}
        className="w-full py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
        style={{
          background: 'oklch(0.6 0.2 290)',
          color: 'oklch(0.98 0.01 290)',
        }}
      >
        {variations > 1
          ? `Generate ${totalImages} images (${prompts.length} prompts × ${variations})`
          : `Generate ${totalImages} image${totalImages === 1 ? '' : 's'}`}
      </button>
    </div>
  )
}
