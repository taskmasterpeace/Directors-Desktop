import { useState } from 'react'
import { ChevronUp } from 'lucide-react'
import { getImageModel, listImageModelGroups } from '../lib/image-models'

/**
 * #77: pick a LOOK, not a model id. Outcome cards ("Best all-round",
 * "Re-shoot any angle") with the model name and price as fine print —
 * the registry's descriptions finally out of the tooltips.
 */
export function LookPicker({
  value,
  onChange,
  hasReplicateApiKey,
  editLabel,
}: {
  value: string
  onChange: (id: string) => void
  hasReplicateApiKey: boolean
  editLabel?: string | null
}) {
  const [open, setOpen] = useState(false)
  const current = getImageModel(value)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-zinc-800 transition-colors"
        title={current.description}
      >
        <span className="text-sm leading-none">{current.icon}</span>
        <span className="text-zinc-300 font-medium">
          {editLabel ? `${editLabel} · ` : ''}{current.outcome ?? current.displayName}
        </span>
        <ChevronUp className="h-3 w-3 text-zinc-500" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[88]" onClick={() => setOpen(false)} />
          <div className="absolute bottom-[calc(100%+8px)] right-0 z-[90] w-[540px] max-h-[440px] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-3">
            {listImageModelGroups().map((group) => (
              <div key={group.label} className="mb-3 last:mb-0">
                <div className="px-1 pb-1.5 text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
                  {group.label}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {group.models.map((m) => {
                    const needsKey = m.provider === 'replicate' && !hasReplicateApiKey
                    const active = m.id === value
                    return (
                      <button
                        key={m.id}
                        disabled={needsKey}
                        onClick={() => { onChange(m.id); setOpen(false) }}
                        title={needsKey ? 'Needs a Replicate API key in Settings' : undefined}
                        className={`text-left rounded-lg border p-2.5 transition-colors ${
                          active
                            ? 'border-amber-500 bg-amber-500/10'
                            : 'border-zinc-700/70 bg-zinc-950/50 hover:border-zinc-500 hover:bg-zinc-800/60'
                        } ${needsKey ? 'opacity-40 cursor-not-allowed' : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-base leading-none">{m.icon}</span>
                          <span className="text-xs font-semibold text-zinc-100">{m.outcome ?? m.displayName}</span>
                        </div>
                        <p className="mt-1 text-[11px] leading-snug text-zinc-400">{m.description}</p>
                        <p className="mt-1 text-[10px] text-zinc-500">
                          {m.displayName}
                          {m.provider === 'palette'
                            ? ` · ${m.costByQuality ? 'from ' : ''}${m.costPoints} pts`
                            : m.provider === 'local'
                              ? ' · free on your GPU'
                              : ' · your Replicate key'}
                        </p>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
