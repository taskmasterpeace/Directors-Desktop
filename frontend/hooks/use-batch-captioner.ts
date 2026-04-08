import { useCallback, useRef, useState } from 'react'
import { captionImage, type CaptionTargetModel } from '@/lib/caption-api'

export interface CaptionProgress {
  total: number
  completed: number
  failed: number
  running: boolean
}

const DEFAULT_CONCURRENCY = 4

export interface UseBatchCaptionerReturn {
  progress: CaptionProgress
  captionAll: (
    items: Array<{ id: string; imagePath: string }>,
    targetModel: CaptionTargetModel,
    onResult: (id: string, caption: string) => void,
    onError?: (id: string, error: string) => void,
  ) => Promise<void>
  cancel: () => void
}

export function useBatchCaptioner(
  concurrency: number = DEFAULT_CONCURRENCY,
): UseBatchCaptionerReturn {
  const [progress, setProgress] = useState<CaptionProgress>({
    total: 0, completed: 0, failed: 0, running: false,
  })
  const cancelledRef = useRef(false)

  const captionAll = useCallback(
    async (
      items: Array<{ id: string; imagePath: string }>,
      targetModel: CaptionTargetModel,
      onResult: (id: string, caption: string) => void,
      onError?: (id: string, error: string) => void,
    ) => {
      cancelledRef.current = false
      setProgress({ total: items.length, completed: 0, failed: 0, running: true })

      let cursor = 0
      const workers: Promise<void>[] = []

      const runNext = async (): Promise<void> => {
        while (cursor < items.length && !cancelledRef.current) {
          const i = cursor++
          const item = items[i]
          try {
            const caption = await captionImage(item.imagePath, targetModel)
            if (cancelledRef.current) return
            onResult(item.id, caption)
            setProgress(p => ({ ...p, completed: p.completed + 1 }))
          } catch (err) {
            if (cancelledRef.current) return
            const msg = err instanceof Error ? err.message : String(err)
            onError?.(item.id, msg)
            setProgress(p => ({ ...p, failed: p.failed + 1 }))
          }
        }
      }

      for (let i = 0; i < Math.min(concurrency, items.length); i++) {
        workers.push(runNext())
      }
      await Promise.all(workers)

      setProgress(p => ({ ...p, running: false }))
    },
    [concurrency],
  )

  const cancel = useCallback(() => {
    cancelledRef.current = true
    setProgress(p => ({ ...p, running: false }))
  }, [])

  return { progress, captionAll, cancel }
}
