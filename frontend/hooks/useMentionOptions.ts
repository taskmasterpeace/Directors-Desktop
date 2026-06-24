/** Fetches library characters + references as `@`-mention autocomplete options. */

import { useCallback, useEffect, useState } from 'react'
import type { AtOption } from './useAtCaretAutocomplete'

async function backendBase(): Promise<string> {
  if (window.electronAPI) return await window.electronAPI.getBackendUrl()
  return 'http://localhost:8000'
}

export function useMentionOptions(): AtOption[] {
  const [options, setOptions] = useState<AtOption[]>([])

  const load = useCallback(async () => {
    try {
      const base = await backendBase()
      const [charsRes, refsRes] = await Promise.all([
        fetch(`${base}/api/library/characters`),
        fetch(`${base}/api/library/references`),
      ])
      const opts: AtOption[] = []
      if (charsRes.ok) {
        const data = await charsRes.json()
        for (const c of data.characters ?? []) {
          opts.push({
            id: `char:${c.id}`,
            label: c.name,
            kind: 'character',
            thumbnail: (c.reference_image_paths ?? [])[0],
          })
        }
      }
      if (refsRes.ok) {
        const data = await refsRes.json()
        for (const r of data.references ?? []) {
          opts.push({ id: `ref:${r.id}`, label: r.name, kind: 'reference', thumbnail: r.image_path || undefined })
        }
      }
      setOptions(opts)
    } catch {
      setOptions([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return options
}
