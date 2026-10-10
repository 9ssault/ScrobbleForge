import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPOTIFY_REDIRECT_PATH,
  SPOTIFY_SCOPES,
  buildSpotifyAuthorizeUrl,
  computeScrobbleDecision,
  createPkcePair,
  normalizeForMatch,
  pickBestTrackMatch,
  scoreTrackMatch,
  spotifyErrorMessage,
  trackFromSpotifyItem,
  type SpotifyTrack,
} from '../src/spotify';

test('Last.fm scrobble eligibility follows the 30 second / 50% / 4 minute rules', () => {
  assert.equal(computeScrobbleDecision(30000, 30000).eligible, false, 'exactly 30s tracks are not eligible');
  assert.equal(computeScrobbleDecision(31000, 15000).eligible, false);
  assert.equal(computeScrobbleDecision(31000, 15500).eligible, true);
  assert.equal(computeScrobbleDecision(600000, 239000).eligible, false);
  assert.equal(computeScrobbleDecision(600000, 240000).eligible, true);
  assert.equal(computeScrobbleDecision(120000, 60000).eligible, true);
  assert.equal(computeScrobbleDecision(Number.NaN, 0).eligible, false);
  assert.match(computeScrobbleDecision(600000, 60000).reason, /half the track or four minutes/i);
});

test('queue tracks are matched to Spotify results without picking the wrong artist', () => {
  assert.equal(normalizeForMatch('Beyoncé — Song (feat. X) [Remastered]'), 'beyonce song');
  const cover = trackFromSpotifyItem({ type: 'track', uri: 'spotify:track:cover', id: 'cover', name: 'Kill Bill', duration_ms: 180000, artists: [{ name: 'Someone Else' }], album: { name: 'Cover', images: [] } }) as SpotifyTrack;
  const original = trackFromSpotifyItem({ type: 'track', uri: 'spotify:track:original', id: 'original', name: 'Kill Bill', duration_ms: 200000, artists: [{ name: 'SZA' }], album: { name: 'SOS', images: [{ url: 'https://i.scdn.co/image/abc' }] } }) as SpotifyTrack;
  assert.equal(scoreTrackMatch({ name: 'Kill Bill', artist: 'SZA' }, cover), 0);
  assert.ok(scoreTrackMatch({ name: 'Kill Bill', artist: 'SZA' }, original) >= 60);
  assert.equal(pickBestTrackMatch({ name: 'Kill Bill', artist: 'SZA' }, [cover, original])?.uri, 'spotify:track:original');
  const featured = trackFromSpotifyItem({ type: 'track', uri: 'spotify:track:feat', id: 'feat', name: 'Song', duration_ms: 100000, artists: [{ name: 'Some Artist (feat. Guest)' }], album: { name: 'Album', images: [] } }) as SpotifyTrack;
  assert.ok(scoreTrackMatch({ name: 'Song', artist: 'Some Artist' }, featured) >= 80, 'featured credits still match the base artist');
  assert.equal(pickBestTrackMatch({ name: 'Unknown Track', artist: 'Unknown Artist' }, [original]), null);
});

test('only real Spotify tracks are accepted as playback entries', () => {
  assert.equal(trackFromSpotifyItem(null), null);
  assert.equal(trackFromSpotifyItem({ type: 'episode', uri: 'spotify:episode:1', name: 'Podcast' }), null);
  assert.equal(trackFromSpotifyItem({ type: 'track', uri: 'spotify:local:file', name: 'Local file' }), null);
  assert.equal(trackFromSpotifyItem({ type: 'track', uri: 'spotify:track:x', name: '' }), null);
  const track = trackFromSpotifyItem({ type: 'track', uri: 'spotify:track:x', id: 'x', name: 'T', duration_ms: 12345, artists: [{ name: 'A' }, { name: 'B' }], album: { name: 'Alb', images: [{ url: 'https://i.scdn.co/image/x' }] } }) as SpotifyTrack;
  assert.equal(track.artist, 'A, B');
  assert.equal(track.durationMs, 12345);
  assert.equal(track.album, 'Alb');
  assert.equal(track.image, 'https://i.scdn.co/image/x');
});

test('the authorize URL requests PKCE with S256 and every playback scope', () => {
  const url = new URL(buildSpotifyAuthorizeUrl({ clientId: 'client-123', redirectUri: 'https://example.test/spotify-callback', state: 'state-1', codeChallenge: 'challenge-1' }));
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.spotify.com/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.test/spotify-callback');
  assert.equal(url.searchParams.get('state'), 'state-1');
  const scopes = (url.searchParams.get('scope') || '').split(' ');
  for (const scope of SPOTIFY_SCOPES) assert.ok(scopes.includes(scope), `missing scope ${scope}`);
  assert.ok(scopes.includes('user-modify-playback-state'));
  assert.equal(SPOTIFY_REDIRECT_PATH, '/spotify-callback');
});

test('PKCE verifiers are URL-safe, long enough and hash to the challenge', async () => {
  const { verifier, challenge } = await createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9\-_]{43}$/);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const expected = Buffer.from(new Uint8Array(digest)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected);
  const second = await createPkcePair();
  assert.notEqual(second.verifier, verifier);
});

test('Spotify API failures become actionable messages', () => {
  assert.match(spotifyErrorMessage({ status: 403, data: { error: { message: 'Player command failed: Premium required' } } }, 'fallback'), /Premium is required/);
  assert.match(spotifyErrorMessage({ status: 403, data: null }, 'fallback'), /Premium/);
  assert.match(spotifyErrorMessage({ status: 401, data: null }, 'fallback'), /expired or was revoked/);
  assert.match(spotifyErrorMessage({ status: 404, data: null }, 'fallback'), /No active Spotify device/);
  assert.match(spotifyErrorMessage({ status: 429, data: null }, 'fallback'), /rate limit/i);
  assert.match(spotifyErrorMessage({ status: 500, data: { error: { message: 'Boom' } } }, 'Playback failed'), /Playback failed \(Boom\)/);
});
