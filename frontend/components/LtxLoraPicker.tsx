import { getLtxLora } from '../lib/ltx-loras'
import { toImgSrc } from '../lib/path-to-img-src'
import { useLtxLoras } from '../hooks/use-ltx-loras'

interface LtxLoraPickerProps {
  value?: string
  strength?: number
  onChange: (id: string | undefined, strength: number, trigger?: string | null) => void
  disabled?: boolean
}

/**
 * LoRA selector for the local LTX-2.3 engine. The chosen adapter is stacked on the
 * always-on distilled speed LoRA. Lists the curated registry PLUS any .safetensors
 * dropped into LTXDesktop/models/loras (with sidecar thumbnail + trigger words).
 * Gated adapters (object removal) render without effect until their file is present —
 * the engine skips a missing LoRA rather than failing — so the picker is honest
 * about what needs downloading first.
 */
export function LtxLoraPicker({ value, strength, onChange, disabled }: LtxLoraPickerProps) {
  const loras = useLtxLoras()
  const curated = loras.filter(l => !l.local)
  const locals = loras.filter(l => l.local)
  const selected = getLtxLora(value, loras)
  const s = strength ?? selected?.defaultStrength ?? 1.0

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-zinc-400">
        LoRA <span className="text-zinc-600">· stacked on the distilled speed LoRA</span>
      </label>
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={e => {
          const id = e.target.value || undefined
          const picked = getLtxLora(id, loras)
          onChange(id, picked?.defaultStrength ?? 1.0, picked?.trigger ?? null)
        }}
        className="w-full px-3 py-2 rounded-md bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 focus:border-amber-500 focus:outline-none transition-colors"
      >
        <option value="">None — base LTX</option>
        {curated.map(l => (
          <option key={l.id} value={l.id}>
            {l.label}{l.gated ? '  (needs HF access)' : ''}
          </option>
        ))}
        {locals.length > 0 && (
          <optgroup label="Local files — LTXDesktop/models/loras">
            {locals.map(l => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </optgroup>
        )}
      </select>

      {selected && (
        <div className="space-y-2 rounded-md bg-zinc-800/40 border border-zinc-700/50 p-2.5">
          <div className="flex gap-2.5">
            {selected.thumbnailPath && (
              <img
                src={toImgSrc(selected.thumbnailPath)}
                alt={selected.label}
                className="w-16 h-16 rounded object-cover border border-zinc-700/60 shrink-0"
              />
            )}
            <p className="text-xs text-zinc-400 leading-relaxed">{selected.description}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 w-16 shrink-0">Strength</span>
            <input
              type="range" min={0} max={1.5} step={0.05} value={s} disabled={disabled}
              onChange={e => onChange(value, parseFloat(e.target.value), selected.trigger ?? null)}
              className="flex-1 accent-amber-500"
            />
            <span className="text-xs tabular-nums text-zinc-300 w-9 text-right">{s.toFixed(2)}</span>
          </div>
          {selected.trigger && (
            <p className="text-xs text-zinc-500 leading-relaxed">
              Trigger words <span className="text-zinc-300 select-all">{selected.trigger}</span> are
              added to your prompt automatically.
            </p>
          )}
          {selected.gated && (
            <p className="text-xs text-amber-400/90 leading-relaxed">
              Gated model. Accept its license on HuggingFace and add an HF token, then it
              downloads on first use. Until then this pick renders without the LoRA.
              {selected.licenseUrl && (
                <span className="block mt-1 text-amber-300/70 break-all select-all">{selected.licenseUrl}</span>
              )}
            </p>
          )}
          {selected.needsControl && !selected.gated && (
            <p className="text-xs text-zinc-500 leading-relaxed">
              IC-LoRA — strongest with a control source (depth / pose / edge). A structural-control
              input is on the roadmap; for now it biases the base generation.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
