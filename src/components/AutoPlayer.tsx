import React, { useEffect, useState } from 'react';
import { Play, Pause, Square, Music, ListMusic, Clock, ShieldCheck, Waves, Check, Activity, Radio } from 'lucide-react';
import { PlayerState, QueueTrack } from '../types';
import { SpotifyPlayer } from './SpotifyPlayer';

interface AutoPlayerProps {
  player: PlayerState | null;
  queue: QueueTrack[];
  fallbackTrack: { artist: string; track: string; album: string };
  onStart: (params: { queue: QueueTrack[]; trackDurationSeconds: number; loopQueue: boolean; shuffle: boolean }) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  isLastFmConnected: boolean;
  onScrobble: (artist: string, track: string, album: string, timestamp?: number) => Promise<boolean>;
  onNowPlaying: (artist: string, track: string, album: string) => Promise<boolean>;
}

const QUICK_DURATIONS = [5, 15, 30, 60, 180] as const;
const PLAYER_MODE_KEY = 'scrobbleforge_player_mode';

const Equalizer: React.FC<{ active: boolean }> = ({ active }) => <span aria-hidden className="flex items-end gap-[3px] h-5">
  {[0, 1, 2, 3].map(bar => <span key={bar} className={`w-[3px] rounded-full ${active ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-700'}`} style={{ height: active ? `${[45, 100, 65, 85][bar]}%` : '30%', animationDelay: `${bar * 140}ms` }} />)}
</span>;

export const AutoPlayer: React.FC<AutoPlayerProps> = ({ player, queue, fallbackTrack, onStart, onPause, onResume, onStop, isLastFmConnected, onScrobble, onNowPlaying }) => {
  const [trackDurationSeconds, setTrackDurationSeconds] = useState(30);
  const [loopQueue, setLoopQueue] = useState(true);
  const [shuffle, setShuffle] = useState(false);
  const [useEngineTrack, setUseEngineTrack] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState<'local' | 'spotify'>(() => {
    try { return localStorage.getItem(PLAYER_MODE_KEY) === 'spotify' ? 'spotify' : 'local'; } catch { return 'local'; }
  });
  useEffect(() => { try { localStorage.setItem(PLAYER_MODE_KEY, mode); } catch { /* preference only */ } }, [mode]);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);

  const status = player?.status || 'idle';
  const isRunning = status === 'playing' || status === 'paused';
  const engineTrack: QueueTrack = { id: 'engine-track', name: fallbackTrack.track, artist: fallbackTrack.artist, album: fallbackTrack.album };
  const source = useEngineTrack || queue.length === 0 ? [engineTrack] : queue;
  const sessionQueue = player?.queue?.length ? player.queue : source;
  const active = player?.activeTrack || null;
  const plays = player?.playsCompleted || 0;
  const index = player ? player.currentIndex : 0;

  const playLength = Math.max(1, player?.trackDurationSeconds || trackDurationSeconds) * 1000;
  const remainingFromEnds = player?.trackEndsAt && status === 'playing' ? Math.max(0, player.trackEndsAt - now) : status === 'paused' ? player?.remainingMs || 0 : 0;
  const elapsed = isRunning ? Math.min(playLength, playLength - remainingFromEnds) : 0;
  const percentage = (elapsed / playLength) * 100;
  const secondsLeft = Math.ceil(remainingFromEnds / 1000);
  const sessionSeconds = player?.startedAt ? Math.max(0, Math.floor((now - player.startedAt) / 1000)) : 0;
  const formatDuration = (total: number) => `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;

  const tone = status === 'playing' ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10' : status === 'paused' ? 'text-amber-400 border-amber-500/20 bg-amber-500/10' : status === 'completed' ? 'text-sky-400 border-sky-500/20 bg-sky-500/10' : 'text-zinc-400 border-zinc-700 bg-zinc-800/50';

  return <section className="studio-panel overflow-hidden" aria-label="Auto player">
    <div className="p-5 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/70">
      <div className="flex items-center gap-3"><div className="panel-icon"><Waves size={18} /></div><div><h2 className="text-sm font-semibold">Auto player</h2><p className="text-xs text-zinc-500 mt-0.5">Local simulation or real Spotify playback with Last.fm scrobbling.</p></div></div>
      <div className="flex items-center gap-3"><Equalizer active={status === 'playing'} /><span className={`text-[10px] uppercase tracking-wider px-2.5 py-1.5 rounded-lg border ${tone}`}>{status}</span></div>
    </div>

    <div className="px-5 py-3 border-b border-zinc-800/70 flex flex-wrap items-center gap-2">
      {([{ id: 'local', label: 'Local simulation' }, { id: 'spotify', label: 'Spotify playback' }] as const).map(({ id, label }) => (
        <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)} className={`px-3 py-2 rounded-lg border text-xs transition-colors ${mode === id ? 'bg-red-500/10 text-red-300 border-red-500/25' : 'border-zinc-800 text-zinc-400 hover:bg-zinc-900'}`}>{label}</button>
      ))}
      <span className="text-[11px] text-zinc-500">{mode === 'local' ? 'Journals plays locally with zero Last.fm API calls.' : 'Plays real audio through Spotify and scrobbles certified plays to Last.fm.'}</span>
    </div>

    {mode === 'local' ? <>
    <div className="px-5 py-3 bg-red-500/[0.06] border-b border-red-500/15 flex items-start gap-2 text-[11px] text-zinc-300">
      <ShieldCheck size={15} className="text-red-400 shrink-0 mt-0.5" />
      <p><span className="font-semibold text-zinc-200">Zero Last.fm API calls.</span> No credentials, no metadata lookups, no scrobbles, no rate limits or daily caps. Every finished play is recorded in this workspace&apos;s own activity journal instead.</p>
    </div>

    <div className="p-5 space-y-5">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0"><Music size={20} className={status === 'playing' ? 'text-emerald-400' : 'text-zinc-500'} /></div>
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{active ? active.name : status === 'completed' ? 'Session finished' : 'Nothing playing'}</p>
              <p className="text-xs text-zinc-500 truncate mt-0.5">{active ? `${active.artist}${active.album ? ` · ${active.album}` : ''}` : 'Start the player to simulate continuous playback.'}</p>
            </div>
          </div>
          {active && <div className="text-right shrink-0"><p className="font-mono text-lg tabular-nums">{formatDuration(Math.ceil(remainingFromEnds / 1000))}</p><p className="text-[10px] uppercase tracking-wider text-zinc-500">{status === 'paused' ? 'paused' : 'remaining'}</p></div>}
        </div>

        <div className="mt-4 h-1.5 rounded-full bg-zinc-800 overflow-hidden" role="progressbar" aria-label="Current play progress" aria-valuenow={Math.round(percentage)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full transition-all duration-300 ${status === 'paused' ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${percentage}%` }} />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-3">
          <div><p className="text-[10px] uppercase tracking-wider text-zinc-500">Plays tracked</p><p className="text-lg font-semibold tabular-nums text-emerald-400">{plays}</p></div>
          <div><p className="text-[10px] uppercase tracking-wider text-zinc-500">In rotation</p><p className="text-lg font-semibold tabular-nums">{sessionQueue.length}</p></div>
          <div><p className="text-[10px] uppercase tracking-wider text-zinc-500">Session</p><p className="text-lg font-semibold tabular-nums">{formatDuration(sessionSeconds)}</p></div>
        </div>

        <p className="mt-3 text-[11px] text-zinc-500 flex items-center gap-2"><Clock size={12} />{isRunning ? `${secondsLeft}s left in this play · ${player?.trackDurationSeconds || trackDurationSeconds}s per play` : player?.stoppedReason || `${trackDurationSeconds}s per play`}{player?.loopQueue ? ' · looping' : ''}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="text-xs text-zinc-400 space-y-1.5 sm:col-span-2">
          <span className="block">Seconds per play <span className="text-zinc-600">(1–3600, no API calls either way)</span></span>
          <div className="flex flex-wrap items-center gap-2">
            {QUICK_DURATIONS.map(value => <button key={value} type="button" disabled={isRunning} aria-pressed={trackDurationSeconds === value} onClick={() => setTrackDurationSeconds(value)} className={`px-3 py-2 rounded-lg border text-xs tabular-nums transition-colors ${trackDurationSeconds === value ? 'bg-red-500/10 text-red-300 border-red-500/25' : 'border-zinc-800 text-zinc-400 hover:bg-zinc-900'}`}>{value}s</button>)}
            <input aria-label="Custom seconds per play" type="number" min={1} max={3600} disabled={isRunning} value={trackDurationSeconds} onChange={e => setTrackDurationSeconds(Math.min(3600, Math.max(1, Number(e.target.value) || 1)))} className="w-20 py-2 px-3 text-xs tabular-nums" />
          </div>
        </div>
        <div className="text-xs text-zinc-400 space-y-1.5"><span className="block">Options</span>
          <div className="flex gap-2">
            <button type="button" aria-pressed={loopQueue} disabled={isRunning} onClick={() => setLoopQueue(!loopQueue)} className={`secondary-button text-xs flex-1 ${loopQueue ? 'text-red-300' : ''}`}>Loop</button>
            <button type="button" aria-pressed={shuffle} disabled={isRunning} onClick={() => setShuffle(!shuffle)} className={`secondary-button text-xs flex-1 ${shuffle ? 'text-red-300' : ''}`}>Shuffle</button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {!isRunning && <button className="px-5 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-xl shadow-lg shadow-red-950/50 transition-all flex items-center gap-2" onClick={() => onStart({ queue: source, trackDurationSeconds, loopQueue, shuffle })}><Play size={14} />Start auto player</button>}
        {status === 'playing' && <button className="secondary-button text-xs flex items-center gap-2" onClick={onPause}><Pause size={14} />Pause</button>}
        {status === 'paused' && <button className="secondary-button text-xs flex items-center gap-2" onClick={onResume}><Play size={14} />Resume</button>}
        {isRunning && <button className="secondary-button text-xs flex items-center gap-2 text-rose-300" onClick={onStop}><Square size={13} />Stop session</button>}
        <span className="text-[11px] text-zinc-500 flex items-center gap-2"><ListMusic size={13} />{source.length === 1 ? 'Single track repeated' : `${source.length} tracks in rotation`}</span>
      </div>

      <div className="rounded-2xl border border-zinc-800 overflow-hidden">
        <div className="px-4 py-2.5 bg-zinc-950/50 border-b border-zinc-800/70 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
          <span className="flex items-center gap-2"><Radio size={13} className={status === 'playing' ? 'text-emerald-400' : 'text-zinc-500'} />Up next{sessionQueue.length > 1 ? ` · ${sessionQueue.length} tracks` : ''}</span>
          <span className="tabular-nums text-zinc-500">{plays} played locally · 0 API calls</span>
        </div>
        <ol className="max-h-64 overflow-y-auto divide-y divide-zinc-900">
          {sessionQueue.slice(0, 200).map((track, position) => {
            const isActive = Boolean(active && track.id === active.id);
            const isDone = position < index || (status === 'completed' && position >= 0);
            return <li key={`${track.id}-${position}`} className={`px-4 py-2.5 flex items-center gap-3 text-xs ${isActive ? 'bg-emerald-500/[0.07]' : isDone && !player?.loopQueue ? 'opacity-50' : ''}`}>
              <span className="w-6 shrink-0 text-center tabular-nums text-zinc-600">{isDone && !isActive ? <Check size={13} className="mx-auto text-emerald-500" /> : position + 1}</span>
              <span className="min-w-0 flex-1"><span className={`block truncate ${isActive ? 'text-emerald-300 font-medium' : 'text-zinc-300'}`}>{track.name}</span><span className="block truncate text-[11px] text-zinc-500">{track.artist}{track.album ? ` · ${track.album}` : ''}</span></span>
              {isActive && <span className="text-[10px] uppercase tracking-wider text-emerald-400 shrink-0">{status === 'paused' ? 'paused' : 'playing'}</span>}
            </li>;
          })}
        </ol>
        <div className="px-4 py-2.5 border-t border-zinc-800/70 text-[11px] text-zinc-500 flex flex-wrap items-center justify-between gap-2"><span className="flex items-center gap-2"><Activity size={12} />Local plays appear in the activity journal and the local plays metric.</span><span>API-free mode</span></div>
      </div>

      {player?.startedAt && <p className="text-[11px] text-zinc-500">Session started {new Date(player.startedAt).toLocaleTimeString()} · {plays} play{plays === 1 ? '' : 's'} journaled locally · no Last.fm request was made</p>}
    </div>
    </> : <SpotifyPlayer queue={queue} isLastFmConnected={isLastFmConnected} onScrobble={onScrobble} onNowPlaying={onNowPlaying} />}
  </section>;
};
