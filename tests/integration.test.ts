import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const credentials = { apiKey: 'test-key', apiSecret: 'secret-marker', sessionKey: 'session-marker', username: 'test-user', password: 'password-marker' };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await callback(); if (predicate(value)) return value; await delay(40); }
  throw new Error('Condition did not become true within the timeout');
}
async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'scrobbleforge-test-'));
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address() as net.AddressInfo;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const origin = `http://127.0.0.1:${address.port}`;
  let process: ChildProcess | undefined;
  let output = '';
  let cookie = '';
  const withCookie = (headers: Record<string, string> = {}) => (cookie ? { Cookie: cookie, ...headers } : headers);
  const capture = <T extends { headers: Headers }>(response: T) => {
    const set = response.headers.get('set-cookie');
    const match = set ? /sforge_session=[0-9a-fA-F-]{36}/.exec(set) : null;
    if (match) cookie = match[0];
    return response;
  };
  async function start() {
    process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--import', './tests/lastfm-fixture.mjs', globalThis.process.env.TEST_BUILT_SERVER === 'true' ? 'server.js' : 'server.ts'], {
      cwd: globalThis.process.cwd(), env: { ...globalThis.process.env, PORT: String(address.port), NODE_ENV: 'production', ACTIVITY_DB_PATH: path.join(dir, 'activity.sqlite'), LASTFM_CALL_LOG: path.join(dir, 'lastfm-calls.log'), LASTFM_API_KEY: 'test-key', LASTFM_API_SECRET: 'secret-marker' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout?.on('data', chunk => { output += chunk; }); process.stderr?.on('data', chunk => { output += chunk; });
    for (let i = 0; i < 100; i++) {
      if (process.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try { const response = capture(await fetch(`${origin}/api/job/status`, { headers: withCookie() })); if (response.ok) return; } catch { /* Wait for this owned child. */ }
      await delay(30);
    }
    throw new Error(`Server did not become ready: ${output}`);
  }
  async function stop() {
    if (process && process.exitCode === null) { const owned = process; await new Promise<void>(resolve => { owned.once('exit', () => resolve()); owned.kill('SIGTERM'); }); }
    process = undefined;
  }
  const get = async (route: string) => { const response = capture(await fetch(origin + route, { headers: withCookie() })); assert.equal(response.status, 200); return response.json(); };
  const post = async (route: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const response = capture(await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...withCookie(), ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  await start();
  return { origin, get, post, dir, cookie: () => cookie, headers: withCookie, restart: async () => { await stop(); await start(); }, close: async () => { await stop(); await rm(dir, { recursive: true, force: true }); } };
}

test('persistent journal records more than 500 events, pages/searches/exports and survives view clearing, new jobs and restart', async () => {
  const app = await harness();
  try {
    for (let i = 0; i < 260; i++) {
      const result = await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Artist', track: `accepted-${i}` });
      assert.equal(result.status, 200);
    }
    const summary = (await app.get('/api/activity/summary')).summary;
    assert.equal(summary.accepted, 260); assert.equal(summary.requests, 260); assert.ok(summary.totalEvents > 500);
    const page = await app.get('/api/activity?limit=100'); assert.equal(page.logs.length, 100); assert.equal(page.hasMore, true);
    const previous = await app.get(`/api/activity?before=${page.nextBefore}&limit=100`); assert.ok(previous.logs.at(-1).seq < page.logs[0].seq);
    const search = await app.get('/api/activity?search=accepted-0'); assert.ok(search.logs.some((log: any) => log.track === 'accepted-0'));
    await app.post('/api/job/clear-logs');
    assert.equal((await app.get('/api/activity/summary')).summary.accepted, 260);
    await app.post('/api/job/start', { artist: 'Dry artist', track: 'Dry track', limit: 1, interval: 0.5, jitter: false, isDryRun: true });
    const finished = await until(() => app.get('/api/job/status'), data => data.job.status === 'completed');
    assert.equal(finished.job.scrobblesCompleted, 0); assert.equal(finished.job.simulatedCount, 1); assert.equal(finished.job.lastScrobbleTime, null);
    await app.restart();
    assert.equal((await app.get('/api/activity/summary')).summary.accepted, 260);
    const response = await fetch(app.origin + '/api/activity/export', { headers: app.headers() }); assert.match(response.headers.get('content-type')!, /application\/x-ndjson/);
    const exported = await response.text(); const records = exported.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.length > 500); assert.equal(new Set(records.map(record => record.id)).size, records.length);
    for (const secret of ['password-marker', 'secret-marker', 'session-marker', 'test-key']) assert.ok(!exported.includes(secret), `${secret} leaked`);
  } finally { await app.close(); }
});

test('HTTP 429 (including non-JSON) and string code 26 are recorded centrally, with cooldowns and Retry-After', async () => {
  const app = await harness();
  try {
    const response = await fetch(app.origin + '/api/lastfm/search?track=http-limit&apiKey=test-key', { headers: app.headers() });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).errorCode, 26);
    let summary = (await app.get('/api/activity/summary')).summary;
    assert.equal(summary.rateLimitHits, 1);
    const deferred = await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Artist', track: 'accepted' });
    assert.equal(deferred.status, 429); assert.equal(deferred.headers.get('retry-after'), '1');
    assert.equal((await app.get('/api/activity/summary')).summary.rateLimitHits, 1);
    await delay(1100);
    const codeLimit = await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Artist', track: 'code-limit' });
    assert.equal(codeLimit.status, 429); assert.equal(codeLimit.data.errorCode, 26);
    summary = (await app.get('/api/activity/summary')).summary; assert.equal(summary.rateLimitHits, 2);
    const events = await app.get('/api/activity?level=rate_limit');
    assert.equal(events.logs.length, 2); assert.equal(events.logs[0].httpStatus, 429); assert.equal(events.logs[1].httpStatus, 200);
    assert.ok(events.logs.every((log: any) => log.requestId && log.retryAfterSeconds));
    await app.restart();
    assert.equal((await app.get('/api/activity/summary')).summary.rateLimitHits, 2);
  } finally { await app.close(); }
});

test('pause/resume preserves cooldown; automatic recovery retries an unaccepted track only', async () => {
  const app = await harness();
  try {
    await app.post('/api/job/start', { artist: 'Artist', track: 'cooldown-once', credentials, limit: 1, interval: 0.5, jitter: false });
    await until(() => app.get('/api/job/status'), data => data.job.status === 'rate_limited');
    assert.equal((await app.post('/api/job/pause')).data.job.status, 'paused');
    assert.equal((await app.post('/api/job/resume')).data.job.status, 'rate_limited');
    const complete = await until(() => app.get('/api/job/status'), data => data.job.status === 'completed');
    assert.equal(complete.job.scrobblesCompleted, 1); assert.equal(complete.job.failedCount, 0);
    const summary = (await app.get('/api/activity/summary')).summary; assert.equal(summary.accepted, 1); assert.equal(summary.requests, 2); assert.equal(summary.rateLimitHits, 1);
  } finally { await app.close(); }
});

test('ignored tracks, Now Playing failures, daily limit and uncertain outcomes never count as success', async () => {
  const app = await harness();
  try {
    const ignored = await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Artist', track: 'ignored' });
    assert.equal(ignored.status, 422); assert.equal(ignored.data.accepted, 0); assert.equal(ignored.data.ignored, 1);
    assert.equal((await app.post('/api/lastfm/now-playing', { ...credentials, artist: 'Artist', track: 'now-error' })).data.ok, false);
    const daily = await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Artist', track: 'daily-limit' }); assert.equal(daily.data.errorCode, 29);
    const malformed = await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Artist', track: 'malformed' }); assert.equal(malformed.data.uncertain, true);
    const network = await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Artist', track: 'network-fail' }); assert.equal(network.data.uncertain, true);
    const summary = (await app.get('/api/activity/summary')).summary; assert.equal(summary.accepted, 0); assert.equal(summary.ignored, 1); assert.equal(summary.uncertainRequests, 2); assert.equal(summary.rateLimitHits, 1);
    const raw = await (await fetch(app.origin + '/api/activity/export', { headers: app.headers() })).text(); assert.ok(!raw.includes('secret-marker')); assert.ok(!raw.includes('session-marker'));
  } finally { await app.close(); }
});

test('batch partial outcomes and historical timestamps stay correct, detailed and within bounds', async () => {
  const app = await harness();
  try {
    const endTime = Math.floor(Date.now() / 1000) - 5, startTime = endTime - 60;
    const result = await app.post('/api/job/batch-scrobble-all', { ...credentials, startTime, endTime, tracks: [{ name: 'accepted', artist: 'Artist' }, { name: 'ignored', artist: 'Artist' }, { name: 'accepted-2', artist: 'Artist' }] });
    assert.equal(result.data.ok, false); assert.equal(result.data.completed, 2); assert.equal(result.data.ignored, 1);
    const summary = (await app.get('/api/activity/summary')).summary; assert.equal(summary.accepted, 2); assert.equal(summary.ignored, 1);
    const logs = (await app.get('/api/activity')).logs.filter((log: any) => log.scrobbleTimestamp);
    assert.equal(logs.length, 3); assert.ok(logs.every((log: any) => log.scrobbleTimestamp >= startTime && log.scrobbleTimestamp <= endTime));
    assert.equal(new Set(logs.map((log: any) => log.jobId)).size, 1);
    assert.equal((await app.post('/api/job/batch-scrobble-all', { ...credentials, startTime: endTime - 20 * 86400, endTime, tracks: [{ name: 'accepted', artist: 'Artist' }] })).status, 400);
  } finally { await app.close(); }
});

test('stop during an in-flight submission blocks replacement and prevents another submission', async () => {
  const app = await harness();
  try {
    await app.post('/api/job/start', { artist: 'Artist', track: 'slow', credentials, limit: 3, interval: 0.5, jitter: false });
    await app.post('/api/job/stop');
    const replacement = await app.post('/api/job/start', { artist: 'Artist', track: 'accepted', credentials, limit: 1 }); assert.equal(replacement.data.ok, false);
    await delay(1000);
    const status = await app.get('/api/job/status'); assert.equal(status.job.status, 'idle'); assert.equal(status.job.scrobblesCompleted, 1);
    assert.equal((await app.get('/api/activity/summary')).summary.requests, 1);
  } finally { await app.close(); }
});

test('restart restores progress paused, not auto-submitting; disconnect clears job credentials', async () => {
  const app = await harness();
  try {
    const auth = await app.post('/api/lastfm/auth', { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret, username: 'test-user', password: 'password-marker' }); assert.equal(auth.data.ok, true);
    await app.post('/api/job/start', { artist: 'Artist', track: 'accepted', credentials, limit: 4, interval: 10, jitter: false });
    await until(() => app.get('/api/job/status'), data => data.job.scrobblesCompleted === 1);
    await app.restart();
    const restored = await app.get('/api/job/status'); assert.equal(restored.job.status, 'paused'); assert.equal(restored.job.scrobblesCompleted, 1);
    await app.post('/api/lastfm/disconnect');
    const attempt = await app.post('/api/lastfm/single-scrobble', { artist: 'Artist', track: 'accepted' }); assert.equal(attempt.status, 400);
    assert.equal((await app.get('/api/job/status')).job.status, 'idle');
  } finally { await app.close(); }
});

test('duplicate batches are rejected; cancellation retains accepted chunks', async () => {
  const app = await harness();
  try {
    const tracks = Array.from({ length: 51 }, () => ({ name: 'accepted', artist: 'Artist' }));
    const first = app.post('/api/job/batch-scrobble-all', { ...credentials, tracks, spanHours: 1 });
    await until(() => app.get('/api/job/batch-status'), data => data.batch.accepted === 50);
    assert.equal((await app.post('/api/job/batch-scrobble-all', { ...credentials, tracks })).status, 409);
    await app.post('/api/job/cancel-batch');
    const result = await first; assert.equal(result.data.cancelled, true); assert.equal(result.data.completed, 50);
    assert.equal((await app.get('/api/activity/summary')).summary.accepted, 50);
  } finally { await app.close(); }
});

test('profile page rate limits do not silently return a successful empty or partial import', async () => {
  const app = await harness();
  try {
    const response = await fetch(app.origin + '/api/lastfm/fetch-profile-tracks?apiKey=test-key&username=test-user&limit=10&pages=2', { headers: app.headers() });
    assert.equal(response.status, 429); assert.equal((await response.json()).ok, false);
    assert.equal((await app.get('/api/activity/summary')).summary.rateLimitHits, 1);
  } finally { await app.close(); }
});

test('foreign-Origin mutations, invalid queues and bad timestamps are rejected; SSE delivers real status/log events', async () => {
  const app = await harness();
  try {
    assert.equal((await app.post('/api/job/stop', {}, { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await app.post('/api/job/start', { artist: 'Artist', track: 'accepted', isDryRun: true, interval: -1 })).status, 400);
    assert.equal((await app.post('/api/job/start', { isDryRun: true, queueMode: 'queue_once', queue: [] })).status, 400);
    assert.equal((await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Artist', track: 'accepted', timestamp: Math.floor(Date.now()/1000) + 100 })).status, 400);
    const controller = new AbortController();
    const response = await fetch(app.origin + '/api/job/events', { signal: controller.signal, headers: app.headers() }); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader();
    const initial = await reader.read(); assert.match(new TextDecoder().decode(initial.value), /event: status/);
    await app.post('/api/job/start', { artist: 'Artist', track: 'dry', isDryRun: true, limit: 1, interval: 0.5 });
    const event = await reader.read(); assert.match(new TextDecoder().decode(event.value), /event: log/);
    controller.abort();
  } finally { await app.close(); }
});

test('daily ignored limit records a rate-limit event and stops the stream rather than hammering Last.fm', async () => {
  const app = await harness();
  try {
    await app.post('/api/job/start', { artist: 'Artist', track: 'daily-ignored', credentials, limit: 4, interval: 0.5, jitter: false });
    const result = await until(() => app.get('/api/job/status'), data => data.job.status === 'error');
    assert.equal(result.job.scrobblesCompleted, 0); assert.equal(result.job.ignoredCount, 1);
    await delay(700);
    const summary = (await app.get('/api/activity/summary')).summary;
    assert.equal(summary.rateLimitHits, 1); assert.equal(summary.requests, 1); assert.equal(summary.ignored, 1);
  } finally { await app.close(); }
});

test('AutoPlayer journals every completed play locally and makes zero Last.fm API calls', async () => {
  const app = await harness();
  try {
    const callLog = path.join(app.dir, 'lastfm-calls.log');
    assert.equal((await app.post('/api/player/start', { queue: [{ name: 'local', artist: 'Artist' }], trackDurationSeconds: 0.5 })).status, 400);
    assert.equal((await app.post('/api/player/start', { queue: [{ artist: 'Artist' }] })).status, 400);
    assert.equal((await app.post('/api/player/start', {}, { Origin: 'https://foreign.example' })).status, 403);
    const started = await app.post('/api/player/start', { queue: [{ name: 'local-a', artist: 'Artist' }, { name: 'local-b', artist: 'Artist' }], trackDurationSeconds: 1, loopQueue: false });
    assert.equal(started.status, 200); assert.equal(started.data.player.apiFree, true); assert.equal(started.data.player.status, 'playing');
    assert.equal((await app.post('/api/player/start', { queue: [{ name: 'blocked', artist: 'Artist' }] })).status, 409);
    assert.equal((await app.post('/api/player/pause')).data.player.status, 'paused');
    assert.equal((await app.post('/api/player/resume')).data.player.status, 'playing');
    const finished = await until(() => app.get('/api/player/status'), data => data.player.status === 'completed');
    assert.equal(finished.player.playsCompleted, 2);
    const summary = (await app.get('/api/activity/summary')).summary;
    assert.equal(summary.played, 2);
    assert.equal(summary.requests, 0); assert.equal(summary.accepted, 0); assert.equal(summary.ignored, 0);
    assert.equal(summary.rateLimitHits, 0); assert.equal(summary.simulated, 0); assert.equal(summary.uncertainRequests, 0);
    const journal = (await app.get('/api/activity?search=AutoPlayer')).logs;
    const plays = journal.filter((log: any) => log.outcome === 'played');
    assert.equal(plays.length, 2);
    assert.ok(plays.every((log: any) => log.category === 'player' && log.artist === 'Artist' && log.count >= 1 && log.durationMs >= 0));
    assert.equal(existsSync(callLog) ? readFileSync(callLog, 'utf8').trim() : '', '', 'AutoPlayer must not call the Last.fm API');
    // Control: the fixture does record real calls, so an empty log above really means "no API traffic".
    assert.equal((await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Artist', track: 'accepted' })).status, 200);
    assert.match(readFileSync(callLog, 'utf8'), /track\.scrobble/);
    const after = (await app.get('/api/activity/summary')).summary;
    assert.equal(after.played, 2); assert.equal(after.accepted, 1); assert.equal(after.requests, 1);
  } finally { await app.close(); }
});

test('Spotify playback reports journal completed plays locally and never call the Last.fm API', async () => {
  const app = await harness();
  try {
    assert.equal((await app.post('/api/player/played', { track: '', artist: 'Artist' })).status, 400);
    assert.equal((await app.post('/api/player/played', { track: 'Track', artist: '' })).status, 400);
    assert.equal((await app.post('/api/player/played', { track: 'Track', artist: 'Artist', album: 42 })).status, 400);
    assert.equal((await app.post('/api/player/played', { track: 'Track', artist: 'Artist' }, { Origin: 'https://foreign.example' })).status, 403);
    const before = (await app.get('/api/activity/summary')).summary.requests;
    assert.equal((await app.post('/api/player/played', { track: 'Spotify Track', artist: 'Spotify Artist', album: 'Spotify Album', durationMs: 123456, source: 'spotify', scrobbled: false, sessionId: 'spotify-session' })).status, 200);
    assert.equal((await app.post('/api/player/played', { track: 'Scrobbled Track', artist: 'Spotify Artist', durationMs: 60000, source: 'spotify', scrobbled: true, sessionId: 'spotify-session' })).status, 200);
    const summary = (await app.get('/api/activity/summary')).summary;
    assert.equal(summary.played, 2);
    assert.equal(summary.requests, before);
    assert.equal(summary.accepted, 0);
    const journal = (await app.get('/api/activity?search=Spotify%20Track')).logs;
    const play = journal.find((log: any) => log.track === 'Spotify Track');
    assert.ok(play, 'the completed play is journaled');
    assert.equal(play.category, 'player'); assert.equal(play.outcome, 'played');
    assert.equal(play.artist, 'Spotify Artist'); assert.equal(play.album, 'Spotify Album'); assert.equal(play.durationMs, 123456); assert.equal(play.jobId, 'spotify-session');
    const callLog = path.join(app.dir, 'lastfm-calls.log');
    assert.equal(existsSync(callLog) ? readFileSync(callLog, 'utf8').trim() : '', '', 'reporting a completed play must not call the Last.fm API');
  } finally { await app.close(); }
});

test('credentials are never reused across visitors and the server exposes no Last.fm key', async () => {
  const app = await harness();
  try {
    const callLog = path.join(app.dir, 'lastfm-calls.log');
    const scrobbles = () => (existsSync(callLog) ? readFileSync(callLog, 'utf8').split('track.scrobble').length - 1 : 0);

    // A visitor connects with their own credentials (this used to be cached server-side for everyone).
    assert.equal((await app.post('/api/lastfm/auth', { ...credentials })).status, 200);
    const established = scrobbles();

    // Every request without credentials must be refused instead of falling back to that session.
    assert.equal((await app.post('/api/lastfm/single-scrobble', { artist: 'Intruder', track: 'Intruder' })).status, 400);
    assert.equal((await app.post('/api/lastfm/now-playing', { artist: 'Intruder', track: 'Intruder' })).status, 400);
    assert.equal((await app.post('/api/job/batch-scrobble-all', { tracks: [{ name: 'Intruder', artist: 'Intruder' }], spanHours: 1 })).status, 400);
    assert.equal((await app.post('/api/job/start', { artist: 'Intruder', track: 'Intruder', limit: 1, interval: 0.5 })).status, 400);
    assert.equal((await fetch(app.origin + '/api/lastfm/search?track=intruder&artist=intruder')).status, 400);
    assert.equal(scrobbles(), established, 'no scrobble may be submitted without explicit credentials');

    // The server no longer publishes an API key of its own.
    const gone = await fetch(app.origin + '/api/lastfm/server-config');
    assert.equal(gone.status, 404);
    assert.ok(!(await gone.text()).includes('test-key'), 'no server API key may be served');

    // And it still works when the caller brings credentials.
    assert.equal((await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Operator', track: 'Own-track' })).status, 200);
    assert.equal(scrobbles(), established + 1);
  } finally { await app.close(); }
});

test('the first API response mints an HttpOnly, same-site session cookie that dies with the browser session', async () => {
  const app = await harness();
  try {
    const first = await fetch(app.origin + '/api/job/status');
    const setCookie = first.headers.get('set-cookie') || '';
    assert.match(setCookie, /sforge_session=[0-9a-f-]{36}/i);
    assert.doesNotMatch(setCookie, /sforge_owner/i, 'the retired persistent cookie must not be issued again');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    // A session cookie, not a persistent one: it must not outlive the browser session, so the next
    // browser session is a new, unique workspace.
    assert.doesNotMatch(setCookie, /Max-Age/i, 'the identity cookie must not persist past the session');
    assert.doesNotMatch(setCookie, /Expires/i, 'the identity cookie must not persist past the session');

    // Two browser sessions never share an identity.
    const second = await fetch(app.origin + '/api/job/status');
    assert.notEqual(second.headers.get('set-cookie'), setCookie, 'every browser session gets its own identity');
    const firstOwner = await (await fetch(app.origin + '/api/identity')).json();
    const secondOwner = await (await fetch(app.origin + '/api/identity')).json();
    assert.match(firstOwner.owner, /^[0-9a-f-]{36}$/i);
    assert.match(secondOwner.owner, /^[0-9a-f-]{36}$/i);
    assert.notEqual(firstOwner.owner, secondOwner.owner, 'each new browser session is unique');

    // A cookie from the old persistent scheme is not honoured: that browser gets a new session id.
    const legacyCookie = await (await fetch(app.origin + '/api/identity', { headers: { Cookie: 'sforge_owner=11111111-2222-3333-4444-555555555555' } })).json();
    assert.notEqual(legacyCookie.owner, '11111111-2222-3333-4444-555555555555', 'year-long identities are retired');
    assert.match(legacyCookie.owner, /^[0-9a-f-]{36}$/i);

    // The same session keeps its identity (this is what every tab in one browser shares).
    const repeated = await (await fetch(app.origin + '/api/identity', { headers: { Cookie: `sforge_session=${firstOwner.owner}` } })).json();
    assert.equal(repeated.owner, firstOwner.owner, 'a session keeps its identity for its lifetime');
  } finally { await app.close(); }
});

test('visitors are isolated: journals, jobs and player state belong to one browser', async () => {
  const app = await harness();
  try {
    const otherOwner = '11111111-2222-3333-4444-555555555555';
    const asOther = async (route: string, init: RequestInit = {}) => fetch(app.origin + route, { ...init, headers: { Cookie: `sforge_session=${otherOwner}`, ...(init.headers as Record<string, string> || {}) } });

    assert.equal((await app.post('/api/lastfm/single-scrobble', { ...credentials, artist: 'Operator', track: 'Operator-track' })).status, 200);
    assert.equal((await app.post('/api/job/start', { artist: 'Operator', track: 'Operator-track', credentials, isDryRun: true, limit: 5, interval: 5, jitter: false })).status, 200);
    assert.equal((await app.get('/api/activity/summary')).summary.accepted, 1);

    const otherSummary = await (await asOther('/api/activity/summary')).json();
    assert.equal(otherSummary.summary.accepted, 0);
    assert.equal(otherSummary.summary.totalEvents, 0);
    assert.equal((await (await asOther('/api/activity')).json()).logs.length, 0);
    assert.equal((await (await asOther('/api/activity/export')).text()).trim(), '', 'the other browser exports an empty journal');
    const otherStatus = await (await asOther('/api/job/status')).json();
    assert.equal(otherStatus.job.status, 'idle');
    assert.equal(otherStatus.job.scrobblesCompleted, 0);
    assert.equal((await asOther('/api/job/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
    assert.equal((await asOther('/api/job/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal((await app.get('/api/job/status')).job.status, 'running', 'the operator job is untouched');

    assert.equal((await (await asOther('/api/player/status')).json()).player.sessionId, null);
    assert.equal((await app.post('/api/player/start', { queue: [{ name: 'local', artist: 'Artist' }], trackDurationSeconds: 1, loopQueue: false })).status, 200);
    assert.equal((await (await asOther('/api/player/status')).json()).player.status, 'idle');

    await app.post('/api/player/stop');
    await app.post('/api/job/stop');
  } finally { await app.close(); }
});
