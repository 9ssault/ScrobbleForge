import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, ListMusic, Loader2, LogOut, MonitorSpeaker, Music, Pause, Play, Radio, RefreshCw, SkipForward, Square, Waves } from 'lucide-react';
import type { QueueTrack } from '../types';
import {
  beginSpotifyAuth,
  computeScrobbleDecision,
  ensureSpotifyToken,
  fetchSpotifyDevices,
  fetchSpotifyPlayback,
  loadSpotifyClientId,
  loadSpotifySdk,
  loadSpotifySession,
  pauseSpotifyPlayback,
  resumeSpotifyPlayback,
  saveSpotifyClientId,
  saveSpotifySession,
  searchSpotifyTrack,
  skipSpotifyTrack,
  spotifyRedirectUri,
  startSpotifyPlayback,
  type SpotifyDevice,
  type SpotifyPlayback,
  type SpotifySession,
  type SpotifyTrack,
} from '../spotify';

const MAX_RESOLVE = 100;
const POLL_INTERVAL_MS = 3000;
const RESOLVE_CONCURRENCY = 3;

interface SpotifyPlayerProps {
  queue: QueueTrack[];
  isLastFmConnected: boolean;
  onScrobble: (artist: string, track: string, album: string, timestamp?: number) => Promise<boolean>;
  onNowPlaying: (artist: string, track: string, album: string) => Promise<boolean>;
}

interface FeedEntry { id: string; at: number; text: string; tone: 'info' | 'success' | 'warn' | 'error'; }
interface PlayEntry { track: SpotifyTrack; startedAt: number; listenedMs: number; finalized: boolean; }

const toneClass: Record<FeedEntry['tone'], string> = { info: 'text-zinc-400', success: 'text-emerald-400', warn: 'text-amber-400', error: 'text-rose-400' };
const randomId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
const formatClock = (ms: number) => { const total = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; };

export const SpotifyPlayer: React.FC<SpotifyPlayerProps> = ({ queue, isLastFmConnected, onScrobble, onNowPlaying }) => {
  const [session, setSession] = useState<SpotifySession | null>(() => loadSpotifySession());
  const [clientId, setClientId] = useState(() => loadSpotifyClientId());
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<SpotifyDevice[]>([]);
  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [useBrowserDevice, setUseBrowserDevice] = useState(false);
  const [sdkDeviceId, setSdkDeviceId] = useState<string | null>(null);
  const [sdkStatus, setSdkStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [sdkError, setSdkError] = useState<string | null>(null);
  const [playback, setPlayback] = useState<SpotifyPlayback | null>(null);
  const [tracking, setTracking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolvedTracks, setResolvedTracks] = useState<SpotifyTrack[]>([]);
  const [resolveProgress, setResolveProgress] = useState({ done: 0, total: 0, skipped: 0 });
  const [counters, setCounters] = useState({ played: 0, scrobbled: 0, notScrobbled: 0 });
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [now, setNow] = useState(Date.now());

  const sessionRef = useRef<SpotifySession | null>(session);
  const sdkDeviceIdRef = useRef<string | null>(null);
  const sdkRef = useRef<any>(null);
  const entryRef = useRef<PlayEntry | null>(null);
  const scrobbledKeysRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef<string>('');
  const pollBusyRef = useRef(false);
  const pollNowRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  const addFeed = useCallback((text: string, tone: FeedEntry['tone'] = 'info') => {
    setFeed(previous => [{ id: randomId(), at: Date.now(), text, tone }, ...previous].slice(0, 8));
  }, []);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => {
    if (!tracking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [tracking]);

  const updateSdkDevice = useCallback((deviceId: string | null) => { sdkDeviceIdRef.current = deviceId; setSdkDeviceId(deviceId); }, []);

  const refreshDevices = useCallback(async (activeSession: SpotifySession | null = sessionRef.current) => {
    if (!activeSession) return;
    try {
      const list = await fetchSpotifyDevices(activeSession);
      if (!mountedRef.current) return;
      setDevices(list);
      setTargetDeviceId(previous => (previous && (list.some(device => device.id === previous) || previous === sdkDeviceIdRef.current)) ? previous : (list.find(device => device.isActive)?.id || list[0]?.id || ''));
    } catch (caught: any) {
      if (mountedRef.current) setError(caught?.message || 'Spotify devices could not be listed.');
    }
  }, []);

  useEffect(() => { if (session) void refreshDevices(session); }, [session, refreshDevices]);

  // Optional in-browser player: makes this tab a Spotify Connect device (Premium only).
  useEffect(() => {
    if (!session || !useBrowserDevice) return;
    let disposed = false;
    setSdkStatus('loading'); setSdkError(null);
    void (async () => {
      try {
        await loadSpotifySdk();
        if (disposed) return;
        const player = new window.Spotify.Player({
          name: 'ScrobbleForge',
          getOAuthToken: (callback: (token: string) => void) => {
            const current = sessionRef.current;
            if (!current) return;
            void ensureSpotifyToken(current).then(token => { if (!disposed) callback(token); }).catch(() => { if (mountedRef.current && !disposed) setSdkError('The Spotify access token could not be refreshed for the browser player.'); });
          },
          volume: 0.8,
        });
        player.addListener('ready', ({ device_id }: { device_id: string }) => { if (disposed) return; updateSdkDevice(device_id); setSdkStatus('ready'); addFeed('This browser is now available as a Spotify device.', 'success'); });
        player.addListener('not_ready', () => { if (!disposed) { updateSdkDevice(null); setSdkStatus('loading'); } });
        const onFailure = ({ message }: { message?: string }) => { if (disposed) return; setSdkStatus('error'); setSdkError(message || 'The browser player could not start.'); };
        for (const event of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) player.addListener(event, onFailure);
        player.connect();
        sdkRef.current = player;
      } catch (caught: any) {
        if (!disposed) { setSdkStatus('error'); setSdkError(caught?.message || 'The Spotify playback SDK failed to load.'); }
      }
    })();
    return () => {
      disposed = true;
      updateSdkDevice(null);
      if (sdkRef.current) { try { sdkRef.current.disconnect(); } catch { /* player already gone */ } sdkRef.current = null; }
      setSdkStatus('idle');
    };
  }, [session, useBrowserDevice, addFeed, updateSdkDevice]);

  const finalizeEntry = useCallback(async () => {
    const entry = entryRef.current;
    if (!entry || entry.finalized) return;
    entry.finalized = true;
    entryRef.current = null;
    const key = `${entry.track.id}@${entry.startedAt}`;
    if (scrobbledKeysRef.current.has(key)) return;
    scrobbledKeysRef.current.add(key);

    const decision = computeScrobbleDecision(entry.track.durationMs, entry.listenedMs);
    let scrobbled = false;
    if (decision.eligible && isLastFmConnected) {
      scrobbled = await onScrobble(entry.track.artist, entry.track.name, entry.track.album, Math.floor(entry.startedAt / 1000)).catch(() => false);
    }
    try {
      await fetch('/api/player/played', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: entry.track.name, artist: entry.track.artist, album: entry.track.album, durationMs: Math.round(entry.listenedMs), source: 'spotify', scrobbled, sessionId: sessionIdRef.current }),
      });
    } catch { /* journaling is best effort; scrobbling already happened */ }
    if (!mountedRef.current) return;

    const detail = scrobbled ? 'scrobbled to Last.fm' : !isLastFmConnected ? 'not scrobbled — Last.fm is not connected' : decision.eligible ? 'Last.fm rejected the scrobble' : `not scrobbled — ${decision.reason}`;
    addFeed(`${entry.track.name} · ${detail}`, scrobbled ? 'success' : decision.eligible ? 'error' : 'warn');
    setCounters(previous => ({ played: previous.played + 1, scrobbled: previous.scrobbled + (scrobbled ? 1 : 0), notScrobbled: previous.notScrobbled + (scrobbled ? 0 : 1) }));
  }, [addFeed, isLastFmConnected, onScrobble]);

  const handlePlayback = useCallback(async (next: SpotifyPlayback) => {
    const current = entryRef.current;
    const nextTrack = next.track;
    if (nextTrack && current && current.track.id === nextTrack.id) {
      current.listenedMs = Math.max(current.listenedMs, next.progressMs);
      return;
    }
    if (!nextTrack) {
      if (current && !next.isPlaying && next.progressMs === 0) await finalizeEntry();
      return;
    }
    if (current) await finalizeEntry();
    entryRef.current = { track: nextTrack, startedAt: Date.now() - next.progressMs, listenedMs: next.progressMs, finalized: false };
    if (isLastFmConnected) {
      const ok = await onNowPlaying(nextTrack.artist, nextTrack.name, nextTrack.album).catch(() => false);
      if (mountedRef.current) addFeed(ok ? `Now playing sent to Last.fm: ${nextTrack.name}` : `Last.fm did not accept the Now Playing update: ${nextTrack.name}`, ok ? 'info' : 'warn');
    }
  }, [addFeed, finalizeEntry, isLastFmConnected, onNowPlaying]);

  useEffect(() => {
    if (!tracking || !session) return;
    let cancelled = false;
    const poll = async () => {
      if (pollBusyRef.current) return;
      const activeSession = sessionRef.current;
      if (!activeSession) return;
      pollBusyRef.current = true;
      try {
        const next = await fetchSpotifyPlayback(activeSession);
        if (cancelled || !mountedRef.current) return;
        setPlayback(next);
        setError(null);
        await handlePlayback(next);
      } catch (caught: any) {
        if (!cancelled && mountedRef.current) setError(caught?.message || 'Lost contact with the Spotify playback state.');
      } finally { pollBusyRef.current = false; }
    };
    pollNowRef.current = () => { void poll(); };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    return () => { cancelled = true; pollNowRef.current = null; window.clearInterval(timer); };
  }, [tracking, session, handlePlayback]);

  const resolveQueue = useCallback(async (activeSession: SpotifySession) => {
    const wanted = queue.slice(0, MAX_RESOLVE);
    setResolving(true);
    setResolvedTracks([]);
    setResolveProgress({ done: 0, total: wanted.length, skipped: 0 });
    const resolved: Array<SpotifyTrack | null> = new Array(wanted.length).fill(null);
    let skipped = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < wanted.length) {
        const index = cursor; cursor += 1;
        try {
          const match = await searchSpotifyTrack(activeSession, { name: wanted[index].name, artist: wanted[index].artist });
          if (match) resolved[index] = match; else skipped += 1;
        } catch { skipped += 1; }
        if (mountedRef.current) setResolveProgress(previous => ({ ...previous, done: previous.done + 1, skipped }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, wanted.length) }, worker));
    const matches = resolved.filter((track): track is SpotifyTrack => Boolean(track));
    if (mountedRef.current) { setResolving(false); setResolvedTracks(matches); setResolveProgress(previous => ({ ...previous, skipped })); }
    return matches;
  }, [queue]);

  const deviceLabel = useCallback((deviceId: string) => (deviceId && deviceId === sdkDeviceIdRef.current ? 'This browser (ScrobbleForge)' : devices.find(device => device.id === deviceId)?.name || 'Spotify device'), [devices]);

  const handleStart = async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) return;
    if (!queue.length) { setError('Add tracks to the queue first — the Spotify player plays your ScrobbleForge queue.'); return; }
    setStarting(true); setError(null);
    try {
      const matches = await resolveQueue(activeSession);
      if (!matches.length) { setError('None of the queued tracks matched a Spotify track. Check the queue or use the local simulation mode.'); return; }
      const deviceId = targetDeviceId || sdkDeviceIdRef.current || devices.find(device => device.isActive)?.id || '';
      if (!deviceId) { setError('No Spotify device is available. Open Spotify on a device, or turn on "Play in this browser".'); return; }
      const uris = matches.map(track => track.uri);
      let result = await startSpotifyPlayback(activeSession, deviceId, uris);
      if (!result.ok && sdkDeviceIdRef.current && deviceId !== sdkDeviceIdRef.current) result = await startSpotifyPlayback(activeSession, sdkDeviceIdRef.current, uris);
      if (!result.ok) { setError(result.message); addFeed(result.message, 'error'); return; }
      entryRef.current = null;
      scrobbledKeysRef.current = new Set();
      sessionIdRef.current = randomId();
      setCounters({ played: 0, scrobbled: 0, notScrobbled: 0 });
      setTracking(true);
      addFeed(`Playback started on ${deviceLabel(deviceId)}: ${matches.length} track${matches.length === 1 ? '' : 's'}.`, 'success');
      if (queue.length > MAX_RESOLVE) addFeed(`Only the first ${MAX_RESOLVE} queued tracks were resolved for Spotify.`, 'warn');
    } catch (caught: any) {
      setError(caught?.message || 'The Spotify session could not be started.');
    } finally { setStarting(false); }
  };

  const handleStop = async () => {
    setTracking(false);
    const activeSession = sessionRef.current;
    if (activeSession) await pauseSpotifyPlayback(activeSession, targetDeviceId || sdkDeviceIdRef.current).catch(() => ({ ok: false, message: '' }));
    await finalizeEntry();
    addFeed(`Tracking stopped after ${counters.played} completed play${counters.played === 1 ? '' : 's'}.`, 'info');
  };

  const handleControl = async (action: 'pause' | 'resume' | 'skip') => {
    const activeSession = sessionRef.current;
    if (!activeSession) return;
    const deviceId = targetDeviceId || sdkDeviceIdRef.current;
    const result = action === 'pause' ? await pauseSpotifyPlayback(activeSession, deviceId) : action === 'resume' ? await resumeSpotifyPlayback(activeSession, deviceId) : await skipSpotifyTrack(activeSession, deviceId);
    if (!result.ok) setError(result.message);
    window.setTimeout(() => pollNowRef.current?.(), 500);
  };

  const handleConnect = async () => {
    setError(null); setAuthorizing(true);
    try { saveSpotifyClientId(clientId); await beginSpotifyAuth(clientId); }
    catch (caught: any) { setError(caught?.message || 'Spotify authorization could not start.'); setAuthorizing(false); }
  };

  const handleDisconnect = () => {
    setTracking(false);
    entryRef.current = null;
    if (sdkRef.current) { try { sdkRef.current.disconnect(); } catch { /* already disconnected */ } sdkRef.current = null; }
    updateSdkDevice(null); setSdkStatus('idle');
    saveSpotifySession(null);
    setSession(null); setDevices([]); setPlayback(null); setTargetDeviceId(''); setResolvedTracks([]);
    addFeed('Spotify disconnected. Tokens were removed from this browser.', 'info');
  };

  const copyRedirect = async () => {
    try { await navigator.clipboard.writeText(spotifyRedirectUri()); addFeed('Redirect URI copied to the clipboard.', 'info'); }
    catch { setError(`Copy blocked by the browser. The redirect URI is ${spotifyRedirectUri()}`); }
  };

  const liveTrack = playback?.track || null;
  const durationMs = liveTrack?.durationMs || 0;
  const progressMs = playback ? (playback.isPlaying ? Math.min(durationMs || Number.MAX_SAFE_INTEGER, playback.progressMs + (now - playback.fetchedAt)) : playback.progressMs) : 0;
  const percentage = durationMs ? Math.min(100, (progressMs / durationMs) * 100) : 0;
  const currentIndex = liveTrack ? resolvedTracks.findIndex(track => track.uri === liveTrack.uri) : -1;
  const tone = tracking ? (playback?.isPlaying ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10' : 'text-amber-400 border-amber-500/20 bg-amber-500/10') : 'text-zinc-400 border-zinc-700 bg-zinc-800/50';

  return <div className="p-5 space-y-5">
    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 text-[11px] text-zinc-300 flex items-start gap-2">
      <Waves size={15} className="text-emerald-400 shrink-0 mt-0.5" />
      <p><span className="font-semibold text-zinc-200">Real audio, real scrobbles.</span> Playback runs inside Spotify — on this browser (Web Playback SDK) or on any Spotify Connect device (phone, desktop, speaker, TV). Every finished play is journaled here, and plays that meet Last.fm&apos;s rules are submitted through the engine&apos;s scrobble endpoints. Spotify Premium is required by Spotify for playback control; keep this tab open while tracking.</p>
    </div>

    {!isLastFmConnected && <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-3.5 text-[11px] text-zinc-300 flex items-start gap-2">
      <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
      <p>Last.fm is not connected, so plays will still be played and journaled locally, but nothing will be scrobbled. Connect your account from the header first.</p>
    </div>}

    {error && <div className="rounded-2xl border border-rose-500/25 bg-rose-500/[0.07] p-3.5 text-[11px] text-rose-200 flex items-start gap-2">
      <AlertTriangle size={15} className="shrink-0 mt-0.5" /><p>{error}</p>
    </div>}

    {!session ? <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold"><Music size={16} className="text-emerald-400" />Connect Spotify</div>
      <ol className="text-[11px] text-zinc-400 space-y-1 list-decimal list-inside">
        <li>Create an app in the <a className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1" href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">Spotify developer dashboard <ExternalLink size={11} /></a>.</li>
        <li>Add the redirect URI shown below to that app.</li>
        <li>Add your Spotify account e-mail under the app&apos;s Users Management (development mode).</li>
        <li>Paste the app&apos;s Client ID — this app uses PKCE, so no client secret is needed. It is saved in this browser only and never sent to the server.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Spotify Client ID" value={clientId} onChange={event => setClientId(event.target.value)} placeholder="Spotify Client ID" className="flex-1 min-w-[220px] px-3 py-2 text-xs" />
        <button type="button" className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-xl shadow-lg shadow-emerald-950/40 flex items-center gap-2 disabled:opacity-60" onClick={handleConnect} disabled={authorizing || !clientId.trim()}>
          {authorizing ? <Loader2 size={14} className="animate-spin" /> : <Music size={14} />}{authorizing ? 'Opening Spotify' : 'Connect Spotify'}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span>Redirect URI:</span><span className="font-mono break-all text-zinc-400">{spotifyRedirectUri()}</span>
        <button type="button" className="secondary-button text-[11px] flex items-center gap-1" onClick={copyRedirect}><Copy size={12} />Copy</button>
      </div>
    </div> : <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-zinc-300"><Radio size={14} className={tracking ? 'text-emerald-400' : 'text-zinc-500'} />Connected{session.displayName ? ` as ${session.displayName}` : ''}</div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] uppercase tracking-wider px-2.5 py-1.5 rounded-lg border ${tone}`}>{tracking ? (playback?.isPlaying ? 'playing' : 'tracking') : 'stopped'}</span>
          <button type="button" className="secondary-button text-[11px] flex items-center gap-1.5" onClick={handleDisconnect}><LogOut size={12} />Disconnect</button>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {liveTrack?.image ? <img src={liveTrack.image} alt="" className="w-12 h-12 rounded-xl object-cover border border-zinc-800 shrink-0" /> : <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0"><Music size={20} className={tracking ? 'text-emerald-400' : 'text-zinc-500'} /></div>}
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{liveTrack ? liveTrack.name : tracking ? 'Waiting for playback…' : 'Nothing playing'}</p>
              <p className="text-xs text-zinc-500 truncate mt-0.5">{liveTrack ? `${liveTrack.artist}${liveTrack.album ? ` · ${liveTrack.album}` : ''}` : 'Start the Spotify player to play this queue for real.'}</p>
            </div>
          </div>
          {liveTrack && <div className="text-right shrink-0"><p className="font-mono text-lg tabular-nums">{formatClock(durationMs - progressMs)}</p><p className="text-[10px] uppercase tracking-wider text-zinc-500">left</p></div>}
        </div>
        <div className="mt-3 h-1.5 rounded-full bg-zinc-800 overflow-hidden" role="progressbar" aria-label="Spotify playback progress" aria-valuenow={Math.round(percentage)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full transition-all duration-500 ${playback?.isPlaying ? 'bg-emerald-400' : 'bg-amber-400'}`} style={{ width: `${percentage}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
          <span className="font-mono tabular-nums">{formatClock(progressMs)} / {formatClock(durationMs)}</span>
          <span>{playback?.deviceName ? `Playing on ${playback.deviceName}` : tracking ? 'Waiting for a device' : 'Idle'}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2 text-xs text-zinc-400 space-y-2">
          <span className="flex items-center gap-1.5"><MonitorSpeaker size={13} />Playback device</span>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Spotify playback device" value={targetDeviceId} onChange={event => setTargetDeviceId(event.target.value)} disabled={tracking} className="flex-1 min-w-[200px] px-3 py-2 text-xs">
              {!devices.length && <option value="">No Connect device found</option>}
              {devices.map(device => <option key={device.id} value={device.id}>{device.name}{device.isActive ? ' · active' : ''}</option>)}
              {sdkDeviceId && <option value={sdkDeviceId}>This browser (ScrobbleForge)</option>}
            </select>
            <button type="button" className="secondary-button text-[11px] flex items-center gap-1.5" onClick={() => void refreshDevices()} disabled={tracking}><RefreshCw size={12} />Refresh</button>
          </div>
          <button type="button" aria-pressed={useBrowserDevice} onClick={() => setUseBrowserDevice(value => !value)} disabled={tracking} className={`secondary-button text-[11px] ${useBrowserDevice ? 'text-emerald-300' : ''}`}>
            {useBrowserDevice ? (sdkStatus === 'ready' ? 'Browser player ready' : sdkStatus === 'error' ? 'Browser player failed' : 'Loading browser player…') : 'Play in this browser (Premium)'}
          </button>
          {useBrowserDevice && sdkError && <p className="text-[11px] text-amber-400">{sdkError}</p>}
        </div>
        <div className="text-xs text-zinc-400 space-y-2">
          <span className="block">Queue → Spotify</span>
          <p className="text-[11px] text-zinc-500">{resolving ? `Matching ${resolveProgress.done}/${resolveProgress.total}…` : resolvedTracks.length ? `${resolvedTracks.length} matched${resolveProgress.skipped ? `, ${resolveProgress.skipped} unmatched` : ''}${queue.length > MAX_RESOLVE ? ` · first ${MAX_RESOLVE} of ${queue.length}` : ''}` : `${queue.length} queued track${queue.length === 1 ? '' : 's'}`}</p>
          {resolving && <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden"><div className="h-full bg-emerald-400" style={{ width: `${resolveProgress.total ? (resolveProgress.done / resolveProgress.total) * 100 : 0}%` }} /></div>}
          {currentIndex >= 0 && <p className="text-[11px] text-zinc-500">Track {currentIndex + 1} of {resolvedTracks.length}</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {!tracking && <button type="button" className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-xl shadow-lg shadow-emerald-950/40 flex items-center gap-2 disabled:opacity-60" onClick={handleStart} disabled={starting || resolving}>
          {starting || resolving ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}{starting || resolving ? 'Preparing Spotify' : 'Start Spotify player'}
        </button>}
        {tracking && <button type="button" className="secondary-button text-xs flex items-center gap-2" onClick={() => void handleControl(playback?.isPlaying ? 'pause' : 'resume')}>{playback?.isPlaying ? <Pause size={14} /> : <Play size={14} />}{playback?.isPlaying ? 'Pause' : 'Resume'}</button>}
        {tracking && <button type="button" className="secondary-button text-xs flex items-center gap-2" onClick={() => void handleControl('skip')}><SkipForward size={14} />Skip</button>}
        {tracking && <button type="button" className="secondary-button text-xs flex items-center gap-2 text-rose-300" onClick={() => void handleStop()}><Square size={13} />Stop tracking</button>}
        <span className="text-[11px] text-zinc-500 flex items-center gap-2"><ListMusic size={13} />{resolvedTracks.length ? `${resolvedTracks.length} Spotify track${resolvedTracks.length === 1 ? '' : 's'} queued` : 'Nothing resolved yet'}</span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div><p className="text-[10px] uppercase tracking-wider text-zinc-500">Plays journaled</p><p className="text-lg font-semibold tabular-nums text-emerald-400">{counters.played}</p></div>
        <div><p className="text-[10px] uppercase tracking-wider text-zinc-500">Scrobbled</p><p className="text-lg font-semibold tabular-nums">{counters.scrobbled}</p></div>
        <div><p className="text-[10px] uppercase tracking-wider text-zinc-500">Not scrobbled</p><p className="text-lg font-semibold tabular-nums text-amber-400">{counters.notScrobbled}</p></div>
      </div>

      <div className="rounded-2xl border border-zinc-800 overflow-hidden">
        <div className="px-4 py-2.5 bg-zinc-950/50 text-[11px] text-zinc-400 flex items-center gap-2"><CheckCircle2 size={13} className="text-emerald-400" />Spotify playback report</div>
        <ul className="max-h-56 overflow-y-auto divide-y divide-zinc-900">
          {feed.length === 0 && <li className="px-4 py-3 text-[11px] text-zinc-500">Start the Spotify player — now-playing updates, scrobbles and skipped plays appear here.</li>}
          {feed.map(entry => <li key={entry.id} className="px-4 py-2.5 text-[11px] flex items-start gap-2"><span className="tabular-nums text-zinc-600 shrink-0">{new Date(entry.at).toLocaleTimeString()}</span><span className={toneClass[entry.tone]}>{entry.text}</span></li>)}
        </ul>
      </div>
    </div>}
  </div>;
};
