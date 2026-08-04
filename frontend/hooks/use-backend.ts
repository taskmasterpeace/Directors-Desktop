import { useState, useEffect, useCallback } from 'react'
import { logger } from '../lib/logger'
import { resetBackendInfo } from '../lib/backend-auth'
import type { ModelWarmth } from '../lib/generation-cost'

interface BackendStatus {
  connected: boolean
  modelsLoaded: boolean
  /**
   * VRAM residency of the active video pipeline — NOT the same as downloaded.
   * A model on disk still costs ~9 minutes to load, and only one fits at a
   * time, so the UI prices that in before the user commits.
   */
  warmth: ModelWarmth
  activeModel: string | null
  gpuInfo: {
    name: string
    vram: number
    vramUsed: number
  } | null
}

interface ModelStatus {
  id: string
  name: string
  size: number
  downloaded: boolean
  downloadProgress: number
}

export type BackendProcessStatus = 'alive' | 'restarting' | 'dead'

interface BackendHealthStatusPayload {
  status: BackendProcessStatus
  exitCode?: number | null
}

interface UseBackendReturn {
  status: BackendStatus
  models: ModelStatus[]
  processStatus: BackendProcessStatus | null
  reconnectNow: () => Promise<boolean>
  isLoading: boolean
  error: string | null
  checkHealth: () => Promise<boolean>
  downloadModel: (modelId: string) => Promise<void>
}

function toBackendHealthStatus(value: unknown): BackendHealthStatusPayload | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as { status?: unknown; exitCode?: unknown }
  if (record.status !== 'alive' && record.status !== 'restarting' && record.status !== 'dead') {
    return null
  }

  return {
    status: record.status,
    exitCode: typeof record.exitCode === 'number' || record.exitCode === null ? record.exitCode : undefined,
  }
}

export function useBackend(): UseBackendReturn {
  const [status, setStatus] = useState<BackendStatus>({
    connected: false,
    modelsLoaded: false,
    warmth: 'cold',
    activeModel: null,
    gpuInfo: null,
  })
  const [models, setModels] = useState<ModelStatus[]>([])
  const [processStatus, setProcessStatus] = useState<BackendProcessStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const checkHealth = useCallback(async (): Promise<boolean> => {
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      logger.info(`Checking backend health at: ${backendUrl}`)
      const response = await fetch(`${backendUrl}/health`)

      if (response.ok) {
        const data = await response.json()
        logger.info(`Backend health: ${JSON.stringify(data)}`)

        setStatus({
          connected: true,
          modelsLoaded: data.models_loaded,
          warmth: (data.warmth as ModelWarmth) ?? 'cold',
          activeModel: data.active_model ?? null,
          gpuInfo: data.gpu_info,
        })
        setError(null)
        return true
      }
      logger.warn(`Backend health check failed with status: ${response.status}`)
      return false
    } catch (err) {
      logger.error(`Backend health check error: ${err}`)
      setStatus(prev => ({ ...prev, connected: false }))
      return false
    }
  }, [])

  const fetchModels = useCallback(async () => {
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()
      const response = await fetch(`${backendUrl}/api/models`)

      if (response.ok) {
        const data = await response.json()
        setModels(data.models)
      }
    } catch (err) {
      logger.error(`Failed to fetch models: ${err}`)
    }
  }, [])

  const downloadModel = useCallback(async (modelId: string) => {
    try {
      const backendUrl = await window.electronAPI.getBackendUrl()

      // Connect to WebSocket for download progress
      const wsUrl = backendUrl.replace('http://', 'ws://') + `/ws/download/${modelId}`
      const ws = new WebSocket(wsUrl)

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.type === 'progress') {
          setModels(prev => prev.map(m =>
            m.id === modelId
              ? { ...m, downloadProgress: data.progress }
              : m
          ))
        } else if (data.type === 'complete') {
          setModels(prev => prev.map(m =>
            m.id === modelId
              ? { ...m, downloaded: true, downloadProgress: 100 }
              : m
          ))
        }
      }

      // Trigger download
      await fetch(`${backendUrl}/api/models/${modelId}/download`, {
        method: 'POST',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    }
  }, [])

  const handleBackendStatus = useCallback(async (payload: BackendHealthStatusPayload) => {
    setProcessStatus(payload.status)

    // A restart mints a new token/port — drop the cached backend info so the
    // next request re-resolves against the freshly started backend.
    if (payload.status === 'restarting' || payload.status === 'alive') {
      resetBackendInfo()
    }

    if (payload.status === 'alive') {
      const healthy = await checkHealth()
      if (healthy) {
        await fetchModels()
      } else {
        setError('Failed to connect to backend')
      }
      setIsLoading(false)
      return
    }

    if (payload.status === 'restarting') {
      return
    }

    setStatus((prev) => ({ ...prev, connected: false }))
    setError('The backend process crashed and could not be restarted')
    setIsLoading(false)
  }, [checkHealth, fetchModels])

  /**
   * Force a reconnect attempt right now (the overlay's "Try again" button).
   * Trusts the socket over the flag: if /health answers, we're alive.
   */
  const reconnectNow = useCallback(async (): Promise<boolean> => {
    resetBackendInfo()
    const healthy = await checkHealth()
    if (healthy) {
      setProcessStatus('alive')
      setError(null)
      setIsLoading(false)
      void fetchModels()
    }
    return healthy
  }, [checkHealth, fetchModels])

  // Self-healing reconnect. The main process publishes 'alive' exactly once —
  // if this window misses that event (subscribed a beat late, reloaded mid-
  // restart, or the emit raced the listener), the UI used to sit on
  // "Reconnecting..." forever with no way out. Poll while restarting so the
  // app comes back on its own.
  useEffect(() => {
    if (processStatus !== 'restarting') return
    let cancelled = false

    const tick = async () => {
      try {
        const snapshot = await window.electronAPI.getBackendHealthStatus()
        const payload = toBackendHealthStatus(snapshot)
        if (cancelled) return
        if (payload && payload.status !== 'restarting') {
          await handleBackendStatus(payload)
          return
        }
        // Main process still says "restarting", but a real /health response
        // means the backend is serving — believe the socket.
        const healthy = await checkHealth()
        if (!cancelled && healthy) {
          setProcessStatus('alive')
          setError(null)
          setIsLoading(false)
          void fetchModels()
        }
      } catch {
        /* backend still coming up — keep polling */
      }
    }

    void tick()
    const interval = setInterval(() => { void tick() }, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [processStatus, handleBackendStatus, checkHealth, fetchModels])

  useEffect(() => {
    let cancelled = false

    const applyStatus = async (value: unknown) => {
      const payload = toBackendHealthStatus(value)
      if (!payload || cancelled) {
        return
      }
      await handleBackendStatus(payload)
    }

    const unsubscribe = window.electronAPI.onBackendHealthStatus((data: BackendHealthStatusPayload) => {
      void applyStatus(data)
    })

    const init = async () => {
      try {
        const snapshot = await window.electronAPI.getBackendHealthStatus()
        await applyStatus(snapshot)
      } catch (err) {
        logger.error(`Failed to load backend health status snapshot: ${err}`)
      }
    }

    void init()

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [handleBackendStatus])

  return {
    status,
    models,
    processStatus,
    isLoading,
    error,
    reconnectNow,
    checkHealth,
    downloadModel,
  }
}
