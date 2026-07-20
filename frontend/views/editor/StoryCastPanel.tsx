import { useEffect, useState } from 'react'
import { Plus, Trash2, Wand2 } from 'lucide-react'
import type { CastEntry, Project, StoryDoc } from '../../types/project'

/**
 * Story & Cast — the project-context surface from the agent-timeline spec.
 *
 * Story docs hold the source-of-truth text (script/lyrics/notes, any format,
 * verbatim). The cast maps story character names to Characters-library entries
 * so the AI knows WHO someone is (lines + likeness). "Scan for speakers" does
 * the best-effort `NAME:` pre-fill for formatted scripts; the deeper Dramatis
 * prose cascade lands with the agent bridge.
 */

interface LibraryCharacter {
  id: string
  name: string
}

const DOC_KINDS: StoryDoc['kind'][] = ['script', 'lyrics', 'notes', 'other']

/** Speaker-label scan: lines like "JAX:" / "Mrs. Vane:" (2-30 chars before the colon). */
export function scanSpeakers(text: string): string[] {
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Za-z0-9 .'-]{1,29}):(?:\s|$)/.exec(line)
    if (!m) continue
    const name = m[1].trim()
    // Skip obvious non-speakers (scene headings, timestamps, URLs).
    if (/^(INT|EXT|SCENE|CHAPTER|VERSE|CHORUS|BRIDGE|INTRO|OUTRO|NOTE|HTTP|HTTPS)$/i.test(name)) continue
    names.add(name)
  }
  return [...names]
}

export function StoryCastPanel({
  project,
  onUpdate,
}: {
  project: Project
  onUpdate: (patch: { storyDocs?: StoryDoc[]; cast?: CastEntry[] }) => void
}) {
  const storyDocs = project.storyDocs ?? []
  const cast = project.cast ?? []
  const [characters, setCharacters] = useState<LibraryCharacter[]>([])
  const [editingDocId, setEditingDocId] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const base = await window.electronAPI.getBackendUrl()
        const res = await fetch(`${base}/api/library/characters`)
        if (res.ok) {
          const data = (await res.json()) as { characters?: LibraryCharacter[] }
          setCharacters(data.characters ?? [])
        }
      } catch {
        /* library unavailable — cast links just show as unlinked */
      }
    })()
  }, [])

  const setDocs = (docs: StoryDoc[]) => onUpdate({ storyDocs: docs })
  const setCast = (entries: CastEntry[]) => onUpdate({ cast: entries })

  const addDoc = () => {
    const doc: StoryDoc = {
      id: `story_${Date.now().toString(36)}`,
      title: `Story ${storyDocs.length + 1}`,
      text: '',
      kind: 'script',
      updatedAt: Date.now(),
    }
    setDocs([...storyDocs, doc])
    setEditingDocId(doc.id)
  }

  const patchDoc = (id: string, patch: Partial<StoryDoc>) =>
    setDocs(storyDocs.map((d) => (d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d)))

  const scanForSpeakers = () => {
    const found = storyDocs.flatMap((d) => scanSpeakers(d.text))
    const existing = new Set(cast.map((c) => c.storyName.toLowerCase()))
    const additions = [...new Set(found)]
      .filter((n) => !existing.has(n.toLowerCase()))
      .map((storyName) => {
        // Auto-link when a library character name matches exactly (case-insensitive).
        const match = characters.find((c) => c.name.toLowerCase() === storyName.toLowerCase())
        return { storyName, characterId: match?.id } as CastEntry
      })
    if (additions.length > 0) setCast([...cast, ...additions])
  }

  return (
    <div className="space-y-5">
      {/* ── Story docs ── */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Story</label>
          <button
            onClick={addDoc}
            className="flex items-center gap-1 text-[11px] text-zinc-300 hover:text-white px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            <Plus className="h-3 w-3" /> Add doc
          </button>
        </div>
        {storyDocs.length === 0 && (
          <p className="text-[11px] text-zinc-600">
            Paste your script, lyrics, or notes — the source of truth the transcript aligns to and the AI reads.
          </p>
        )}
        <div className="space-y-2">
          {storyDocs.map((doc) => (
            <div key={doc.id} className="rounded-lg border border-zinc-800 bg-zinc-800/40 p-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <input
                  value={doc.title}
                  onChange={(e) => patchDoc(doc.id, { title: e.target.value })}
                  className="flex-1 bg-transparent text-sm text-white outline-none border-b border-transparent focus:border-zinc-600"
                />
                <select
                  value={doc.kind}
                  onChange={(e) => patchDoc(doc.id, { kind: e.target.value as StoryDoc['kind'] })}
                  className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-300"
                >
                  {DOC_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
                <button
                  onClick={() => setEditingDocId(editingDocId === doc.id ? null : doc.id)}
                  className="text-[11px] text-zinc-400 hover:text-white"
                >
                  {editingDocId === doc.id ? 'Done' : 'Edit'}
                </button>
                <button
                  onClick={() => setDocs(storyDocs.filter((d) => d.id !== doc.id))}
                  className="text-zinc-500 hover:text-red-400"
                  title="Delete doc"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {editingDocId === doc.id ? (
                <textarea
                  value={doc.text}
                  onChange={(e) => patchDoc(doc.id, { text: e.target.value })}
                  placeholder={'Paste the text. Speaker lines like "JAX: ..." get picked up by the cast scan.'}
                  className="w-full h-40 bg-zinc-900 border border-zinc-700 rounded p-2 text-xs text-zinc-200 resize-y"
                />
              ) : (
                <p className="text-[11px] text-zinc-500 truncate">
                  {doc.text ? `${doc.text.slice(0, 120)}${doc.text.length > 120 ? '…' : ''}` : 'Empty — click Edit to paste text.'}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Cast ── */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Cast</label>
          <div className="flex items-center gap-1.5">
            <button
              onClick={scanForSpeakers}
              disabled={storyDocs.length === 0}
              className="flex items-center gap-1 text-[11px] text-amber-300 hover:text-amber-200 px-2 py-0.5 rounded bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
              title="Find NAME: speaker lines in the story docs and add them here"
            >
              <Wand2 className="h-3 w-3" /> Scan for speakers
            </button>
            <button
              onClick={() => setCast([...cast, { storyName: '' }])}
              className="flex items-center gap-1 text-[11px] text-zinc-300 hover:text-white px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          </div>
        </div>
        {cast.length === 0 && (
          <p className="text-[11px] text-zinc-600">
            Link story names to your Characters library so generation knows each character&apos;s look.
          </p>
        )}
        <div className="space-y-1.5">
          {cast.map((entry, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={entry.storyName}
                onChange={(e) => setCast(cast.map((c, j) => (j === i ? { ...c, storyName: e.target.value } : c)))}
                placeholder="Name in the story"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white"
              />
              <select
                value={entry.characterId ?? ''}
                onChange={(e) =>
                  setCast(cast.map((c, j) => (j === i ? { ...c, characterId: e.target.value || undefined } : c)))
                }
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
              >
                <option value="">— not linked —</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button
                onClick={() => setCast(cast.filter((_, j) => j !== i))}
                className="text-zinc-500 hover:text-red-400"
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
