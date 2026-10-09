// Loaded only in isolated regression-test children. No live Last.fm calls are made.
import { appendFileSync } from 'node:fs';
const realFetch = globalThis.fetch;
const callLog = process.env.LASTFM_CALL_LOG;
let cooldownAttempts = 0;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('https://ws.audioscrobbler.com/2.0/')) return realFetch(input, init);
  const params = init?.method === 'POST' ? new URLSearchParams(init.body) : new URL(url).searchParams;
  if (callLog) { try { appendFileSync(callLog, `${init?.method || 'GET'} ${params.get('method')}\n`); } catch { /* test aid only */ } }
  const method = params.get('method');
  const track = params.get('track[0]') || params.get('track') || params.get('artist') || '';
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (params.get('api_key') !== 'test-key') return json({ error: 10, message: 'Never log this password-marker secret-marker session-marker' });
  if (track === 'http-limit') return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '1' } });
  if (track === 'code-limit') return json({ error: '26', message: 'Rate limit' }, 200, { 'Retry-After': new Date(Date.now() + 1500).toUTCString() });
  if (track === 'cooldown-once' && cooldownAttempts++ === 0) return json({ error: 26 }, 200, { 'Retry-After': '1' });
  if (track === 'daily-limit') return json({ error: 29, message: 'secret-marker' });
  if (track === 'bad-session') return json({ error: 9 });
  if (track === 'malformed') return new Response('<html>Error</html>', { headers: { 'Content-Type': 'text/html' } });
  if (track === 'network-fail') throw new Error('Do not log session-marker');
  if (track === 'slow') await new Promise(resolve => setTimeout(resolve, 350));
  if (method === 'auth.getMobileSession') return json({ session: { key: 'session-marker', name: 'test-user' } });
  if (method === 'user.getInfo') return json({ user: { name: 'test-user', playcount: '20', url: 'https://www.last.fm/user/test-user' } });
  if (method === 'track.updateNowPlaying') return track === 'now-error' ? json({ error: 6 }) : json({ nowplaying: { ignoredMessage: { code: '0' } } });
  if (method === 'track.search') return json({ results: { trackmatches: { track: [] } } });
  if (method === 'artist.search') return json({ results: { artistmatches: { artist: [] } } });
  if (method === 'user.getRecentTracks') {
    if (params.get('page') === '2') return json({ error: 26 }, 200, { 'Retry-After': '1' });
    return json({ recenttracks: { track: Array.from({ length: 10 }, (_, i) => ({ name: `Track ${i}`, artist: { name: 'Artist' }, date: { uts: '100' } })) } });
  }
  if (method === 'track.scrobble') {
    const names = [...params.keys()].filter(key => /^track\[\d+\]$/.test(key)).map(key => params.get(key));
    const entries = names.map((name, i) => ({ track: { '#text': name }, artist: { '#text': params.get(`artist[${i}]`) }, ignoredMessage: { code: name === 'ignored' || name === 'daily-ignored' ? name === 'ignored' ? '3' : '5' : '0', '#text': 'secret-marker' } }));
    const ignored = entries.filter(entry => entry.ignoredMessage.code !== '0').length;
    return json({ scrobbles: { '@attr': { accepted: String(names.length - ignored), ignored: String(ignored) }, scrobble: entries.length === 1 ? entries[0] : entries } });
  }
  return json({ error: 6 });
};
