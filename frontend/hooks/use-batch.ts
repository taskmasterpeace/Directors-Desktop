import { useState, useRef, useCallback, useEffect } from 'react'
import type { BatchSubmitRequest, BatchStatusResponse, BatchReport } from '@/types/batch'
import { submitBatch, getBatchStatus, cancelBatch, retryFailedBatch } from '@/lib/batch-api'

export interface UseBatchReturn {
  activeBatchId: string | null
  batchStatus: BatchStatusResponse | null
  batchReport: BatchReport | null
  isRunning: boolean
  /** Resolves true when accepted; false sets `submitError` (never throws). */
  submit: (request: BatchSubmitRequest) => Promise<boolean>
  submitError: string | null
  cancel: () => Promise<void>
  retryFailed: () => Promise<void>
  reset: () => void
}

export function useBatch(): UseBatchReturn {
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null)
  const [batchStatus, setBatchStatus] = useState<BatchStatusResponse | null>(null)
  const [batchReport, setBatchReport] = useState<BatchReport | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startPolling = useCallback((batchId: string) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const status = await getBatchStatus(batchId)
        setBatchStatus(status)
        if (status.report) {
          setBatchReport(status.report)
          stopPolling()
          playCompletionSound()
        }
      } catch {
        // Ignore polling errors
      }
    }, 1000)
  }, [stopPolling])

  const [submitError, setSubmitError] = useState<string | null>(null)

  /**
   * Submit a batch. Never throws — a failed submit sets `submitError` so the UI
   * can show it (previously a non-2xx became an unhandled rejection: the user
   * clicked Generate and nothing visibly happened).
   */
  const submit = useCallback(async (request: BatchSubmitRequest): Promise<boolean> => {
    setSubmitError(null)
    try {
      const response = await submitBatch(request)
      setActiveBatchId(response.batch_id)
      setBatchReport(null)
      startPolling(response.batch_id)
      return true
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Batch submit failed')
      return false
    }
  }, [startPolling])

  const cancel = useCallback(async () => {
    if (activeBatchId) {
      await cancelBatch(activeBatchId)
    }
  }, [activeBatchId])

  const retryFailed = useCallback(async () => {
    if (activeBatchId) {
      await retryFailedBatch(activeBatchId)
      startPolling(activeBatchId)
    }
  }, [activeBatchId, startPolling])

  const reset = useCallback(() => {
    stopPolling()
    setActiveBatchId(null)
    setBatchStatus(null)
    setBatchReport(null)
  }, [stopPolling])

  useEffect(() => stopPolling, [stopPolling])

  const isRunning = batchStatus !== null && batchStatus.report === null

  return { activeBatchId, batchStatus, batchReport, isRunning, submit, submitError, cancel, retryFailed, reset }
}

function playCompletionSound(): void {
  try {
    const audio = new Audio('/sounds/batch-complete.mp3')
    audio.volume = 0.5
    audio.play().catch(() => {})
  } catch {
    // Sound not critical
  }
}
