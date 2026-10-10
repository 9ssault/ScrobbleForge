import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_ID_KEY,
  SESSION_SCOPED_KEYS,
  bootstrapSession,
  discardSessionState,
  loadSessionIdentity,
  reconcileSession,
} from '../src/session';

// Minimal in-memory stand-in for window.localStorage.
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    snapshot: () => Object.fromEntries(map),
  };
}

function fakeFetcher(body: unknown, ok = true) {
  let calls = 0;
  const fetcher = (async () => { calls++; return { ok, json: async () => body } as Response; }) as typeof fetch;
  return { fetcher, calls: () => calls };
}

const session = (owner: string, legacyRows = 0) => ({ owner, legacyRows });

// Order matters in this file: loadSessionIdentity memoizes the identity for the page's lifetime,
// which is exactly the behaviour the last tests below pin down.

test('an unreachable or rejected identity endpoint leaves local state untouched', async () => {
  const { fetcher } = fakeFetcher({ error: 'nope' }, false);
  assert.equal(await loadSessionIdentity(fetcher), null);
  const storage = fakeStorage({ [SESSION_ID_KEY]: 'existing-session', scrobbleforge_queue: '[{"name":"keep"}]' });
  const result = await bootstrapSession(storage, fetcher);
  assert.equal(result.identity, null);
  assert.equal(result.fresh, false);
  assert.deepEqual(result.discarded, []);
  assert.deepEqual(storage.snapshot(), { [SESSION_ID_KEY]: 'existing-session', scrobbleforge_queue: '[{"name":"keep"}]' });
});

test('a new browser session discards the previous session workspace', async () => {
  const { fetcher } = fakeFetcher({ owner: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', legacyRows: 5081 });
  const storage = fakeStorage({
    [SESSION_ID_KEY]: '11111111-2222-3333-4444-555555555555',
    scrobbleforge_queue: '[{"name":"previous session queue","artist":"Artist"}]',
    scrobbleforge_last_live_timestamp: '1700000000000',
    scrobbleforge_creds: '{"apiKey":"previous"}',
    'scrobbleforge_player_mode': 'spotify',
  });
  const result = await bootstrapSession(storage, fetcher);
  assert.deepEqual(result.identity, session('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 5081));
  assert.equal(result.fresh, true);
  assert.deepEqual([...result.discarded].sort(), [...SESSION_SCOPED_KEYS].sort());
  const snapshot = storage.snapshot();
  for (const key of SESSION_SCOPED_KEYS) assert.equal(snapshot[key], undefined, `${key} must not leak into a new session`);
  assert.equal(snapshot[SESSION_ID_KEY], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(snapshot['scrobbleforge_player_mode'], 'spotify', 'non-session preferences are kept');
});

test('the same browser session keeps its workspace, and the identity is only fetched once', async () => {
  const { fetcher, calls } = fakeFetcher({ owner: 'ffffffff-0000-1111-2222-333333333333' });
  // This session already recorded its id when it bootstrapped, and it keeps its queue.
  const storage = fakeStorage({
    [SESSION_ID_KEY]: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    scrobbleforge_queue: '[{"name":"still mine","artist":"Artist"}]',
  });
  const result = await bootstrapSession(storage, fetcher);
  assert.equal(calls(), 0, 'the identity already resolved for this page is reused');
  assert.deepEqual(result.identity, session('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 5081));
  assert.equal(result.fresh, false);
  assert.equal(storage.getItem('scrobbleforge_queue'), '[{"name":"still mine","artist":"Artist"}]');
});

test('reconcileSession rotates only when the identity actually changes', () => {
  const storage = fakeStorage({
    [SESSION_ID_KEY]: '11111111-2222-3333-4444-555555555555',
    scrobbleforge_queue: '[]',
    scrobbleforge_last_live_timestamp: '123',
    scrobbleforge_creds: '{}',
  });

  const kept = reconcileSession(session('11111111-2222-3333-4444-555555555555'), storage);
  assert.equal(kept.fresh, false);
  assert.deepEqual(kept.discarded, []);
  assert.equal(storage.getItem('scrobbleforge_queue'), '[]');

  const rotated = reconcileSession(session('99999999-8888-7777-6666-555555555555'), storage);
  assert.equal(rotated.fresh, true);
  assert.deepEqual([...rotated.discarded].sort(), [...SESSION_SCOPED_KEYS].sort());
  assert.equal(storage.getItem(SESSION_ID_KEY), '99999999-8888-7777-6666-555555555555');
});

test('discardSessionState reports only the keys that were actually present', () => {
  const storage = fakeStorage({ scrobbleforge_queue: '[]' });
  assert.deepEqual(discardSessionState(storage), ['scrobbleforge_queue']);
  assert.deepEqual(discardSessionState(storage), []);
});
