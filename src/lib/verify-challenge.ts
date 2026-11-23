/**
 * One-time verification challenge codes.
 *
 * Points require fresh evidence: the server issues a short code, the
 * user writes it on paper, places it beside the finished project and
 * photographs both with the in-app camera. The code is bound to one
 * scan and expires after 15 minutes, so a photo taken before the code
 * existed cannot earn points.
 *
 * No database table: the issued code travels as a server-signed token
 * (HMAC-SHA256 with the service key, same pattern as the signed
 * image URLs). The client cannot forge a token for a code it was
 * never issued. What the token cannot enforce on its own is strict
 * single use — a token from a failed attempt can be presented again
 * for the same scan until it expires. That is bounded: the token is
 * tied to one scan, it expires in 15 minutes, and only one award
 * per project is ever possible (the 409 guard in /api/verify).
 * A retry always requests a fresh code in the UI, so in practice a
 * failed code is abandoned, not reused. If strict single use is
 * ever needed, this is the place to add a challenges table.
 *
 * Server-only: the service key never leaves the server.
 */

// Unambiguous characters only: no 0/O, 1/I/L.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CHALLENGE_CODE_LENGTH = 4;
export const CHALLENGE_TTL_SECONDS = 15 * 60;

export function generateChallengeCode(): string {
  let code = '';
  for (let i = 0; i < CHALLENGE_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** Uppercase, whitespace stripped — what the model reads vs. what was issued. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function signChallenge(scanId: string, code: string, exp: number): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(process.env.INSFORGE_SERVICE_KEY || ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(`verify-challenge:${scanId}:${code}:${exp}`),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Mint a token for a freshly issued code. Format: scanId.code.exp.sig */
export async function createChallengeToken(scanId: string, code: string): Promise<{ token: string; expiresAt: number }> {
  const exp = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;
  const sig = await signChallenge(scanId, code, exp);
  return { token: `${scanId}.${code}.${exp}.${sig}`, expiresAt: exp * 1000 };
}

export type ChallengeValidation =
  | { ok: true; code: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'mismatch' };

/** Validate a presented token against the scan it is being used for. */
export async function validateChallengeToken(token: string, scanId: string): Promise<ChallengeValidation> {
  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'invalid' };
  const [tokenScanId, code, expStr, sig] = parts;
  const exp = Number(expStr);
  if (tokenScanId !== scanId) return { ok: false, reason: 'mismatch' };
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return { ok: false, reason: 'expired' };
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'invalid' };
  const expected = await signChallenge(tokenScanId, code, exp);
  if (expected.length !== sig.length) return { ok: false, reason: 'invalid' };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: 'invalid' };
  return { ok: true, code };
}
