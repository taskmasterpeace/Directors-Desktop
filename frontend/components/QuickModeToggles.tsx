import { MapPin, Palette as StylePaletteIcon, Shirt, UserRound } from 'lucide-react'
import { QUICK_MODES, type QuickModeKind } from '../lib/shot-creator/quick-modes'

const ICONS: Record<QuickModeKind, React.ComponentType<{ className?: string }>> = {
  wardrobe: Shirt,
  character: UserRound,
  location: MapPin,
  style: StylePaletteIcon,
}

/**
 * The Wardrobe / Character / Location / Style toggle row (Palette Shot Creator
 * behavior): arming a mode is a click; the recipe — model, aspect, params,
 * mannequin, verbatim prompt — is applied behind the scenes at Generate.
 * Shared by Gen Space and the Playground so both surfaces behave identically.
 */
export function QuickModeToggles({
  active,
  onToggle,
  hasPhotos,
  onAddPhotos,
}: {
  active: QuickModeKind | null
  onToggle: (kind: QuickModeKind | null) => void
  /** True when at least one photo is attached anywhere (refs or edit slot). */
  hasPhotos: boolean
  onAddPhotos: () => void
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {(Object.keys(QUICK_MODES) as QuickModeKind[]).map((kind) => {
        const qm = QUICK_MODES[kind]
        const Icon = ICONS[kind]
        const isActive = active === kind
        return (
          <button
            key={kind}
            title={`${qm.hint} — click to toggle`}
            onClick={() => onToggle(isActive ? null : kind)}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${
              isActive
                ? 'bg-amber-500/20 border-amber-500/70 text-amber-300'
                : 'text-zinc-300 bg-zinc-800/70 border-zinc-700/60 hover:border-amber-500/50 hover:text-amber-300'
            }`}
          >
            <Icon className="h-3 w-3" />
            {qm.label}
          </button>
        )
      })}
      <button
        title="Add reference photo(s)"
        onClick={onAddPhotos}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-zinc-400 bg-zinc-800/40 border border-dashed border-zinc-700 hover:text-white hover:border-zinc-500 transition-colors"
      >
        + Reference image
      </button>
      {active && !hasPhotos && (
        <span className="text-[10px] text-amber-400/90">Attach photo(s) — the rest is automatic</span>
      )}
      {active && hasPhotos && (
        <span className="text-[10px] text-emerald-400/90">Photo attached — hit Generate, the rest is automatic</span>
      )}
    </div>
  )
}

/**
 * Apply an armed quick mode to a prompt + settings pair at submit time.
 * Returns the effective prompt and the setting overrides to spread in.
 */
export function applyQuickMode(
  kind: QuickModeKind,
  typedPrompt: string,
  attachedPhotos: string[],
): {
  prompt: string
  imageModel: string
  imageAspectRatio: string
  imageModelParams: Record<string, unknown>
  referenceImagePaths: string[]
} {
  const qm = QUICK_MODES[kind]
  const prompt =
    kind === 'wardrobe'
      ? qm.prompt // Palette ignores the typed prompt in wardrobe mode
      : typedPrompt.trim()
        ? `${qm.prompt}\n\nADDITIONAL NOTES: ${typedPrompt.trim()}`
        : qm.prompt
  return {
    prompt,
    imageModel: qm.modelId,
    imageAspectRatio: qm.aspectRatio,
    imageModelParams: { ...(qm.modelParams ?? {}) },
    referenceImagePaths: [...(qm.prependReferenceUrls ?? []), ...attachedPhotos.slice(0, qm.maxPhotos)],
  }
}
