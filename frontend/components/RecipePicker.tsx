import { useEffect, useState } from 'react'
import { BookOpen } from 'lucide-react'

const POPOVER = 'oklch(0.18 0.02 250)'
const RAIL = 'oklch(0.15 0.015 250)'
const DP_BORDER = 'oklch(0.28 0.02 250)'
const AMBER = 'oklch(0.75 0.16 75)'

type RecipeKind = 'location' | 'wardrobe' | 'style'

interface Recipe {
  id: string
  name: string
  kind: RecipeKind
  text: string
  created_at: string
}

const KIND_SECTIONS: { kind: RecipeKind; heading: string; color: string }[] = [
  { kind: 'location', heading: 'Location', color: 'text-green-400' },
  { kind: 'wardrobe', heading: 'Wardrobe', color: 'text-amber-400' },
  { kind: 'style', heading: 'Style', color: 'text-teal-400' },
]

/** Insert text at the textarea caret (falls back to appending with a leading space). */
export function insertAtCaret(el: HTMLTextAreaElement | null, current: string, text: string): string {
  if (!el) return current ? `${current} ${text}` : text
  const start = el.selectionStart ?? current.length
  const end = el.selectionEnd ?? start
  const next = current.slice(0, start) + text + current.slice(end)
  const pos = start + text.length
  requestAnimationFrame(() => {
    el.focus()
    el.setSelectionRange(pos, pos)
  })
  return next
}

export interface RecipePickerProps {
  onInsert: (text: string) => void
  /** Which way the popover opens relative to the button (bottom-anchored bars open up). */
  direction?: 'up' | 'down'
}

export function RecipePicker({ onInsert, direction = 'down' }: RecipePickerProps) {
  const [open, setOpen] = useState(false)
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const base = await window.electronAPI.getBackendUrl()
        const res = await fetch(`${base}/api/library/recipes`)
        if (!res.ok) throw new Error(`status ${res.status}`)
        const data = (await res.json()) as { recipes: Recipe[] }
        if (!cancelled) setRecipes(data.recipes ?? [])
      } catch {
        // A failed fetch is not an empty library — show a distinct error state.
        if (!cancelled) {
          setRecipes([])
          setLoadError(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [open])

  const pick = (recipe: Recipe) => {
    onInsert(recipe.text)
    setOpen(false)
  }

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px]"
        style={{ border: `1px solid ${DP_BORDER}`, color: AMBER }}
        title="Insert a saved location / wardrobe / style recipe into the prompt"
      >
        <BookOpen className="h-3 w-3" /> Recipes
      </button>

      {open && (
        <div
          className={`absolute left-0 z-50 w-72 rounded-[0.625rem] p-2 ${direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'}`}
          style={{ background: POPOVER, border: `1px solid ${DP_BORDER}` }}
        >
          {loading ? (
            <div className="text-[11px] py-3 text-center" style={{ color: '#a1a1aa' }}>Loading recipes…</div>
          ) : loadError ? (
            <div className="text-[11px] py-3 text-center text-red-400">
              Couldn’t load recipes — is the backend running?
            </div>
          ) : recipes.length === 0 ? (
            <div className="text-[11px] py-3 text-center" style={{ color: '#a1a1aa' }}>
              No recipes yet — add some in the Recipes library.
            </div>
          ) : (
            <div className="max-h-56 overflow-y-auto space-y-2">
              {KIND_SECTIONS.map(({ kind, heading, color }) => {
                const items = recipes.filter((r) => r.kind === kind)
                if (items.length === 0) return null
                return (
                  <div key={kind}>
                    <div className={`px-1 mb-1 text-[10px] font-semibold uppercase tracking-wider ${color}`}>
                      {heading}
                    </div>
                    <div className="space-y-1">
                      {items.map((recipe) => (
                        <button
                          key={recipe.id}
                          onClick={() => pick(recipe)}
                          className="w-full text-left px-2 py-1.5 rounded-md"
                          style={{ background: RAIL, border: `1px solid ${DP_BORDER}` }}
                          title={recipe.text}
                        >
                          <span className="block text-[11px] font-medium truncate" style={{ color: '#e4e4e7' }}>
                            {recipe.name}
                          </span>
                          <span className="block text-[10px] truncate" style={{ color: '#a1a1aa' }}>
                            {recipe.text}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
