import { useState, useEffect, useCallback, useMemo } from 'react'
import { ArrowLeft, Image as ImageIcon, Film, Trash2, Download, X, ChevronLeft, ChevronRight, Sparkles , UserPlus, Images, FolderInput, Check } from 'lucide-react'
import { useConfirm } from '../components/ConfirmDialog'
import { SaveToLibraryModal, type SaveToLibraryRequest } from '../components/SaveToLibraryModal'
import { useProjects } from '../contexts/ProjectContext'
import { LtxLogo } from '../components/LtxLogo'
import { Button } from '../components/ui/button'
import { logger } from '../lib/logger'

type FilterType = 'all' | 'images' | 'videos'

interface GalleryItem {
  id: string
  filename: string
  path: string
  type: 'image' | 'video'
  url: string
  thumbnail?: string
  model_name?: string
  size_bytes?: number
  created_at: string
  prompt?: string | null
}

interface GalleryResponse {
  items: GalleryItem[]
  total: number
  page: number
  per_page: number
  total_pages: number
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(dateStr: string): string {
  const secs = parseFloat(dateStr)
  const date = isNaN(secs) ? new Date(dateStr) : new Date(secs * 1000)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

// #73: readable default name from an output filename.
function suggestFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
  return stem ? stem[0].toUpperCase() + stem.slice(1, 40) : ''
}

export function Gallery() {
  const { goHome, setPendingAnimateImage, openPlayground , setPendingRemix, projects, addAsset } = useProjects()
  const [filter, setFilter] = useState<FilterType>('all')
  // Ownership (project management Phase 2): queue jobs carry tags like
  // "project:<id>" / "playground" / "director"; matching a gallery file back
  // to its job by filename tells us which surface made it.
  const [ownership, setOwnership] = useState<Record<string, string[]>>({})
  const [ownerFilter, setOwnerFilter] = useState<string>('all')
  const [sendItem, setSendItem] = useState<GalleryItem | null>(null)
  const [sentIds, setSentIds] = useState<Set<string>>(new Set())
  const [items, setItems] = useState<GalleryItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [previewItem, setPreviewItem] = useState<GalleryItem | null>(null)
  const [backendUrl, setBackendUrl] = useState<string>('')

  const perPage = 200

  useEffect(() => {
    window.electronAPI.getBackendUrl().then(setBackendUrl).catch(() => {})
  }, [])

  // Resolve a gallery item URL to an absolute URL
  const resolveUrl = useCallback((url: string) => {
    if (url.startsWith('http') || url.startsWith('file:')) return url
    return `${backendUrl}${url}`
  }, [backendUrl])

  // Media src for an item. Local files render via the streaming file:// protocol
  // (MIME + Range) instead of backend HTTP: <img>/<video> resource loads bypass
  // the fetch auth interceptor, so backend URLs 401 and the grid looks empty
  // even though the files are right there on disk.
  const mediaSrc = useCallback((item: GalleryItem) => {
    if (item.path) return pathToFileUrl(item.path)
    return resolveUrl(item.thumbnail || item.url)
  }, [resolveUrl])

  const fetchGallery = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = backendUrl || await window.electronAPI.getBackendUrl()
      // Backend filters on singular "image"/"video" — the tab values are plural.
      const typeParam = filter === 'images' ? 'image' : filter === 'videos' ? 'video' : 'all'
      const res = await fetch(`${url}/api/gallery/local?page=${page}&per_page=${perPage}&type=${typeParam}`)
      if (!res.ok) throw new Error(`Failed to fetch gallery: ${res.status}`)
      const data = (await res.json()) as GalleryResponse
      setItems(data.items)
      setTotal(data.total)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load gallery'
      logger.error(msg)
      setError(msg)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [backendUrl, page, filter])

  useEffect(() => {
    void fetchGallery()
  }, [fetchGallery])

  // Build filename -> tags from the queue history (jobs record result paths).
  useEffect(() => {
    void (async () => {
      try {
        const url = backendUrl || await window.electronAPI.getBackendUrl()
        const res = await fetch(`${url}/api/queue/status`)
        if (!res.ok) return
        const data = (await res.json()) as { jobs?: Array<{ tags?: string[]; result_paths?: string[] }> }
        const map: Record<string, string[]> = {}
        for (const j of data.jobs ?? []) {
          if (!j.tags?.length) continue
          for (const p of j.result_paths ?? []) {
            const base = String(p).split(/[\\/]/).pop()
            if (base) map[base] = j.tags
          }
        }
        setOwnership(map)
      } catch {
        // queue unavailable — ownership chips simply stay hidden
      }
    })()
  }, [backendUrl])

  /** Which surface made this file: 'playground' | 'director' | a project id | null. */
  const ownerOf = useCallback((item: GalleryItem): string | null => {
    const tags = ownership[item.filename]
    if (!tags) return null
    if (tags.includes('playground')) return 'playground'
    const proj = tags.find(t => t.startsWith('project:'))
    if (proj) return proj.slice('project:'.length)
    if (tags.includes('director')) return 'director'
    return null
  }, [ownership])

  const projectName = useCallback(
    (id: string) => projects.find(p => p.id === id)?.name ?? null,
    [projects],
  )

  /** Owner chips actually worth showing: only buckets with at least one item. */
  const ownerChips = useMemo(() => {
    const owners = new Set(items.map(i => ownerOf(i)).filter((o): o is string => !!o))
    const chips: { value: string; label: string }[] = [{ value: 'all', label: 'All' }]
    if (owners.has('playground')) chips.push({ value: 'playground', label: 'Playground' })
    if (owners.has('director')) chips.push({ value: 'director', label: 'Director' })
    for (const o of owners) {
      if (o === 'playground' || o === 'director') continue
      const name = projectName(o)
      if (name) chips.push({ value: o, label: name })
    }
    return chips
  }, [items, ownerOf, projectName])

  /** File an existing render into a project's assets (the file never moves). */
  const sendToProject = useCallback((item: GalleryItem, projectId: string) => {
    addAsset(projectId, {
      type: item.type,
      path: item.path,
      url: pathToFileUrl(item.path),
      prompt: item.prompt ?? '',
      resolution: '480p',
      // Gen Space's grid only lists assets with generationParams.
      generationParams: {
        mode: item.type === 'image' ? 'text-to-image' : 'text-to-video',
        prompt: item.prompt ?? '',
        model: item.model_name ?? 'unknown',
        duration: 5,
        resolution: '480p',
        fps: 24,
        audio: false,
        cameraMotion: 'none',
      },
      takes: [{ url: pathToFileUrl(item.path), path: item.path, createdAt: Date.now() }],
      activeTakeIndex: 0,
    })
    setSentIds(prev => new Set(prev).add(item.id))
    setSendItem(null)
  }, [addAsset])

  const confirm = useConfirm()
  const [saveToLibrary, setSaveToLibrary] = useState<SaveToLibraryRequest | null>(null)
  const [query, setQuery] = useState('')
  const [modelFilter, setModelFilter] = useState('all')
  const handleDelete = async (item: GalleryItem) => {
    if (!(await confirm({ title: `Delete "${item.filename}"?`, destructive: true }))) return
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const res = await fetch(`${backendUrl}/api/gallery/local/${item.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`)
      setItems(prev => prev.filter(i => i.id !== item.id))
      setTotal(prev => prev - 1)
    } catch (e) {
      logger.error(`Failed to delete gallery item: ${e}`)
    }
  }

  const totalPages = Math.ceil(total / perPage)

  const filters: { label: string; value: FilterType; icon: React.ReactNode }[] = [
    { label: 'All', value: 'all', icon: null },
    { label: 'Images', value: 'images', icon: <ImageIcon className="h-3.5 w-3.5" /> },
    { label: 'Videos', value: 'videos', icon: <Film className="h-3.5 w-3.5" /> },
  ]

  const modelOptions = [...new Set(items.map((i) => i.model_name).filter((m): m is string => !!m))].sort()
  const q = query.trim().toLowerCase()
  const visibleItems = items.filter(
    (i) =>
      (ownerFilter === 'all' || ownerOf(i) === ownerFilter) &&
      (modelFilter === 'all' || i.model_name === modelFilter) &&
      (!q || i.filename.toLowerCase().includes(q) || (i.prompt ?? '').toLowerCase().includes(q)),
  )

  return (
    <div className="h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 px-6 py-4 border-b border-zinc-800 shrink-0">
        <button
          aria-label="Back"
          onClick={goHome}
          className="h-8 w-8 flex items-center justify-center rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <LtxLogo className="h-5 w-auto text-white" />
        <span className="text-zinc-500 text-sm">/</span>
        <h1 className="text-lg font-semibold text-white">Gallery</h1>

        <div className="ml-auto flex items-center gap-2">
          {/* Filter tabs */}
          <div className="flex items-center bg-zinc-900 rounded-lg border border-zinc-800 p-0.5">
            {filters.map(f => (
              <button
                key={f.value}
                onClick={() => { setFilter(f.value); setPage(1) }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  filter === f.value
                    ? 'bg-zinc-700 text-white'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                {f.icon}
                {f.label}
              </button>
            ))}
          </div>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or prompt…"
            className="h-8 w-52 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/60"
          />
          <select
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            className="h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200"
          >
            <option value="all">All models</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

        </div>
      </header>

      {/* Owner chips — who made it (projects / Playground / Director). Hidden
          until tagged renders exist, so old untagged galleries stay clean. */}
      {ownerChips.length > 1 && (
        <div className="flex items-center gap-1.5 px-6 pt-3 flex-wrap shrink-0">
          {ownerChips.map(c => (
            <button
              key={c.value}
              onClick={() => setOwnerFilter(c.value)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                ownerFilter === c.value
                  ? 'bg-amber-500/15 border-amber-500/50 text-amber-300'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-600'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
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
            <Button variant="outline" onClick={() => void fetchGallery()} className="border-zinc-700">
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-4">
              <ImageIcon className="h-8 w-8 text-zinc-600" />
            </div>
            <h3 className="text-lg font-medium text-zinc-400 mb-2">No items yet</h3>
            <p className="text-zinc-500">Generated images and videos will appear here</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {visibleItems.map(item => (
                <div
                  key={item.id}
                  className="group relative bg-zinc-900 rounded-lg overflow-hidden border border-zinc-800 hover:border-zinc-600 transition-all cursor-pointer hover:shadow-lg hover:shadow-black/20"
                  onClick={() => setPreviewItem(item)}
                >
                  {/* Thumbnail */}
                  <div className="aspect-video bg-zinc-800 flex items-center justify-center overflow-hidden">
                    {item.type === 'image' ? (
                      <img
                        src={mediaSrc(item)}
                        alt={item.filename}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      // Videos: file:// streams with Range support, so a muted
                      // preview element doubles as the thumbnail.
                      <video
                        src={mediaSrc(item)}
                        muted
                        playsInline
                        preload="metadata"
                        className="w-full h-full object-cover"
                      />
                    )}
                    {item.type === 'video' && (
                      <div className="absolute top-2 left-2 bg-black/60 rounded px-1.5 py-0.5 text-[10px] font-medium text-white flex items-center gap-1">
                        <Film className="h-3 w-3" />
                        Video
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="p-2.5">
                    <p className="text-xs text-white font-medium truncate">{item.filename}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      {item.model_name && (
                        <span className="text-[10px] bg-blue-500/20 text-blue-400 rounded px-1.5 py-0.5 font-medium">
                          {item.model_name}
                        </span>
                      )}
                      <span className="text-[10px] text-zinc-500">{formatFileSize(item.size_bytes)}</span>
                      <span className="text-[10px] text-zinc-500">{formatDate(item.created_at)}</span>
                    </div>
                  </div>

                  {/* Hover actions */}
                  {item.type === 'image' && (
                    <button
                      aria-label="Animate this image"
                      title="Animate in Playground — image-to-video, Shot Animator style"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingAnimateImage({ url: pathToFileUrl(item.path) })
                        openPlayground()
                      }}
                      className="absolute top-2 right-10 p-1.5 rounded bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-amber-500/80"
                    >
                      <Sparkles className="h-3.5 w-3.5 text-white" />
                    </button>
                  )}
                  {item.type === 'image' && (
                    <>
                      <button
                        aria-label="Save as Character"
                        title="Save as Character — reusable across the Director and Gen Space"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSaveToLibrary({ kind: 'character', imagePath: item.path, suggestedName: suggestFromFilename(item.filename) })
                        }}
                        className="absolute top-2 right-[4.5rem] p-1.5 rounded bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-amber-500/80"
                      >
                        <UserPlus className="h-3.5 w-3.5 text-white" />
                      </button>
                      <button
                        aria-label="Save to References"
                        title="Save to References (people / places / wardrobe / styles)"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSaveToLibrary({ kind: 'reference', imagePath: item.path, suggestedName: suggestFromFilename(item.filename) })
                        }}
                        className="absolute top-2 right-[6.5rem] p-1.5 rounded bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-amber-500/80"
                      >
                        <Images className="h-3.5 w-3.5 text-white" />
                      </button>
                    </>
                  )}
                  {/* Send to project — files the render into a project's assets */}
                  <button
                    aria-label="Send to project"
                    title="Send to project — file this render into a project's Gen Space"
                    onClick={(e) => { e.stopPropagation(); setSendItem(item) }}
                    className="absolute bottom-2 right-2 p-1.5 rounded bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-amber-500/80"
                  >
                    {sentIds.has(item.id)
                      ? <Check className="h-3.5 w-3.5 text-emerald-400" />
                      : <FolderInput className="h-3.5 w-3.5 text-white" />}
                  </button>
                  <button
                    aria-label="Delete"
                    onClick={(e) => { e.stopPropagation(); void handleDelete(item) }}
                    className="absolute top-2 right-2 p-1.5 rounded bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/80"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-white" />
                  </button>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-6">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-zinc-700"
                  disabled={page <= 1}
                  onClick={() => setPage(p => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-zinc-400">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-zinc-700"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => p + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <SaveToLibraryModal request={saveToLibrary} onClose={() => setSaveToLibrary(null)} />

      {/* Send-to-project picker */}
      {sendItem && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => setSendItem(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-sm mx-4 p-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-white mb-1">Send to project</h3>
            <p className="text-xs text-zinc-500 mb-3 truncate">{sendItem.filename}</p>
            {projects.length === 0 ? (
              <p className="text-xs text-zinc-400">No projects yet — create one from Home first.</p>
            ) : (
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {projects.map(p => (
                  <button
                    key={p.id}
                    onClick={() => sendToProject(sendItem, p.id)}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-zinc-200 hover:bg-zinc-800 border border-transparent hover:border-zinc-700 transition-colors"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => setSendItem(null)}
              className="mt-3 w-full px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-white bg-zinc-800/60 hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Preview Lightbox */}
      {previewItem && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => setPreviewItem(null)}
        >
          <div
            className="relative max-w-4xl max-h-[85vh] w-full mx-4"
            onClick={e => e.stopPropagation()}
          >
            <button
              aria-label="Close preview"
              onClick={() => setPreviewItem(null)}
              className="absolute -top-10 right-0 p-2 text-zinc-400 hover:text-white transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
            {previewItem.type === 'video' ? (
              <video
                src={mediaSrc(previewItem)}
                controls
                autoPlay
                className="w-full max-h-[80vh] rounded-lg"
              />
            ) : (
              <img
                src={mediaSrc(previewItem)}
                alt={previewItem.filename}
                className="w-full max-h-[80vh] object-contain rounded-lg"
              />
            )}
            {previewItem.prompt && (
              <div className="mt-3 flex items-start gap-3">
                <p className="flex-1 text-xs text-zinc-400 line-clamp-3" title={previewItem.prompt}>
                  {previewItem.prompt}
                </p>
                <button
                  onClick={() => {
                    setPendingRemix({ prompt: previewItem.prompt! })
                    setPreviewItem(null)
                    openPlayground()
                  }}
                  className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 text-xs font-semibold transition-colors"
                  title="Reopen the gen surface preloaded with this prompt"
                >
                  Remix
                </button>
              </div>
            )}
            <div className="mt-3 flex items-center justify-between">
              <div>
                <p className="text-sm text-white font-medium">{previewItem.filename}</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {formatFileSize(previewItem.size_bytes)} &middot; {formatDate(previewItem.created_at)}
                  {previewItem.model_name && ` \u00B7 ${previewItem.model_name}`}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="border-zinc-700"
                onClick={() => {
                  if (previewItem.path) {
                    void window.electronAPI.showItemInFolder(previewItem.path)
                  }
                }}
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Show in Folder
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
