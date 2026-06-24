/**
 * Normalize a library OS path into a value usable as an `<img src>`.
 *
 * The library APIs return bare filesystem paths (e.g. `C:\Users\…\hero.png`), which are
 * NOT valid URLs. Electron registers a `file:` protocol handler, so we convert backslashes
 * to forward slashes and prefix `file:///` (matching the normalization used across GenSpace).
 * Already-URL values (file://, http(s), data:, blob:) pass through unchanged.
 */
export function toImgSrc(path: string | null | undefined): string {
  if (!path) return ''
  if (/^(file|https?|data|blob):/i.test(path)) return path
  const forward = path.replace(/\\/g, '/')
  return `file:///${forward.replace(/^\/+/, '')}`
}
