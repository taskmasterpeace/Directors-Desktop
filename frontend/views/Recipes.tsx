import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, Plus, Trash2, NotebookText, X, RefreshCw } from 'lucide-react'
import { useProjects } from '../contexts/ProjectContext'
import { LtxLogo } from '../components/LtxLogo'
import { Button } from '../components/ui/button'
import { logger } from '../lib/logger'

type Kind = 'all' | 'location' | 'wardrobe' | 'style' | 'character' | 'other'

interface Recipe {
  id: string
  name: string
  kind: Exclude<Kind, 'all'>
  text: string
  created_at: string
}

export function Recipes() {
  const { goHome } = useProjects()
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>('all')
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [formName, setFormName] = useState('')
  const [formKind, setFormKind] = useState<Exclude<Kind, 'all'>>('location')
  const [formText, setFormText] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchRecipes = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const query = kind !== 'all' ? `?kind=${kind}` : ''
      const res = await fetch(`${backendUrl}/api/library/recipes${query}`)
      if (!res.ok) throw new Error(`Failed to fetch recipes: ${res.status}`)
      const data = (await res.json()) as { recipes: Recipe[] }
      setRecipes(data.recipes ?? [])
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load recipes'
      logger.error(msg)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [kind])

  useEffect(() => {
    void fetchRecipes()
  }, [fetchRecipes])

  const openCreate = () => {
    setFormName('')
    setFormKind('location')
    setFormText('')
    setIsModalOpen(true)
  }

  const handleSave = async () => {
    if (!formName.trim() || !formText.trim()) return
    setSaving(true)
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const res = await fetch(`${backendUrl}/api/library/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          kind: formKind,
          text: formText.trim(),
        }),
      })
      if (!res.ok) throw new Error(`Create failed: ${res.status}`)
      setIsModalOpen(false)
      void fetchRecipes()
    } catch (e) {
      logger.error(`Failed to save recipe: ${e}`)
    } finally {
      setSaving(false)
    }
  }

  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  /**
   * Import the user's Directors Palette recipes (their own + the system catalog)
   * into the local library, so both apps share one recipe collection. Palette
   * categories map onto local kinds; the stage templates become the recipe text.
   */
  const handleSyncFromPalette = async () => {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const res = await fetch(`${backendUrl}/api/sync/library/recipes`)
      if (!res.ok) throw new Error(`Palette sync failed: ${res.status}`)
      const data = (await res.json()) as {
        connected?: boolean
        recipes?: { id?: string; name?: string; description?: string; category?: string }[]
        error?: string
      }
      if (!data.connected) {
        setSyncMsg('Sign in to Directors Palette first (Home → Sign In to Directors Palette).')
        return
      }
      const cloud = data.recipes ?? []
      if (cloud.length === 0) {
        setSyncMsg('No recipes in your Palette library yet.')
        return
      }
      const mapKind = (category?: string, name?: string): Exclude<Kind, 'all'> => {
        const n = (name ?? '').toLowerCase()
        if (n.includes('wardrobe')) return 'wardrobe'
        if (n.includes('location')) return 'location'
        switch (category) {
          case 'characters': return 'character'
          case 'scenes': return 'location'
          case 'styles': return 'style'
          default: return 'other'
        }
      }
      const existingNames = new Set(recipes.map((r) => r.name))
      let imported = 0
      let skipped = 0
      for (const r of cloud) {
        const name = `[Palette] ${r.name || 'recipe'}`
        if (existingNames.has(name) || !r.id) { skipped++; continue }
        try {
          // Fetch full stages for the template text.
          const detailRes = await fetch(`${backendUrl}/api/sync/library/recipes/${r.id}`)
          if (!detailRes.ok) throw new Error(`detail ${detailRes.status}`)
          const detail = (await detailRes.json()) as {
            stages?: { order?: number; template?: string }[]
          }
          const text = (detail.stages ?? [])
            .slice()
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((s) => s.template ?? '')
            .filter(Boolean)
            .join('\n\n--- next stage ---\n\n')
          if (!text.trim()) { skipped++; continue }
          const createRes = await fetch(`${backendUrl}/api/library/recipes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, kind: mapKind(r.category, r.name), text }),
          })
          if (!createRes.ok) throw new Error(`create ${createRes.status}`)
          imported++
        } catch (e) {
          logger.error(`Import Palette recipe failed: ${e}`)
          skipped++
        }
      }
      setSyncMsg(`Imported ${imported} recipe${imported === 1 ? '' : 's'} from Palette${skipped ? `, skipped ${skipped}` : ''}.`)
      void fetchRecipes()
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  const handleDelete = async (recipe: Recipe) => {
    if (!confirm(`Delete recipe "${recipe.name}"?`)) return
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const res = await fetch(`${backendUrl}/api/library/recipes/${recipe.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`)
      setRecipes(prev => prev.filter(r => r.id !== recipe.id))
    } catch (e) {
      logger.error(`Failed to delete recipe: ${e}`)
    }
  }

  const kinds: { label: string; value: Kind }[] = [
    { label: 'All', value: 'all' },
    { label: 'Locations', value: 'location' },
    { label: 'Wardrobe', value: 'wardrobe' },
    { label: 'Style', value: 'style' },
    { label: 'Characters', value: 'character' },
    { label: 'Other', value: 'other' },
  ]

  const kindColors: Record<string, string> = {
    location: 'bg-green-500/20 text-green-400',
    wardrobe: 'bg-amber-500/20 text-amber-400',
    style: 'bg-teal-500/20 text-teal-400',
    character: 'bg-blue-500/20 text-blue-400',
    other: 'bg-zinc-500/20 text-zinc-400',
  }

  return (
    <div className="h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 px-6 py-4 border-b border-zinc-800 shrink-0">
        <button
          onClick={goHome}
          className="h-8 w-8 flex items-center justify-center rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <LtxLogo className="h-5 w-auto text-white" />
        <span className="text-zinc-500 text-sm">/</span>
        <h1 className="text-lg font-semibold text-white">Recipes</h1>

        <div className="ml-auto flex items-center gap-2">
          {/* Kind filters */}
          <div className="flex items-center bg-zinc-900 rounded-lg border border-zinc-800 p-0.5">
            {kinds.map(k => (
              <button
                key={k.value}
                onClick={() => setKind(k.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  kind === k.value
                    ? 'bg-zinc-700 text-white'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            className="border-zinc-700 text-zinc-300"
            disabled={syncing}
            onClick={() => void handleSyncFromPalette()}
            title="Import your Directors Palette recipes (yours + the system catalog)"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync from Palette'}
          </Button>

          <Button onClick={openCreate} className="bg-blue-600 hover:bg-blue-500" size="sm">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Recipe
          </Button>
        </div>
      </header>

      {syncMsg && (
        <div className="px-6 py-2 text-xs text-zinc-300 bg-zinc-900 border-b border-zinc-800">{syncMsg}</div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="h-8 w-8 border-2 border-zinc-600 border-t-blue-500 rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <p className="text-zinc-400 mb-4">{error}</p>
            <Button variant="outline" onClick={() => void fetchRecipes()} className="border-zinc-700">
              Retry
            </Button>
          </div>
        ) : recipes.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-4">
              <NotebookText className="h-8 w-8 text-zinc-600" />
            </div>
            <h3 className="text-lg font-medium text-zinc-400 mb-2">No recipes yet</h3>
            <p className="text-zinc-500 mb-6">Save reusable location, wardrobe, and style snippets for your prompts</p>
            <Button onClick={openCreate} className="bg-blue-600 hover:bg-blue-500">
              <Plus className="h-4 w-4 mr-2" />
              Add Recipe
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {recipes.map(recipe => (
              <div
                key={recipe.id}
                className="group relative bg-zinc-900 rounded-lg border border-zinc-800 hover:border-zinc-600 transition-all p-3.5"
              >
                <div className="flex items-center gap-2">
                  <p className="text-sm text-white font-medium truncate flex-1">{recipe.name}</p>
                  <span className={`shrink-0 text-[10px] rounded px-1.5 py-0.5 font-medium ${kindColors[recipe.kind] ?? kindColors.style}`}>
                    {recipe.kind}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 mt-2 line-clamp-3">{recipe.text}</p>

                <button
                  onClick={() => void handleDelete(recipe)}
                  className="absolute top-2 right-2 p-1.5 rounded bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/80"
                >
                  <Trash2 className="h-3.5 w-3.5 text-white" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Recipe Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-zinc-900 rounded-xl p-6 w-full max-w-md border border-zinc-800">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-white">Add Recipe</h2>
              <button onClick={() => setIsModalOpen(false)} className="text-zinc-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="Recipe name"
                  className="w-full px-3 py-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500"
                  autoFocus
                />
              </div>

              <div>
                <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Kind</label>
                <div className="flex gap-2">
                  {(['location', 'wardrobe', 'style'] as const).map(k => (
                    <button
                      key={k}
                      onClick={() => setFormKind(k)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors capitalize ${
                        formKind === k
                          ? 'bg-blue-600/20 border-blue-500 text-blue-400'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                      }`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">Text</label>
                <textarea
                  value={formText}
                  onChange={e => setFormText(e.target.value)}
                  placeholder="The snippet inserted into your prompt, e.g. a neon-lit rooftop bar at night, rain-slick surfaces"
                  rows={4}
                  className="w-full px-3 py-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <Button
                variant="outline"
                onClick={() => setIsModalOpen(false)}
                className="flex-1 border-zinc-700"
              >
                Cancel
              </Button>
              <Button
                onClick={() => void handleSave()}
                disabled={!formName.trim() || !formText.trim() || saving}
                className="flex-1 bg-blue-600 hover:bg-blue-500"
              >
                {saving ? 'Saving...' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
