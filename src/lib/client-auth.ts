/**
 * Client-side auth for API calls.
 *
 * The access token lives in the SDK's in-memory session and is not
 * exposed by getCurrentUser — but once the session is loaded, the
 * SDK's HTTP client carries it in its Authorization header. So this
 * helper first makes sure a session is loaded (getCurrentUser
 * refreshes it via the httpOnly cookie when needed), then reads the
 * token from the HTTP client. The token goes out as a Bearer header;
 * the user id is never sent in a body or query string anymore.
 */

import { auth, insforge } from './insforge';

export async function getAccessToken(): Promise<string | null> {
  try {
    const { data } = await auth.getCurrentUser();
    if (!data?.user) return null;
    const headers = insforge.getHttpClient().getHeaders() as Record<string, string>;
    const header = headers['Authorization'] || headers['authorization'];
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length);
  } catch {
    return null;
  }
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
