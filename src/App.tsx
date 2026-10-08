/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { ActivityOverview } from './components/ActivityOverview';
import { Header } from './components/Header';
import { AuthModal } from './components/AuthModal';
import { ScrobblerEngine } from './components/ScrobblerEngine';
import { UniversalSearchExplorer } from './components/UniversalSearchExplorer';
import { ProfileHarvester } from './components/ProfileHarvester';
import { ArtistCatalogExplorer } from './components/ArtistCatalogExplorer';
import { ActiveQueueManager } from './components/ActiveQueueManager';
import { CatchUpBanner } from './components/CatchUpBanner';
import { LiveConsole } from './components/LiveConsole';
const RecentScrobblesFeed = lazy(() => import('./components/RecentScrobblesFeed').then(module => ({ default: module.RecentScrobblesFeed })));
import {
  LastFmCredentials,
  LastFmUser,
  JobState,
  RecentTrack,
  QueueTrack,
  ActivitySummary,
} from './types';
import { Radio, Info, ArrowUpRight, X, Search, ListMusic, Disc, Users, Zap, ShieldCheck } from 'lucide-react';

const STORAGE_CREDS_KEY = 'scrobbleforge_creds';
const STORAGE_QUEUE_KEY = 'scrobbleforge_queue';
const STORAGE_IDLE_KEY = 'scrobbleforge_last_live_timestamp';

const DEFAULT_CREDS: LastFmCredentials = {
  apiKey: '',
  apiSecret: '',
  username: '',
  password: '',
  sessionKey: '',
};

export default function App() {
  const [connection, setConnection] = useState('connecting');
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmittingBatch, setIsSubmittingBatch] = useState(false);
  const batchBusy = useRef(false);
  const recentBusy = useRef(false);
  // Navigation / workspace tab
  const [activeNavTab, setActiveNavTab] = useState<
    'stream' | 'search' | 'harvester' | 'artist' | 'queue' | 'instant'
  >('stream');
  const visitedTabs = useRef(new Set<string>(['stream']));
  visitedTabs.current.add(activeNavTab);

  // Credentials & Auth
  const [credentials, setCredentials] = useState<LastFmCredentials>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_CREDS_KEY);
      if (saved) {
        const old = JSON.parse(saved);
        localStorage.removeItem(STORAGE_CREDS_KEY);
        return { ...DEFAULT_CREDS, apiKey: old.apiKey || '', username: old.username || '' };
      }
    } catch {}
    return DEFAULT_CREDS;
  });

  const [user, setUser] = useState<LastFmUser | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isRefreshingUser, setIsRefreshingUser] = useState(false);

  // Active Queue
  const [queue, setQueue] = useState<QueueTrack[]>(() => {
    try {
      const savedQueue = localStorage.getItem(STORAGE_QUEUE_KEY);
      if (savedQueue) { const parsed = JSON.parse(savedQueue); if (Array.isArray(parsed) && parsed.every(t => typeof t?.name === 'string' && typeof t.artist === 'string')) return parsed.slice(0, 5000); }
    } catch {}
    return [];
  });

  // Save queue to local storage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_QUEUE_KEY, JSON.stringify(queue));
    } catch { setNotice('Queue could not be saved in this browser. Export it before leaving.'); }
  }, [queue]);

  // Idle session detection
  const [lastLiveTimestamp, setLastLiveTimestamp] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_IDLE_KEY);
      if (saved) return parseInt(saved, 10);
    } catch {}
    return null;
  });
  const [isIdleDismissed, setIsIdleDismissed] = useState(false);
  const [nowTime, setNowTime] = useState(Date.now());

  // Background Job State
  const [job, setJob] = useState<JobState>({
    status: 'idle',
    artist: 'rvaia',
    track: 'kill bill',
    album: 'kill bill',
    limit: 1800,
    interval: 2,
    jitter: true,
    isDryRun: false,
    mode: 'live',
    queueMode: 'single_loop',
    queue: [],
    currentQueueIndex: 0,
    scrobblesCompleted: 0,
    failedCount: 0,
    startedAt: null,
    lastScrobbleTime: null,
    rateLimitCooldownSeconds: 0,
    rateLimitResumeAt: null,
    currentError: null,
    logs: [],
  });

  // Recent tracks from user's live profile
  const [recentTracks, setRecentTracks] = useState<RecentTrack[]>([]);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);

  // Periodic clock to evaluate idle gap
  useEffect(() => {
    const timer = setInterval(() => {
      setNowTime(Date.now());
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // Record last active scrobble time
  useEffect(() => {
    if (job.lastScrobbleTime) {
      setLastLiveTimestamp(job.lastScrobbleTime);
      try {
        localStorage.setItem(STORAGE_IDLE_KEY, String(job.lastScrobbleTime));
      } catch {}
      setIsIdleDismissed(false);
    }
  }, [job.lastScrobbleTime]);

  // Attempt initial authentication
  const authenticateLastFm = useCallback(
    async (creds: LastFmCredentials): Promise<boolean> => {
      try {
        const res = await fetch('/api/lastfm/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(creds),
        });
        const data = await res.json();
        if (data.ok) {
          const updatedCreds = {
            ...creds,
            password: '',
            username: data.username || creds.username,
            sessionKey: data.sessionKey,
          };
          setCredentials(updatedCreds);
          try {
            localStorage.setItem(STORAGE_CREDS_KEY, JSON.stringify({ apiKey: updatedCreds.apiKey, username: updatedCreds.username }));
          } catch {}

          if (data.user) {
            setUser(data.user);
          }
          setIsConnected(true);
          return true;
        }
        throw new Error(data.error || 'Last.fm authentication failed.');
      } catch (e) {
        throw e instanceof Error ? e : new Error('Could not connect to Last.fm.');
      }
    },
    []
  );

  // Fetch user profile and playcount
  const fetchUserInfo = useCallback(async () => {
    if (!isConnected || !credentials.username) return;
    setIsRefreshingUser(true);
    try {
      const res = await fetch(
        `/api/lastfm/user-info?${new URLSearchParams({ username: credentials.username })}`
      );
      const data = await res.json();
      if (data.ok && data.user) {
        setUser(data.user);
      } else { setNotice(data.error || 'Could not refresh profile.'); }
    } catch {
      setNotice('Profile refresh failed. Check the connection and activity journal.');
    } finally {
      setIsRefreshingUser(false);
    }
  }, [isConnected, credentials.username]);

  // Fetch recent scrobbles
  const fetchRecentTracks = useCallback(async () => {
    if (!isConnected || !credentials.username) return;
    if (recentBusy.current) return;
    recentBusy.current = true;
    setIsLoadingTracks(true);
    try {
      const res = await fetch(
        `/api/lastfm/recent-tracks?${new URLSearchParams({ username: credentials.username, limit: '60' })}`
      );
      const data = await res.json();
      if (data.ok && data.recentTracks) {
        setRecentTracks(Array.isArray(data.recentTracks) ? data.recentTracks : [data.recentTracks]);
      } else { setNotice(data.error || 'Could not refresh recent tracks.'); }
    } catch {
      setNotice('Recent tracks refresh failed. Check the activity journal.');
    } finally {
      recentBusy.current = false;
      setIsLoadingTracks(false);
    }
  }, [isConnected, credentials.username]);

  useEffect(() => { if (isConnected) { void fetchRecentTracks(); void fetchUserInfo(); } }, [isConnected, fetchRecentTracks, fetchUserInfo]);

  // Credentials intentionally do not survive reload in browser storage.
  useEffect(() => {
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch('/api/activity/summary');
        if (!res.ok) throw new Error('Journal unavailable');
        const data = await res.json();
        setSummary(data.summary);
      } catch { setSummary(null); }
      finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  // SSE event stream listener
  useEffect(() => {
    const eventSource = new EventSource('/api/job/events');
    eventSource.onopen = () => setConnection('live');
    eventSource.onerror = () => setConnection('reconnecting');

    eventSource.addEventListener('status', (e) => {
      try {
        const updated = JSON.parse(e.data);
        setJob((prev) => ({
          ...prev,
          ...updated,
          logs: [...new Map([...prev.logs, ...(updated.logs || [])].map(log => [log.id, log])).values()].sort((a, b) => (a.seq || 0) - (b.seq || 0)).slice(-500),
        }));
      } catch (err) {
        console.error('SSE parse status error', err);
      }
    });

    eventSource.addEventListener('log', (e) => {
      try {
        const newLog = JSON.parse(e.data);
        setJob((prev) => {
          const logs = [...new Map([...prev.logs, newLog].map(log => [log.id, log])).values()];
          if (logs.length > 500) logs.shift();
          return {
            ...prev,
            logs,
          };
        });
      } catch (err) {
        console.error('SSE parse log error', err);
      }
    });

    eventSource.addEventListener('completed', (e) => {
      try {
        const completedState = JSON.parse(e.data);
        setJob((prev) => ({
          ...prev,
          ...completedState,
          status: 'completed',
        }));
        fetchRecentTracks();
        fetchUserInfo();
      } catch (err) {
        console.error('SSE completed error', err);
      }
    });

    return () => {
      eventSource.close();
    };
  }, [fetchRecentTracks, fetchUserInfo]);

  // Single Loop Start
  const handleStartJob = async (params: {
    artist: string;
    track: string;
    album: string;
    limit: number;
    interval: number;
    jitter: boolean;
    isDryRun: boolean;
  }) => {
    try {
      const res = await fetch('/api/job/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...params,
          queueMode: 'single_loop',
          credentials: {
            apiKey: credentials.apiKey,
            apiSecret: credentials.apiSecret,
            sessionKey: credentials.sessionKey,
            username: credentials.username,
          },
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setNotice(data.error || 'Failed to start job.');
      }
    } catch (e: any) {
      setNotice(e.message || 'Error communicating with server.');
    }
  };

  // Queue Streaming Start
  const handleStartStreamingQueue = async (tracksToStream: QueueTrack[], loop: boolean) => {
    if (!isConnected) {
      setIsAuthModalOpen(true);
      return;
    }
    if (tracksToStream.length === 0) return;

    try {
      const res = await fetch('/api/job/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queue: tracksToStream,
          queueMode: loop ? 'queue_loop' : 'queue_once',
          limit: loop ? 1000 : tracksToStream.length,
          interval: 2,
          jitter: true,
          credentials: {
            apiKey: credentials.apiKey,
            apiSecret: credentials.apiSecret,
            sessionKey: credentials.sessionKey,
            username: credentials.username,
          },
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setNotice(data.error || 'Failed to start streaming queue.');
      }
    } catch (e: any) {
      setNotice(e.message || 'Error starting queue stream.');
    }
  };

  const submitBatch = async (payload: Record<string, unknown>): Promise<boolean> => {
    if (!isConnected) { setIsAuthModalOpen(true); return false; }
    if (batchBusy.current) { setNotice('A batch submission is already in progress.'); return false; }
    batchBusy.current = true; setIsSubmittingBatch(true);
    try {
      const res = await fetch('/api/job/batch-scrobble-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, apiKey: credentials.apiKey, apiSecret: credentials.apiSecret, sessionKey: credentials.sessionKey }),
      });
      const data = await res.json();
      setNotice(`Batch result: ${data.completed || 0} accepted, ${data.ignored || 0} ignored.${data.error ? ` ${data.error}` : ''}`);
      if (data.completed) { setLastLiveTimestamp(Date.now()); void fetchRecentTracks(); void fetchUserInfo(); }
      return Boolean(data.ok);
    } catch { setNotice('Batch connection lost. Check recorded results before resubmitting to avoid duplicates.'); return false; }
    finally { batchBusy.current = false; setIsSubmittingBatch(false); }
  };
  const handleBatchScrobbleQueue = (tracks: QueueTrack[], spanHours: number) => submitBatch({ tracks, spanHours });
  const handleCatchUpBatch = async (params: { tracks: QueueTrack[]; startTime: number; endTime: number; resumeLive: boolean }): Promise<boolean> => {
    const ok = await submitBatch({ tracks: params.tracks, startTime: params.startTime, endTime: params.endTime });
    if (ok) {
      setIsIdleDismissed(true);
      if (params.resumeLive && job.status === 'paused') await handleResumeJob();
      else if (params.resumeLive && queue.length) await handleStartStreamingQueue(queue, false);
    }
    return ok;
  };

  // Simulate 1h idle gap for instantaneous demonstration & testing
  const handleSimulateIdle = () => {
    // 1 hour and 15 minutes ago
    const simulatedPastTime = Date.now() - 75 * 60 * 1000;
    setLastLiveTimestamp(simulatedPastTime);
    try {
      localStorage.setItem(STORAGE_IDLE_KEY, String(simulatedPastTime));
    } catch {}
    setIsIdleDismissed(false);
  };

  // Queue manipulation handlers
  const handleAddTracksToQueue = (newTracks: QueueTrack[]) => {
    setQueue((prev) => [...prev, ...newTracks.map(track => ({ ...track, id: crypto.randomUUID() }))].slice(0, 5000));
    setActiveNavTab('queue');
  };

  const handleRemoveTrack = (id: string) => {
    setQueue((prev) => prev.filter((t) => t.id !== id));
  };

  const handleShuffleQueue = () => {
    setQueue(prev => { const next = [...prev]; for (let i = next.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [next[i], next[j]] = [next[j], next[i]]; } return next; });
  };

  const handleClearQueue = () => {
    if (window.confirm('Clear the editable queue? The active job snapshot will not change.')) setQueue([]);
  };

  const jobAction = async (action: string) => {
    try {
      const response = await fetch(`/api/job/${action}`, { method: 'POST' });
      const data = await response.json();
      if (!data.ok) setNotice(data.error || 'Job action failed.');
      if (data.job) setJob(prev => ({ ...prev, ...data.job, logs: prev.logs }));
    } catch { setNotice('Could not reach the engine. Check connection status.'); }
  };
  const handlePauseJob = () => jobAction('pause');
  const handleResumeJob = () => jobAction('resume');
  const handleStopJob = () => jobAction('stop');
  const handleClearLogs = () => { void jobAction('clear-logs'); };

  // Instant Single Scrobble
  const handleSingleScrobble = async (
    artist: string,
    track: string,
    album: string
  ): Promise<boolean> => {
    try {
      const res = await fetch('/api/lastfm/single-scrobble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artist,
          track,
          album,
          apiKey: credentials.apiKey,
          apiSecret: credentials.apiSecret,
          sessionKey: credentials.sessionKey,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setLastLiveTimestamp(Date.now());
        setTimeout(fetchRecentTracks, 1000);
        return true;
      }
      setNotice(data.error || 'Last.fm rejected the operation.');
      return false;
    } catch {
      setNotice('Connection lost. Check recorded results before trying again.');
      return false;
    }
  };

  // Update Now Playing
  const handleUpdateNowPlaying = async (
    artist: string,
    track: string,
    album: string
  ): Promise<boolean> => {
    try {
      const res = await fetch('/api/lastfm/now-playing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artist,
          track,
          album,
          apiKey: credentials.apiKey,
          apiSecret: credentials.apiSecret,
          sessionKey: credentials.sessionKey,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTimeout(fetchRecentTracks, 800);
        return true;
      }
      setNotice(data.error || 'Last.fm rejected the operation.');
      return false;
    } catch {
      setNotice('Connection lost. Check recorded results before trying again.');
      return false;
    }
  };

  const handleDisconnect = async () => {
    try {
      const response = await fetch('/api/lastfm/disconnect', { method: 'POST' });
      if (!response.ok) throw new Error();
    } catch { setNotice('Server disconnect failed. The worker may still be active.'); return; }
    try { localStorage.removeItem(STORAGE_CREDS_KEY); } catch { setNotice('Could not clear saved account hints in this browser.'); }
    setCredentials({
      apiKey: '',
      apiSecret: '',
      username: '',
      password: '',
      sessionKey: '',
    });
    setRecentTracks([]);
    setUser(null);
    setIsConnected(false);
    setIsAuthModalOpen(false);
  };

  const idleDurationMs = lastLiveTimestamp ? nowTime - lastLiveTimestamp : 0;
  const isIdleOverOneHour = idleDurationMs >= 3600000;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-red-500/30 selection:text-white">
      {/* Top Header */}
      <Header
        user={user}
        isConnected={isConnected}
        onOpenAuth={() => setIsAuthModalOpen(true)}
        onRefreshUser={fetchUserInfo}
        isRefreshingUser={isRefreshingUser}
      />

      {/* Main Studio Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-5 pb-2">
          <div><div className="text-[10px] uppercase tracking-[.24em] text-red-400 font-semibold mb-3">Your listening workspace</div><h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">Less guessing.<br className="sm:hidden" /> More listening.</h1><p className="text-sm text-zinc-400 mt-3 max-w-xl leading-relaxed">Discover music, organize your queue, and track every Last.fm submission in one place.</p></div>
          <div className="flex gap-3 items-center shrink-0"><a href="https://www.last.fm" target="_blank" rel="noreferrer" className="secondary-button text-xs flex items-center gap-2">Open Last.fm<ArrowUpRight size={14} /></a>{!isConnected && <button onClick={() => setIsAuthModalOpen(true)} className="px-4 py-2.5 bg-red-600 hover:bg-red-500 text-white text-xs font-semibold rounded-xl">Connect account</button>}</div>
        </div>
        <ActivityOverview summary={summary} job={job} connection={connection} />
        {notice && <div role="status" className="studio-panel p-4 flex items-start justify-between gap-3 text-sm text-zinc-300"><div className="flex gap-3"><Info size={18} className="text-red-400 shrink-0 mt-0.5" /><span>{notice}</span></div><button aria-label="Dismiss notification" className="icon-button shrink-0" onClick={() => setNotice(null)}><X size={14} /></button></div>}
        {['running', 'paused', 'rate_limited', 'error'].includes(job.status) && <div className="studio-panel p-4 flex flex-wrap items-center justify-between gap-3"><div className="text-xs"><span className="text-zinc-200 font-semibold">{job.queueMode === 'single_loop' ? `${job.artist} — ${job.track}` : `Queue session · ${job.queue.length} tracks`}</span><p className="mt-1 text-zinc-500">{job.scrobblesCompleted} accepted · {job.ignoredCount || 0} ignored · {job.simulatedCount || 0} simulated · {job.status.replace('_', ' ')}</p></div><div className="flex gap-2">{['running', 'rate_limited'].includes(job.status) && <button className="secondary-button text-xs" onClick={handlePauseJob}>Pause</button>}{job.status === 'paused' && <button className="secondary-button text-xs" onClick={handleResumeJob}>Resume</button>}<button className="secondary-button text-xs text-rose-300" onClick={handleStopJob}>Stop session</button></div></div>}
        {isSubmittingBatch && <div role="status" className="studio-panel p-4 flex flex-wrap justify-between gap-3 items-center text-xs"><span className="text-zinc-300">Batch in progress. Confirmed chunk results appear in the journal.</span><button className="secondary-button" onClick={() => void jobAction('cancel-batch')}>Cancel remaining chunks</button></div>}
        <nav aria-label="Workspace" className="workspace-tabs flex overflow-x-auto gap-1.5 border-b border-zinc-800 pb-3">
          {([{ id: 'stream', label: 'Live engine', icon: Radio }, { id: 'search', label: 'Discover', icon: Search }, { id: 'harvester', label: 'Import profile', icon: Users }, { id: 'artist', label: 'Catalog', icon: Disc }, { id: 'queue', label: 'Queue', icon: ListMusic }, { id: 'instant', label: 'Instant actions', icon: Zap }] as const).map(({ id, label, icon: Icon }) => <button key={id} aria-current={activeNavTab === id ? 'page' : undefined} onClick={() => setActiveNavTab(id)} className={`flex items-center gap-2 shrink-0 px-4 py-2.5 rounded-xl text-xs font-medium ${activeNavTab === id ? 'bg-red-500/10 text-red-300 border border-red-500/25' : 'text-zinc-400 hover:bg-zinc-900 border border-transparent'}`}><Icon size={15} />{label}{id === 'queue' && <span className="text-[10px] rounded-full bg-zinc-800 px-1.5 py-0.5">{queue.length}</span>}</button>)}
        </nav>

        {/* CATCH-UP BANNER: Displays when live session has been idle for >= 1 hour */}
        {isIdleOverOneHour && !isIdleDismissed && (
          <CatchUpBanner
            lastActiveTime={lastLiveTimestamp}
            idleDurationMs={idleDurationMs}
            recentTracks={recentTracks}
            queue={queue}
            activeTrack={{
              artist: job.artist,
              track: job.track,
              album: job.album,
            }}
            isJobRunning={['running', 'rate_limited', 'paused'].includes(job.status)}
            onCatchUpBatch={handleCatchUpBatch}
            onDismiss={() => setIsIdleDismissed(true)}
            onSimulateIdle={handleSimulateIdle}
          />
        )}

        {/* 2-Column Responsive Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Interactive Mode & Workspace (7 cols) */}
          <div className="lg:col-span-8 space-y-6">
            {/* Primary Engine Controls & Mode Tab Navigation */}
            <div hidden={activeNavTab !== 'stream' && activeNavTab !== 'instant'}><ScrobblerEngine
              job={job}
              credentials={credentials}
              isConnected={isConnected}
              activeNavTab={activeNavTab}
              onChangeNavTab={setActiveNavTab}
              queueCount={queue.length}
              onStartJob={handleStartJob}
              onPauseJob={handlePauseJob}
              onResumeJob={handleResumeJob}
              onStopJob={handleStopJob}
              onSingleScrobble={handleSingleScrobble}
              onUpdateNowPlaying={handleUpdateNowPlaying}
              onOpenAuth={() => setIsAuthModalOpen(true)}
            /></div>

            {/* Sub-panels based on active tab */}
            {visitedTabs.current.has('search') && (
              <div hidden={activeNavTab !== 'search'}>
              <UniversalSearchExplorer
                apiKey={credentials.apiKey}
                onAddTracksToQueue={handleAddTracksToQueue}
                onInstantBatchScrobble={handleBatchScrobbleQueue}
                onStartStreamingQueue={handleStartStreamingQueue}
              />
              </div>
            )}

            {visitedTabs.current.has('harvester') && (
              <div hidden={activeNavTab !== 'harvester'}>
              <ProfileHarvester
                apiKey={credentials.apiKey}
                defaultUsername={credentials.username}
                onAddTracksToQueue={handleAddTracksToQueue}
                onInstantBatchScrobble={handleBatchScrobbleQueue}
                onStartStreamingQueue={handleStartStreamingQueue}
              />
              </div>
            )}

            {visitedTabs.current.has('artist') && (
              <div hidden={activeNavTab !== 'artist'}>
              <ArtistCatalogExplorer
                apiKey={credentials.apiKey}
                onAddTracksToQueue={handleAddTracksToQueue}
                onInstantBatchScrobble={handleBatchScrobbleQueue}
                onStartStreamingQueue={handleStartStreamingQueue}
              />
              </div>
            )}

            {visitedTabs.current.has('queue') && (
              <div hidden={activeNavTab !== 'queue'}>
              <ActiveQueueManager
                queue={queue}
                currentTrackId={job.queueMode !== 'single_loop' ? job.queue[job.currentQueueIndex]?.id : undefined}
                isStreaming={['running', 'paused', 'rate_limited'].includes(job.status)}
                onReorder={(id, direction) => setQueue(prev => { const next = [...prev]; const index = next.findIndex(track => track.id === id); const target = index + direction; if (target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]]; return next; })}
                onImport={handleAddTracksToQueue}
                onClearQueue={handleClearQueue}
                onRemoveTrack={handleRemoveTrack}
                onShuffleQueue={handleShuffleQueue}
                onStartStreamingQueue={handleStartStreamingQueue}
                onBatchScrobbleQueue={handleBatchScrobbleQueue}
              />
              </div>
            )}

            {/* Live Terminal Console */}
            <LiveConsole job={job} onClearLogs={handleClearLogs} connection={connection} cooldownResumeAt={summary?.cooldownResumeAt} />
          </div>

          {/* Right Column: Live Feed & Info (5 cols) */}
          <div className="lg:col-span-4 space-y-6">
            <Suspense fallback={<div className="studio-panel p-6 text-xs text-zinc-500">Loading recent listening…</div>}><RecentScrobblesFeed
              recentTracks={recentTracks}
              totalScrobbles={user?.playcount || '0'}
              isLoading={isLoadingTracks}
              onRefresh={fetchRecentTracks}
              username={isConnected ? credentials.username : ''}
              enabled={isConnected && !(summary?.cooldownResumeAt && summary.cooldownResumeAt > Date.now())}
            /></Suspense>

            <div className="studio-panel p-5 space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} className="text-red-400" />Built for visibility</div>
              <p className="text-xs text-zinc-400 leading-relaxed">Only confirmed accepted tracks count as scrobbles. Ignored tracks and dry runs stay separate.</p>
              <div className="border-t border-zinc-800 pt-4 text-xs text-zinc-500 leading-relaxed">Rate limits are recorded across all API calls. During cooldowns, requests are deferred—not silently submitted.</div>
              <p className="text-[11px] text-zinc-500">Single-operator workspace. Keep this server behind trusted access; it is not a multi-user service.</p>
              <details className="text-xs text-zinc-500"><summary className="cursor-pointer">Developer tools</summary><button onClick={handleSimulateIdle} className="secondary-button mt-3 text-xs">Simulate idle gap (not playback)</button></details>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 py-6 text-center text-xs text-zinc-500 font-mono">
        <p>ScrobbleForge · Your music. Your history. No silent failures.</p>
      </footer>

      {/* Auth Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        credentials={credentials}
        onSaveCredentials={authenticateLastFm}
        isConnected={isConnected}
        onDisconnect={handleDisconnect}
      />
    </div>
  );
}
