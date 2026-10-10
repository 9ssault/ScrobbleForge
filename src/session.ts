// Every browser session gets its own identity from the server. The identity cookie is a *session*
// cookie (no Max-Age), so it disappears when the browser closes and the next browser session mints a
// brand new, unique id; every tab in that browser still shares the one it has (cookies are per
// browser). Browser-local state that belongs to a session — the queue, the simulated clock and saved
// credential hints — is scoped the same way: when the identity changes, the previous session's
// leftovers are discarded so a new session starts from an empty workspace.

export const SESSION_ID_KEY = 'scrobbleforge_session_id';
export const SESSION_SCOPED_KEYS = ['scrobbleforge_queue', 'scrobbleforge_last_live_timestamp', 'scrobbleforge_creds'] as const;

export type SessionIdentity = { owner: string; legacyRows: number };
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let cached: SessionIdentity | null = null;

export function getCachedSession(): SessionIdentity | null { return cached; }

// Reads (and memoizes) the identity the server minted for this browser session.
export async function loadSessionIdentity(fetcher: typeof fetch = fetch): Promise<SessionIdentity | null> {
  if (cached) return cached;
  try {
    const response = await fetcher('/api/identity');
    if (!response.ok) return null;
    const data = await response.json() as { owner?: unknown; legacyRows?: unknown };
    if (typeof data.owner !== 'string' || !data.owner) return null;
    cached = { owner: data.owner, legacyRows: Number(data.legacyRows) || 0 };
    return cached;
  } catch { return null; }
}

export function discardSessionState(storage: StorageLike, keys: readonly string[] = SESSION_SCOPED_KEYS): string[] {
  const discarded: string[] = [];
  for (const key of keys) {
    try { if (storage.getItem(key) !== null) { storage.removeItem(key); discarded.push(key); } } catch { /* storage unavailable */ }
  }
  return discarded;
}

// Compares the identity this browser session is entitled to against the one stored locally. A
// different id means a new session, so its leftovers are dropped and the new id is recorded.
export function reconcileSession(identity: SessionIdentity | null, storage: StorageLike): { fresh: boolean; discarded: string[] } {
  if (!identity) return { fresh: false, discarded: [] };
  let previous: string | null = null;
  try { previous = storage.getItem(SESSION_ID_KEY); } catch { /* storage unavailable */ }
  if (previous && previous === identity.owner) return { fresh: false, discarded: [] };
  const discarded = discardSessionState(storage);
  try { storage.setItem(SESSION_ID_KEY, identity.owner); } catch { /* storage unavailable */ }
  return { fresh: true, discarded };
}

function browserStorage(): StorageLike | null {
  try { return window.localStorage; } catch { return null; }
}

// Runs before the first render so a brand new session never inherits the previous one's workspace.
export async function bootstrapSession(storage: StorageLike | null = browserStorage(), fetcher: typeof fetch = fetch): Promise<{ identity: SessionIdentity | null; fresh: boolean; discarded: string[] }> {
  const identity = await loadSessionIdentity(fetcher);
  if (!identity || !storage) return { identity, fresh: false, discarded: [] };
  return { identity, ...reconcileSession(identity, storage) };
}
