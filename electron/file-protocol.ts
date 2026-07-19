import { protocol, net } from 'electron'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { logger } from './logger'

// Content types for media the renderer loads via file://. Video and audio
// elements refuse to decode a response whose Content-Type isn't a real media
// type, so we must set these explicitly — the previous `net.fetch(file://)`
// pass-through left them unset/generic, which is why images worked (Chromium
// sniffs image bytes) but <video>/<audio> failed with a decode/network error.
const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

/** Convert a `file://` request URL to an absolute filesystem path (Windows-aware). */
function fileUrlToPath(requestUrl: string): string | null {
  try {
    const u = new URL(requestUrl)
    if (u.protocol !== 'file:') return null
    let p = decodeURIComponent(u.pathname)
    // file:///C:/x → /C:/x → C:/x  (strip the leading slash before a drive letter)
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    return path.normalize(p)
  } catch {
    return null
  }
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  let start = hasStart ? parseInt(m[1], 10) : 0
  let end = hasEnd ? parseInt(m[2], 10) : size - 1
  if (!hasStart && hasEnd) {
    // suffix range: bytes=-N  → last N bytes
    const n = parseInt(m[2], 10)
    start = Math.max(0, size - n)
    end = size - 1
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null
  end = Math.min(end, size - 1)
  return { start, end }
}

/**
 * Robust `file://` handler for the renderer.
 *
 * Replaces `protocol.handle('file', net.fetch)`, which could not serve media:
 * it set no Content-Type and did not answer Range requests, so `<video>`/
 * `<audio>` elements (which require both to load and seek) failed while
 * `<img>` — lenient about MIME and range — worked. This streams the file with
 * the correct media Content-Type and full HTTP Range/206 support, so imported
 * videos preview, thumbnail, and report their real duration in dev and in
 * packaged builds alike.
 *
 * Non-media files (anything not in MEDIA_MIME) fall through to the previous
 * `net.fetch` behavior so app assets keep loading exactly as before.
 */
export function registerFileProtocol(): void {
  protocol.handle('file', (request) => {
    const filePath = fileUrlToPath(request.url)
    const ext = filePath ? path.extname(filePath).toLowerCase() : ''
    const mime = MEDIA_MIME[ext]

    // Only take over media loads; let everything else use the passthrough so
    // no existing app-asset loading behavior changes.
    if (!filePath || !mime) {
      return net.fetch(request, { bypassCustomProtocolHandlers: true })
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
      if (!stat.isFile()) throw new Error('not a file')
    } catch {
      logger.warn(`[file-protocol] not found: ${filePath}`)
      return new Response('Not found', { status: 404 })
    }

    const range = parseRange(request.headers.get('Range'), stat.size)
    const baseHeaders: Record<string, string> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    }

    try {
      if (range) {
        const stream = fs.createReadStream(filePath, { start: range.start, end: range.end })
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
            'Content-Length': String(range.end - range.start + 1),
          },
        })
      }
      const stream = fs.createReadStream(filePath)
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(stat.size) },
      })
    } catch (err) {
      logger.error(`[file-protocol] read failed for ${filePath}: ${String(err)}`)
      return new Response('Read error', { status: 500 })
    }
  })
}
