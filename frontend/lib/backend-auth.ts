/**
 * Backend auth interceptor.
 *
 * The Electron main process starts the Python backend on a free port with a random
 * per-session auth token. Rather than thread that token through every call site, we
 * install a single global `fetch` wrapper that attaches `Authorization: Bearer <token>`
 * to any request targeting the backend origin. When there's no token (web/dev), it's a
 * transparent passthrough, so behavior is unchanged.
 */

interface BackendInfo {
  url: string
  token: string
}

// Resolved backend origin + per-session auth token. Both are unknown until the Electron main
// process has spawned the backend (free port + random token). We must NOT permanently cache the
// pre-startup empty/fallback state: doing so sent every backend request unauthenticated forever
// (→ 401 → the renderer hung on "Loading settings"). So we re-resolve on each call until BOTH a
// real URL and a real token are available, then cache that stable value for the session.
let cachedInfo: BackendInfo | null = null

function loadBackendInfo(): Promise<BackendInfo> {
  if (cachedInfo) return Promise.resolve(cachedInfo)
  return (async () => {
    try {
      const api = window.electronAPI
      if (!api?.getBackendUrl) return { url: '', token: '' }
      const [url, token] = await Promise.all([
        api.getBackendUrl(),
        api.getBackendToken ? api.getBackendToken() : Promise.resolve(''),
      ])
      const info: BackendInfo = { url: (url || '').replace(/\/+$/, ''), token: token || '' }
      if (info.url && info.token) {
        cachedInfo = info // only cache once the backend is up and the token is real
      }
      return info
    } catch {
      return { url: '', token: '' }
    }
  })()
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

export function installBackendAuthInterceptor(): void {
  if (typeof window === 'undefined' || !window.fetch) return
  const originalFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { url: backendUrl, token } = await loadBackendInfo()
    if (!token || !backendUrl) return originalFetch(input, init)

    const target = requestUrl(input)
    if (!target.startsWith(backendUrl)) return originalFetch(input, init)

    // Merge headers from both the Request object (if any) and init, without clobbering
    // an Authorization header a caller already set.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    return originalFetch(input, { ...init, headers })
  }
}
