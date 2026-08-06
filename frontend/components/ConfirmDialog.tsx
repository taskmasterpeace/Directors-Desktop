import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from './ui/button'

interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as destructive (red). Default true. */
  destructive?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/**
 * Styled, promise-based replacement for window.confirm(). Usage:
 *   const confirm = useConfirm()
 *   if (await confirm({ title: 'Delete this?', destructive: true })) { ... }
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider')
  return ctx
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...options, resolve })
    })
  }, [])

  const close = useCallback((result: boolean) => {
    setPending((current) => {
      current?.resolve(result)
      return null
    })
  }, [])

  // Escape cancels, Enter confirms; focus the confirm button on open.
  useEffect(() => {
    if (!pending) return
    confirmButtonRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        close(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, close])

  const destructive = pending?.destructive ?? true

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
          onClick={() => close(false)}
          role="presentation"
        >
          <div
            className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 text-zinc-100 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-label={pending.title}
          >
            <div className="flex items-start gap-3">
              <div
                className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${
                  destructive ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'
                }`}
              >
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold tracking-tight">{pending.title}</h3>
                {pending.message && (
                  <p className="mt-1 text-sm text-zinc-400">{pending.message}</p>
                )}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => close(false)}>
                {pending.cancelLabel ?? 'Cancel'}
              </Button>
              <Button
                ref={confirmButtonRef}
                variant={destructive ? 'destructive' : 'default'}
                size="sm"
                onClick={() => close(true)}
              >
                {pending.confirmLabel ?? 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
