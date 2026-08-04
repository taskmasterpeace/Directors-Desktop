import { useCallback, useEffect, useState } from 'react'
import { Loader2, LogIn, KeyRound, Mail, WifiOff } from 'lucide-react'
import { LtxLogo } from './LtxLogo'
import { logger } from '../lib/logger'

/**
 * Directors Palette account gate.
 *
 * The app requires a Palette account: nothing renders until the backend
 * reports a valid connection. Honest scope — this is a PRODUCT requirement
 * and an entitlement check, not DRM: a patched desktop binary can always skip
 * a client-side check. Real enforcement lives server-side, where cloud
 * generation deducts Palette credits before dispatching (see CLAUDE.md
 * § "Billing & Security").
 *
 * Offline behaviour: a *successful* check is remembered. If a later check
 * cannot reach the backend at all (laptop offline, backend restarting), the
 * app stays usable for OFFLINE_GRACE_DAYS so a network blip never bricks a
 * paying user mid-edit. A check that succeeds and says "not connected" —
 * signed out, revoked, expired — blocks immediately regardless.
 */

const LAST_VERIFIED_KEY = 'dd-palette-last-verified'
const OFFLINE_GRACE_DAYS = 7
const GRACE_MS = OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000

type GateState = 'checking' | 'allowed' | 'offline' | 'blocked'

interface PaletteUser {
  email?: string
  name?: string
}

async function backendBase(): Promise<string> {
  if (window.electronAPI) return await window.electronAPI.getBackendUrl()
  return 'http://localhost:8000'
}

export function PaletteAuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('checking')
  const [user, setUser] = useState<PaletteUser | null>(null)
  const [mode, setMode] = useState<'choose' | 'email' | 'key'>('choose')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async (): Promise<GateState> => {
    try {
      const base = await backendBase()
      const res = await fetch(`${base}/api/sync/status`)
      if (!res.ok) throw new Error(`status ${res.status}`)
      const data = (await res.json()) as { connected?: boolean; user?: PaletteUser | null }
      if (data.connected) {
        localStorage.setItem(LAST_VERIFIED_KEY, String(Date.now()))
        setUser(data.user ?? null)
        return 'allowed'
      }
      // The server answered and said no — a real sign-out. Grace does not apply.
      return 'blocked'
    } catch {
      // Couldn't reach the backend at all: honour the offline grace window.
      const last = Number(localStorage.getItem(LAST_VERIFIED_KEY) || 0)
      return last > 0 && Date.now() - last < GRACE_MS ? 'offline' : 'blocked'
    }
  }, [])

  // Initial check, with a few retries while the Python backend is still booting.
  useEffect(() => {
    let cancelled = false
    let attempts = 0
    const run = async () => {
      const result = await check()
      if (cancelled) return
      // 'blocked' during the first seconds is usually just a cold backend.
      if (result === 'blocked' && attempts < 8) {
        attempts += 1
        setTimeout(run, 1500)
        return
      }
      setState(result)
    }
    void run()
    return () => { cancelled = true }
  }, [check])

  // The browser sign-in flow lands in App.tsx and fires this event.
  useEffect(() => {
    const handler = () => { void check().then(setState) }
    window.addEventListener('palette-auth-updated', handler)
    return () => window.removeEventListener('palette-auth-updated', handler)
  }, [check])

  const signInWithBrowser = useCallback(async () => {
    setError(null)
    try {
      // Loopback (RFC 8252) flow — the live /auth/desktop bridge only accepts
      // http://127.0.0.1:<port>/auth/callback redirects; the custom-scheme
      // redirect (openPaletteAuth) fails its exact-match validation.
      const result = await window.electronAPI.startPaletteGoogleLogin()
      if (!result.ok) setError(result.error || 'Could not open the sign-in page')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the sign-in page')
    }
  }, [])

  const submitEmail = useCallback(async () => {
    if (!email.trim() || !password || busy) return
    setBusy(true)
    setError(null)
    try {
      const base = await backendBase()
      const res = await fetch(`${base}/api/sync/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const data = (await res.json()) as { connected?: boolean; error?: string }
      if (!data.connected) throw new Error(data.error || 'Sign-in failed')
      setState(await check())
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Sign-in failed'
      setError(msg)
      logger.error(`Palette sign-in failed: ${msg}`)
    } finally {
      setBusy(false)
    }
  }, [email, password, busy, check])

  const submitKey = useCallback(async () => {
    if (!apiKey.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const base = await backendBase()
      const res = await fetch(`${base}/api/sync/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: apiKey.trim() }),
      })
      const data = (await res.json()) as { connected?: boolean; error?: string }
      if (!data.connected) throw new Error(data.error || 'That key was not accepted')
      setState(await check())
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not connect'
      setError(msg)
      logger.error(`Palette key connect failed: ${msg}`)
    } finally {
      setBusy(false)
    }
  }, [apiKey, busy, check])

  if (state === 'allowed' || state === 'offline') {
    return (
      <>
        {state === 'offline' && (
          <div className="fixed top-0 inset-x-0 z-[200] bg-amber-500/15 border-b border-amber-500/30 px-4 py-1 flex items-center justify-center gap-2 text-[11px] text-amber-200">
            <WifiOff className="h-3 w-3" />
            Offline — using your saved Directors Palette session. Reconnect within {OFFLINE_GRACE_DAYS} days to keep working.
          </div>
        )}
        {children}
      </>
    )
  }

  if (state === 'checking') {
    return (
      <div className="h-screen w-screen bg-zinc-950 flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking your Directors Palette account…
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen w-screen bg-zinc-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <LtxLogo className="h-8 mb-4" />
          <h1 className="text-lg font-semibold text-white tracking-tight">Sign in to continue</h1>
          <p className="text-xs text-zinc-500 mt-1.5 text-center max-w-sm">
            Director&apos;s Desktop runs on your Directors Palette account — it carries your points,
            characters, and libraries.
          </p>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-3">
          {mode === 'choose' && (
            <>
              <button
                onClick={signInWithBrowser}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold py-2.5 text-sm transition-colors"
              >
                <LogIn className="h-4 w-4" />
                Sign in with Directors Palette
              </button>
              <p className="text-[10px] text-zinc-600 text-center">Opens your browser, then returns here automatically.</p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => { setMode('email'); setError(null) }}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 py-2 text-xs transition-colors"
                >
                  <Mail className="h-3.5 w-3.5" /> Email + password
                </button>
                <button
                  onClick={() => { setMode('key'); setError(null) }}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 py-2 text-xs transition-colors"
                >
                  <KeyRound className="h-3.5 w-3.5" /> Paste API key
                </button>
              </div>
            </>
          )}

          {mode === 'email' && (
            <>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitEmail() }}
                placeholder="Password"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
              />
              <button
                onClick={submitEmail}
                disabled={busy || !email.trim() || !password}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold py-2.5 text-sm transition-colors disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                Sign in
              </button>
              <button onClick={() => setMode('choose')} className="w-full text-[11px] text-zinc-500 hover:text-zinc-300">
                Back
              </button>
            </>
          )}

          {mode === 'key' && (
            <>
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitKey() }}
                placeholder="dp_…"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white font-mono"
              />
              <button
                onClick={() => window.electronAPI.openPaletteApiKeyPage()}
                className="w-full text-[11px] text-zinc-400 hover:text-zinc-200"
              >
                Get a key at directorspal.com → Settings → API keys
              </button>
              <button
                onClick={submitKey}
                disabled={busy || !apiKey.trim()}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold py-2.5 text-sm transition-colors disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Connect
              </button>
              <button onClick={() => setMode('choose')} className="w-full text-[11px] text-zinc-500 hover:text-zinc-300">
                Back
              </button>
            </>
          )}

          {error && <p className="text-xs text-red-400 text-center">{error}</p>}
        </div>

        <div className="mt-4 flex items-center justify-center gap-3 text-[11px]">
          <button
            onClick={() => window.electronAPI.openPaletteLoginPage()}
            className="text-amber-400/90 hover:text-amber-300"
          >
            Create an account
          </button>
          <span className="text-zinc-700">·</span>
          <button onClick={() => { setState('checking'); void check().then(setState) }} className="text-zinc-500 hover:text-zinc-300">
            Retry
          </button>
        </div>
        {user?.email && <p className="mt-3 text-center text-[10px] text-zinc-600">Last signed in as {user.email}</p>}
      </div>
    </div>
  )
}
