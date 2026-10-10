/**
 * Spotify playback bridge.
 *
 * Browser-side OAuth 2.0 Authorization Code + PKCE: no client secret is ever
 * requested, stored or transmitted. Tokens stay in this browser's storage and are
 * only ever sent to accounts.spotify.com / api.spotify.com.
 *
 * Playback happens inside Spotify: either on the Web Playback SDK device ("this
 * browser") or on any Spotify Connect device (phone, desktop, speaker, TV). Spotify
 * Premium is required by Spotify for playback control.
 *
 * Completed plays are reported through /api/player/played, and certified plays are
 * submitted to Last.fm through the regular scrobble endpoints - never from here.
 */

export const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
] as const;

export const SPOTIFY_REDIRECT_PATH = '/spotify-callback';
export const SPOTIFY_STORAGE_KEY = 'scrobbleforge_spotify_session';
export const SPOTIFY_CLIENT_ID_KEY = 'scrobbleforge_spotify_client_id';
const SPOTIFY_VERIFIER_KEY = 'scrobbleforge_spotify_pkce';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_URL = 'https://api.spotify.com/v1';
const SPOTIFY_SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

export interface SpotifySession {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  displayName?: string;
}

export interface SpotifyTrack {
  uri: string;
  id: string;
  name: string;
  artist: string;
  album: string;
  durationMs: number;
  image?: string;
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isPrivateSession: boolean;
  volumePercent: number | null;
}

export interface SpotifyPlayback {
  isPlaying: boolean;
  progressMs: number;
  track: SpotifyTrack | null;
  deviceId: string | null;
  deviceName: string | null;
  fetchedAt: number;
}

export interface ScrobbleDecision {
  eligible: boolean;
  reason: string;
}

declare global {
  interface Window {
    Spotify?: any;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (also covered by tests/spotify.test.ts)
// ---------------------------------------------------------------------------

export function normalizeForMatch(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\((?:feat|ft|with|remaster(?:ed)?|deluxe)[^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Last.fm scrobble rules: tracks must be longer than 30 seconds and count once the
 * listener has heard at least half the track or 4 minutes - whichever comes first.
 */
export function computeScrobbleDecision(durationMs: number, listenedMs: number): ScrobbleDecision {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const listened = Number.isFinite(listenedMs) ? Math.max(0, listenedMs) : 0;
  if (duration <= 30000) {
    return { eligible: false, reason: 'Last.fm only accepts tracks longer than 30 seconds.' };
  }
  const thresholdMs = Math.min(duration / 2, 240000);
  if (listened < thresholdMs) {
    return { eligible: false, reason: `Played ${Math.round(listened / 1000)}s of ${Math.round(duration / 1000)}s; Last.fm needs ${Math.round(thresholdMs / 1000)}s (half the track or four minutes, whichever comes first).` };
  }
  return { eligible: true, reason: 'Half the track (or four minutes) was played.' };
}

export function trackFromSpotifyItem(item: any): SpotifyTrack | null {
  if (!item || item.type !== 'track' || typeof item.uri !== 'string' || !item.uri.startsWith('spotify:track:')) return null;
  const artists = Array.isArray(item.artists) ? item.artists.map((artist: any) => artist?.name).filter((name: unknown) => typeof name === 'string' && name) : [];
  if (typeof item.name !== 'string' || !item.name) return null;
  if (!artists.length && typeof item.show?.publisher !== 'string') return null;
  const images = Array.isArray(item.album?.images) ? item.album.images : [];
  const image = images.map((entry: any) => entry?.url).find((url: unknown) => typeof url === 'string' && url.startsWith('https://'));
  return {
    uri: item.uri,
    id: typeof item.id === 'string' && item.id ? item.id : item.uri,
    name: item.name,
    artist: artists.length ? artists.join(', ') : String(item.show.publisher),
    album: typeof item.album?.name === 'string' ? item.album.name : '',
    durationMs: Number.isFinite(item.duration_ms) ? Math.max(0, Number(item.duration_ms)) : 0,
    image,
  };
}

export function scoreTrackMatch(wanted: { name: string; artist: string }, candidate: SpotifyTrack): number {
  const wantedName = normalizeForMatch(wanted.name);
  const candidateName = normalizeForMatch(candidate.name);
  if (!wantedName || !candidateName) return 0;

  let score: number;
  if (wantedName === candidateName) score = 60;
  else if (wantedName.includes(candidateName) || candidateName.includes(wantedName)) score = 40;
  else {
    const wantedTokens = new Set(wantedName.split(' '));
    const candidateTokens = candidateName.split(' ');
    const overlap = candidateTokens.filter(token => wantedTokens.has(token)).length;
    const union = new Set([...wantedTokens, ...candidateTokens]).size || 1;
    const similarity = overlap / union;
    if (similarity >= 0.6) score = 25;
    else if (similarity >= 0.4) score = 12;
    else return 0;
  }

  const wantedArtist = normalizeForMatch(wanted.artist);
  const candidateArtist = normalizeForMatch(candidate.artist);
  if (wantedArtist && candidateArtist) {
    if (wantedArtist === candidateArtist || wantedArtist.includes(candidateArtist) || candidateArtist.includes(wantedArtist)) score += 40;
    else {
      const wantedLead = wantedArtist.split(' ')[0];
      const candidateLead = candidateArtist.split(' ')[0];
      if (wantedLead && candidateLead && wantedLead === candidateLead) score += 20;
      else return 0;
    }
  }
  return score;
}

export function pickBestTrackMatch(wanted: { name: string; artist: string }, candidates: SpotifyTrack[], minimumScore = 60): SpotifyTrack | null {
  let best: SpotifyTrack | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreTrackMatch(wanted, candidate);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return bestScore >= minimumScore ? best : null;
}

export function buildSpotifyAuthorizeUrl(params: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: SPOTIFY_SCOPES.join(' '),
    state: params.state,
    code_challenge_method: 'S256',
    code_challenge: params.codeChallenge,
  });
  return `https://accounts.spotify.com/authorize?${query.toString()}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomUrlSafe(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomUrlSafe(64);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

// ---------------------------------------------------------------------------
// Session storage and token lifecycle
// ---------------------------------------------------------------------------

export function loadSpotifySession(): SpotifySession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SPOTIFY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.accessToken !== 'string' || typeof parsed?.refreshToken !== 'string' || typeof parsed?.clientId !== 'string') return null;
    return { clientId: parsed.clientId, accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: Number(parsed.expiresAt) || 0, scope: typeof parsed.scope === 'string' ? parsed.scope : '', displayName: typeof parsed.displayName === 'string' ? parsed.displayName : undefined };
  } catch { return null; }
}

export function saveSpotifySession(session: SpotifySession | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (session) window.localStorage.setItem(SPOTIFY_STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(SPOTIFY_STORAGE_KEY);
  } catch { /* Private mode: the session simply will not survive a reload. */ }
}

export function loadSpotifyClientId(serverClientId: string | null): string {
  if (typeof window !== 'undefined') {
    try { const stored = window.localStorage.getItem(SPOTIFY_CLIENT_ID_KEY); if (stored) return stored; } catch { /* ignore */ }
  }
  return serverClientId || '';
}

export function saveSpotifyClientId(clientId: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(SPOTIFY_CLIENT_ID_KEY, clientId.trim()); } catch { /* ignore */ }
}

export function spotifyRedirectUri(): string {
  if (typeof window === 'undefined') return SPOTIFY_REDIRECT_PATH;
  return `${window.location.origin}${SPOTIFY_REDIRECT_PATH}`;
}

async function requestSpotifyTokens(body: Record<string, string>): Promise<any> {
  const response = await fetch(SPOTIFY_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw new Error(data?.error_description || data?.error || `Spotify token request failed (HTTP ${response.status}).`);
  return data;
}

export async function exchangeSpotifyCode(params: { clientId: string; code: string; verifier: string; redirectUri: string }): Promise<SpotifySession> {
  const data = await requestSpotifyTokens({ grant_type: 'authorization_code', code: params.code, redirect_uri: params.redirectUri, client_id: params.clientId, code_verifier: params.verifier });
  const session: SpotifySession = { clientId: params.clientId, accessToken: String(data?.access_token || ''), refreshToken: String(data?.refresh_token || ''), expiresAt: Date.now() + Math.max(60, Number(data?.expires_in) || 3600) * 1000, scope: String(data?.scope || '') };
  if (!session.accessToken || !session.refreshToken) throw new Error('Spotify did not return a usable token pair. Remove the app from your Spotify account and connect again.');
  return session;
}

export async function refreshSpotifySession(session: SpotifySession): Promise<SpotifySession> {
  const data = await requestSpotifyTokens({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId });
  const refreshed: SpotifySession = { ...session, accessToken: String(data?.access_token || ''), expiresAt: Date.now() + Math.max(60, Number(data?.expires_in) || 3600) * 1000, scope: String(data?.scope || session.scope || '') };
  if (!refreshed.accessToken) throw new Error('Spotify did not return a refreshed access token.');
  return refreshed;
}

export async function ensureSpotifyToken(session: SpotifySession): Promise<string> {
  if (session.expiresAt - Date.now() > 60000) return session.accessToken;
  const refreshed = await refreshSpotifySession(session);
  saveSpotifySession(refreshed);
  return refreshed.accessToken;
}

// ---------------------------------------------------------------------------
// OAuth redirect orchestration (called once from App)
// ---------------------------------------------------------------------------

export async function beginSpotifyAuth(clientId: string): Promise<void> {
  const trimmed = clientId.trim();
  if (!trimmed) throw new Error('Enter your Spotify application Client ID first.');
  if (typeof window === 'undefined') throw new Error('Spotify authorization requires a browser.');
  const { verifier, challenge } = await createPkcePair();
  const state = randomUrlSafe(16);
  try { window.sessionStorage.setItem(SPOTIFY_VERIFIER_KEY, JSON.stringify({ verifier, state, clientId: trimmed })); }
  catch { throw new Error('This browser could not store the PKCE verifier required by Spotify.'); }
  saveSpotifyClientId(trimmed);
  window.location.assign(buildSpotifyAuthorizeUrl({ clientId: trimmed, redirectUri: spotifyRedirectUri(), state, codeChallenge: challenge }));
}

export async function handleSpotifyRedirect(): Promise<{ ok: boolean; message: string } | null> {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  if (url.pathname !== SPOTIFY_REDIRECT_PATH) return null;

  let stored: { verifier?: string; state?: string; clientId?: string } | null = null;
  try { stored = JSON.parse(window.sessionStorage.getItem(SPOTIFY_VERIFIER_KEY) || 'null'); } catch { stored = null; }
  window.history.replaceState({}, '', '/');

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (error) {
    window.sessionStorage.removeItem(SPOTIFY_VERIFIER_KEY);
    return { ok: false, message: `Spotify authorization failed: ${error}.` };
  }
  if (!code || !stored?.verifier || !stored.clientId) return { ok: false, message: 'Spotify authorization returned without a stored PKCE verifier. Connect again from the Auto player tab.' };
  if (url.searchParams.get('state') !== stored.state) return { ok: false, message: 'Spotify authorization state mismatch. Connect again from the Auto player tab.' };
  window.sessionStorage.removeItem(SPOTIFY_VERIFIER_KEY);
  try {
    const session = await exchangeSpotifyCode({ clientId: stored.clientId, code, verifier: stored.verifier, redirectUri: spotifyRedirectUri() });
    session.displayName = (await fetchSpotifyProfile(session).catch(() => null)) || undefined;
    saveSpotifySession(session);
    return { ok: true, message: `Spotify connected${session.displayName ? ` as ${session.displayName}` : ''}. Pick a device in the Auto player tab and start playback.` };
  } catch (err: any) {
    return { ok: false, message: err?.message || 'Spotify token exchange failed.' };
  }
}

// ---------------------------------------------------------------------------
// Web API helpers
// ---------------------------------------------------------------------------

export function spotifyErrorMessage(result: { status: number; data: any } | null | undefined, fallback: string): string {
  const reason = result?.data?.error?.message || result?.data?.error_description || (typeof result?.data?.error === 'string' ? result.data.error : null);
  if (result?.status === 401) return 'Spotify session expired or was revoked. Disconnect and connect again.';
  if (result?.status === 403 && /premium/i.test(String(reason || ''))) return 'Spotify Premium is required for playback control.';
  if (result?.status === 403) return 'Spotify refused the request (403). Playback control needs Spotify Premium, and development-mode apps must add this account under Users Management.';
  if (result?.status === 404) return 'No active Spotify device was found. Start Spotify on a device or enable this browser as a player, then try again.';
  if (result?.status === 429) return 'Spotify rate limit reached. Wait a moment and try again.';
  return reason ? `${fallback} (${reason})` : `${fallback} (HTTP ${result?.status ?? 'unreachable'})`;
}

export async function spotifyFetch(session: SpotifySession, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> {
  const token = await ensureSpotifyToken(session);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> || {}) };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${SPOTIFY_API_URL}${path}`, { ...init, headers });
  if (response.status === 204) return { ok: true, status: 204, data: null };
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: response.ok, status: response.status, data };
}

export async function fetchSpotifyProfile(session: SpotifySession): Promise<string | null> {
  const result = await spotifyFetch(session, '/me');
  if (!result.ok || !result.data) return null;
  if (typeof result.data.display_name === 'string' && result.data.display_name.trim()) return result.data.display_name.trim();
  return typeof result.data.id === 'string' ? result.data.id : null;
}

export async function fetchSpotifyDevices(session: SpotifySession): Promise<SpotifyDevice[]> {
  const result = await spotifyFetch(session, '/me/player/devices');
  if (!result.ok) throw new Error(spotifyErrorMessage(result, 'Spotify could not list playback devices.'));
  const devices = Array.isArray(result.data?.devices) ? result.data.devices : [];
  return devices
    .filter((device: any) => device && typeof device.id === 'string' && device.id)
    .map((device: any): SpotifyDevice => ({
      id: device.id,
      name: typeof device.name === 'string' ? device.name : 'Unknown device',
      type: typeof device.type === 'string' ? device.type : 'Unknown',
      isActive: device.is_active === true,
      isPrivateSession: device.is_private_session === true,
      volumePercent: Number.isFinite(device.volume_percent) ? Number(device.volume_percent) : null,
    }));
}

export async function fetchSpotifyPlayback(session: SpotifySession): Promise<SpotifyPlayback> {
  const result = await spotifyFetch(session, '/me/player');
  const fetchedAt = Date.now();
  if (result.status === 204) return { isPlaying: false, progressMs: 0, track: null, deviceId: null, deviceName: null, fetchedAt };
  if (!result.ok || !result.data) throw new Error(spotifyErrorMessage(result, 'Spotify could not read the current playback state.'));
  return {
    isPlaying: result.data.is_playing === true,
    progressMs: Number.isFinite(result.data.progress_ms) ? Math.max(0, Number(result.data.progress_ms)) : 0,
    track: trackFromSpotifyItem(result.data.item),
    deviceId: typeof result.data.device?.id === 'string' ? result.data.device.id : null,
    deviceName: typeof result.data.device?.name === 'string' ? result.data.device.name : null,
    fetchedAt,
  };
}

export async function searchSpotifyTrack(session: SpotifySession, wanted: { name: string; artist: string }): Promise<SpotifyTrack | null> {
  const query = `track:${wanted.name.replace(/["']/g, ' ')} artist:${wanted.artist.replace(/["']/g, ' ')}`;
  const result = await spotifyFetch(session, `/search?type=track&limit=5&q=${encodeURIComponent(query)}`);
  if (!result.ok) throw new Error(spotifyErrorMessage(result, 'Spotify search failed.'));
  const candidates = (Array.isArray(result.data?.tracks?.items) ? result.data.tracks.items : [])
    .map(trackFromSpotifyItem)
    .filter((track: SpotifyTrack | null): track is SpotifyTrack => Boolean(track));
  return pickBestTrackMatch(wanted, candidates);
}

export async function startSpotifyPlayback(session: SpotifySession, deviceId: string, uris: string[]): Promise<{ ok: boolean; status: number; message: string }> {
  const result = await spotifyFetch(session, `/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT', body: JSON.stringify({ uris }) });
  return { ok: result.ok, status: result.status, message: result.ok ? '' : spotifyErrorMessage(result, 'Spotify refused to start playback.') };
}

export async function pauseSpotifyPlayback(session: SpotifySession, deviceId?: string | null): Promise<{ ok: boolean; message: string }> {
  const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  const result = await spotifyFetch(session, `/me/player/pause${suffix}`, { method: 'PUT' });
  return { ok: result.ok, message: result.ok ? '' : spotifyErrorMessage(result, 'Spotify refused to pause.') };
}

export async function resumeSpotifyPlayback(session: SpotifySession, deviceId?: string | null): Promise<{ ok: boolean; message: string }> {
  const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  const result = await spotifyFetch(session, `/me/player/play${suffix}`, { method: 'PUT' });
  return { ok: result.ok, message: result.ok ? '' : spotifyErrorMessage(result, 'Spotify refused to resume.') };
}

export async function skipSpotifyTrack(session: SpotifySession, deviceId?: string | null): Promise<{ ok: boolean; message: string }> {
  const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  const result = await spotifyFetch(session, `/me/player/next${suffix}`, { method: 'POST' });
  return { ok: result.ok, message: result.ok ? '' : spotifyErrorMessage(result, 'Spotify refused to skip.') };
}

export async function transferSpotifyPlayback(session: SpotifySession, deviceId: string): Promise<{ ok: boolean; message: string }> {
  const result = await spotifyFetch(session, '/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play: false }) });
  return { ok: result.ok, message: result.ok ? '' : spotifyErrorMessage(result, 'Spotify refused to move playback to that device.') };
}

// ---------------------------------------------------------------------------
// Web Playback SDK ("this browser" as a Spotify device)
// ---------------------------------------------------------------------------

let spotifySdkPromise: Promise<void> | null = null;

export function loadSpotifySdk(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.reject(new Error('The Spotify player requires a browser.'));
  if (window.Spotify) return Promise.resolve();
  if (!spotifySdkPromise) {
    spotifySdkPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SPOTIFY_SDK_URL;
      script.async = true;
      script.onerror = () => { spotifySdkPromise = null; reject(new Error('The Spotify playback SDK could not be loaded. Check the network connection or use the Spotify app on a device instead.')); };
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      document.body.appendChild(script);
    });
  }
  return spotifySdkPromise;
}
