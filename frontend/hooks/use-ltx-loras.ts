import { useEffect, useState } from 'react'
import { LTX_LORAS, mergeLtxLoras, type LocalLtxLoraEntry, type LtxLora } from '../lib/ltx-loras'

/**
 * Curated LTX LoRAs + drop-a-file discoveries, one merged list. Fetches
 * `/api/lora/ltx-local` (files sitting in LTXDesktop/models/loras with their
 * sidecar thumbnails/triggers) and merges over the static registry. Until the
 * backend answers — or if it can't — the curated list stands alone, so every
 * picker keeps working during startup.
 */
export function useLtxLoras(enabled: boolean = true): LtxLora[] {
  const [loras, setLoras] = useState<LtxLora[]>([...LTX_LORAS])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    void (async () => {
      try {
        const backendUrl = await window.electronAPI.getBackendUrl()
        const res = await fetch(`${backendUrl}/api/lora/ltx-local`)
        if (!res.ok) return
        const data = (await res.json()) as { entries?: LocalLtxLoraEntry[] }
        if (alive && Array.isArray(data.entries)) {
          setLoras(mergeLtxLoras(LTX_LORAS, data.entries))
        }
      } catch {
        // Backend not up yet — the curated registry still renders.
      }
    })()
    return () => {
      alive = false
    }
  }, [enabled])

  return loras
}
