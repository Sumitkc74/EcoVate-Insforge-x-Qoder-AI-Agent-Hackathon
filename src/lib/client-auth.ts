/**
 * Client-side auth for API calls.
 *
 * Two kinds of session:
 * - Google sign-in: the access token lives in the SDK's in-memory
 *   session and is not exposed by getCurrentUser — but once the
 *   session is loaded, the SDK's HTTP client carries it in its
 *   Authorization header. So this helper first makes sure a session
 *   is loaded (getCurrentUser refreshes it via the httpOnly cookie
 *   when needed), then reads the token from the HTTP client.
 * - Anonymous (guest): the server issues a signed token at
 *   /api/anon-session, stored in localStorage. No Google account,
 *   2 scans and 2 verifications a day, history in this browser only.
 *
 * The token goes out as a Bearer header; the user id is never sent
 * in a body or query string anymore. When both exist, the Google
 * session wins (a guest who later signs in uses the Google account).
 */

import { auth, insforge } from './insforge';

export interface AnonSession {
  userId: string;
  token: string;
  name: string;
}

const ANON_STORAGE_KEY = 'ecovate_anon_session';

export function readAnonSession(): AnonSession | null {
  try {
    const raw = localStorage.getItem(ANON_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AnonSession>;
    if (typeof parsed.userId !== 'string' || typeof parsed.token !== 'string') return null;
    return { userId: parsed.userId, token: parsed.token, name: typeof parsed.name === 'string' ? parsed.name : 'Guest' };
  } catch {
    return null;
  }
}

export function saveAnonSession(session: AnonSession): void {
  try {
    localStorage.setItem(ANON_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Private mode / storage full: the guest session just won't persist.
  }
}

export function clearAnonSession(): void {
  try {
    localStorage.removeItem(ANON_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

// Keep the stored guest name in sync after a rename, so the header
// shows the new name on the next page load too.
export function updateAnonSessionName(name: string): void {
  const session = readAnonSession();
  if (session) saveAnonSession({ ...session, name });
}

export interface ClientIdentity {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
  isAnonymous: boolean;
}

// Whoever is using the app right now: Google user, or guest.
// The display name comes from the users row when one is set there
// (GET /api/profile), so a name the user picked themselves — not
// their Google name — shows in the header everywhere. The profile
// call never breaks sign-in: any failure falls back to the session
// identity below.
export async function getCurrentIdentity(): Promise<ClientIdentity | null> {
  let identity: ClientIdentity | null = null;
  try {
    const { data } = await auth.getCurrentUser();
    if (data?.user) {
      identity = {
        id: data.user.id,
        name: data.user.profile?.name || null,
        email: data.user.email,
        avatar: data.user.profile?.avatar_url || null,
        isAnonymous: false,
      };
    }
  } catch {
    // No Google session — fall through to the guest session.
  }
  if (!identity) {
    const anon = readAnonSession();
    if (anon) {
      identity = { id: anon.userId, name: anon.name, email: null, avatar: null, isAnonymous: true };
    }
  }
  if (!identity) return null;
  try {
    const response = await authedFetch('/api/profile');
    const profile = await readApiJson(response);
    if (response.ok && profile?.success) {
      if (typeof profile.name === 'string' && profile.name) identity.name = profile.name;
      if (typeof profile.avatar === 'string' && profile.avatar) identity.avatar = profile.avatar;
    }
  } catch {
    // Keep the session identity.
  }
  return identity;
}

export async function getAccessToken(): Promise<string | null> {
  try {
    const { data } = await auth.getCurrentUser();
    if (data?.user) {
      const headers = insforge.getHttpClient().getHeaders() as Record<string, string>;
      const header = headers['Authorization'] || headers['authorization'];
      if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
    }
  } catch {
    // No Google session — fall through to the guest session.
  }
  return readAnonSession()?.token ?? null;
}

// Signs out of Google (when signed in) and clears the guest session.
export async function signOutAll(): Promise<void> {
  try {
    await auth.signOut();
  } catch {
    // Already signed out.
  }
  clearAnonSession();
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// fetch() with the session token attached. On a 401 (expired token)
// refreshes the session once and retries.
export async function authedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = await authHeaders();
  let response = await fetch(input, {
    ...init,
    headers: { ...headers, ...(init?.headers || {}) },
  });
  if (response.status === 401) {
    const { data } = await auth.refreshSession();
    const fresh = (data as { accessToken?: string } | null)?.accessToken;
    if (fresh) {
      response = await fetch(input, {
        ...init,
        headers: { Authorization: `Bearer ${fresh}`, ...(init?.headers || {}) },
      });
    }
  }
  return response;
}

// Parse an API response body as JSON. Our routes always answer JSON,
// but the platform does not: when a function times out (60s limit)
// or the edge 502s, the body is a plain-text error page, not JSON.
// Parsing that with response.json() throws a confusing
// "Unexpected token ..." error that hides the real cause — a scan
// that timed out showed up as a JSON parse error instead of "the
// scan took too long". Read text first so a non-JSON body becomes
// a plain retry message instead.
export async function readApiJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      response.status === 504 || response.status === 502 || response.status === 503
        ? 'The request took too long — the AI services were slow. Please try again.'
        : 'The server did not return a usable response. Please try again.',
    );
  }
}
