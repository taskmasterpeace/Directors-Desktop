import { useEffect, useState } from 'react'

/**
 * Live Directors Palette balance in POINTS (1 pt = $0.01; balance_cents from
 * /api/sync/credits IS the points number). Null while unknown/disconnected.
 */
export function useCreditBalance(refreshMs = 60_000): number | null {
  const [points, setPoints] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const base = await window.electronAPI.getBackendUrl()
        const res = await fetch(`${base}/api/sync/credits`)
        if (!res.ok) return
        const data = (await res.json()) as { connected?: boolean; balance_cents?: number | null }
        if (!cancelled && data.connected && typeof data.balance_cents === 'number') {
          setPoints(data.balance_cents)
        }
      } catch {
        /* backend warming up — keep last known */
      }
    }
    void load()
    const interval = setInterval(load, refreshMs)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [refreshMs])

  return points
}
