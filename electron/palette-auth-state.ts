/**
 * State nonce for the directorsdesktop:// OAuth deep link.
 *
 * Custom-protocol URLs can be fired by any local app or web page
 * (`location='directorsdesktop://auth/callback?token=ATTACKER'`), so without a
 * state binding an attacker could inject their own Palette session (session
 * fixation). Mirroring the loopback flow in palette-auth-server.ts: sign-in
 * issues a single-use nonce embedded in the redirect URL (the /auth/desktop
 * bridge preserves the redirect's query params verbatim), and the deep-link
 * handler only forwards a token whose state matches.
 */

import crypto from 'crypto'

const STATE_TTL_MS = 10 * 60 * 1000 // sign-in flows finish well within 10 minutes

let pending: { nonce: string; expiresAt: number } | null = null

/** Mint a fresh single-use state nonce for an outgoing sign-in flow. */
export function issueDeepLinkState(): string {
  const nonce = crypto.randomBytes(16).toString('hex')
  pending = { nonce, expiresAt: Date.now() + STATE_TTL_MS }
  return nonce
}

/**
 * Verify + consume the state from an incoming deep link. True exactly once per
 * issued nonce, and only before expiry. Consumes on success AND on mismatch so
 * a guessed-wrong attempt can't be retried against the same nonce.
 */
export function consumeDeepLinkState(candidate: string | null): boolean {
  const current = pending
  pending = null
  if (!current || !candidate) return false
  if (Date.now() > current.expiresAt) return false
  const a = Buffer.from(current.nonce)
  const b = Buffer.from(candidate)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
