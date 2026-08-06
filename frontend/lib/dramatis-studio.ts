/**
 * dramatis-studio.ts — the renderer's client for the Dramatis Studio takes API
 * (surgical line regeneration). Same renderer-direct pattern as the Story
 * Stage's liveness probe: both apps are localhost, the backend guarantees
 * nothing here (pure reads on its side), and the Studio owns rendering.
 */
import type { AssetOrigin, AssetTake } from '../types/project'

export const DRAMATIS_STUDIO_URL = 'http://127.0.0.1:4600'

/** The record POST /api/takes/render returns (dramatis src/takes.mjs). */
export interface DramatisTakeRecord {
  lineId: string
  take: number
  key: string
  nonce: number | null
  engine: string
  voiceKey: string
  direction: string | null
  note: string | null
  text: string
  entity: string
  wav: string
  lvlWav: string | null
  dur: number
  renderedAt: string
  configHash: string
  existing?: boolean
}

/** An asset origin that can round-trip to the Studio for a new take. */
export function canRequestDramatisTake(origin: AssetOrigin | undefined): boolean {
  return !!origin
    && origin.app === 'dramatis'
    && origin.elementKind === 'line'
    && !!origin.bookId
    && !!origin.chapterNumber
    && !!origin.lineId
}

function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

/** Take record -> the AssetTake that lands on the clip's asset. Prefers the
 *  levelled wav (drop-in at timeline loudness); raw is the honest fallback. */
export function takeRecordToAssetTake(record: DramatisTakeRecord): AssetTake {
  const media = record.lvlWav || record.wav
  return {
    url: pathToFileUrl(media),
    path: media,
    createdAt: Date.parse(record.renderedAt) || Date.now(),
    note: record.note || (record.nonce != null ? `re-roll ${record.take}` : undefined),
  }
}

/**
 * Ask the Studio for a new take of one line. Throws with the server's own
 * message on refusal (stale chapter, GPU busy, undirectable engine…) so the
 * UI can show the real reason, not a generic failure.
 */
export async function requestDramatisTake(
  origin: AssetOrigin,
  note: string,
  opts?: { baseUrl?: string; engine?: string },
): Promise<DramatisTakeRecord> {
  const base = opts?.baseUrl ?? DRAMATIS_STUDIO_URL
  let res: Response
  try {
    res = await fetch(`${base}/api/takes/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        book: origin.bookId,
        chapter: origin.chapterNumber,
        line: origin.lineId,
        note: note.trim() || undefined,
        engine: opts?.engine,
      }),
    })
  } catch {
    throw new Error('Dramatis Studio is not running — start it from the Story Stage (or start-studio.cmd) and try again.')
  }
  const body = (await res.json().catch(() => ({}))) as { record?: DramatisTakeRecord; error?: string }
  if (!res.ok || !body.record) {
    throw new Error(body.error || `Studio refused the take (HTTP ${res.status})`)
  }
  return body.record
}

/** Fire-and-forget: tell dramatis which take the editor now uses, so the next
 *  produce renders the same selection (a book.json decision on its side). */
export function selectDramatisTake(origin: AssetOrigin, key: string | null, baseUrl?: string): void {
  void fetch(`${baseUrl ?? DRAMATIS_STUDIO_URL}/api/takes/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ book: origin.bookId, chapter: origin.chapterNumber, line: origin.lineId, key }),
  }).catch(() => { /* Studio offline — the editor's own take switch still applied */ })
}
