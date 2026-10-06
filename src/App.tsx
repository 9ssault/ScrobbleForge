/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { AuthModal } from './components/AuthModal';
import { ScrobblerEngine } from './components/ScrobblerEngine';
import { UniversalSearchExplorer } from './components/UniversalSearchExplorer';
import { ProfileHarvester } from './components/ProfileHarvester';
import { ArtistCatalogExplorer } from './components/ArtistCatalogExplorer';
import { ActiveQueueManager } from './components/ActiveQueueManager';
import { GeminiChatbot } from './components/GeminiChatbot';
import { CatchUpBanner } from './components/CatchUpBanner';
import { LiveConsole } from './components/LiveConsole';
import { RecentScrobblesFeed } from './components/RecentScrobblesFeed';
import {
  LastFmCredentials,
  LastFmUser,
  JobState,
  RecentTrack,
  QueueTrack,
} from './types';
import { Radio, Info } from 'lucide-react';

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
  // Navigation / workspace tab
  const [activeNavTab, setActiveNavTab] = useState<
    'stream' | 'search' | 'ai' | 'harvester' | 'artist' | 'queue' | 'instant'
  >('stream');

  // Credentials & Auth
  const [credentials, setCredentials] = useState<LastFmCredentials>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_CREDS_KEY);
      if (saved) return JSON.parse(saved);
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
      if (savedQueue) return JSON.parse(savedQueue);
    } catch {}
    return [];
  });

  // Save queue to local storage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_QUEUE_KEY, JSON.stringify(queue));
    } catch {}
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
            sessionKey: data.sessionKey,
          };
          setCredentials(updatedCreds);
          try {
            localStorage.setItem(STORAGE_CREDS_KEY, JSON.stringify(updatedCreds));
          } catch {}

          if (data.user) {
            setUser(data.user);
          }
          setIsConnected(true);
          return true;
        }
        return false;
      } catch (e) {
        console.error('Auth error', e);
        return false;
      }
    },
    []
  );

  // Fetch user profile and playcount
  const fetchUserInfo = useCallback(async () => {
    if (!credentials.apiKey || !credentials.username) return;
    setIsRefreshingUser(true);
    try {
      const res = await fetch(
        `/api/lastfm/user-info?apiKey=${credentials.apiKey}&username=${credentials.username}`
      );
      const data = await res.json();
      if (data.ok && data.user) {
        setUser(data.user);
        setIsConnected(true);
      }
    } catch (e) {
      console.error('Fetch user info error', e);
    } finally {
      setIsRefreshingUser(false);
    }
  }, [credentials.apiKey, credentials.username]);

  // Fetch recent scrobbles
  const fetchRecentTracks = useCallback(async () => {
    if (!credentials.apiKey || !credentials.username) return;
    setIsLoadingTracks(true);
    try {
      const res = await fetch(
        `/api/lastfm/recent-tracks?apiKey=${credentials.apiKey}&username=${credentials.username}&limit=60`
      );
      const data = await res.json();
      if (data.ok && data.recentTracks) {
        setRecentTracks(Array.isArray(data.recentTracks) ? data.recentTracks : [data.recentTracks]);
      }
    } catch (e) {
      console.error('Fetch recent tracks error', e);
    } finally {
      setIsLoadingTracks(false);
    }
  }, [credentials.apiKey, credentials.username]);

  // Initial connect on load
  useEffect(() => {
    if (credentials.username && (credentials.apiKey || credentials.sessionKey)) {
      authenticateLastFm(credentials).then((ok) => {
        if (ok) {
          fetchRecentTracks();
        }
      });
    }
  }, []);

  // Poll recent tracks while job is active
  useEffect(() => {
    if (job.status === 'running') {
      const interval = setInterval(() => {
        fetchRecentTracks();
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [job.status, fetchRecentTracks]);

  // SSE event stream listener
  useEffect(() => {
    const eventSource = new EventSource('/api/job/events');

    eventSource.addEventListener('status', (e) => {
      try {
        const updated = JSON.parse(e.data);
        setJob((prev) => ({
          ...prev,
          ...updated,
          logs: updated.logs || prev.logs,
        }));
      } catch (err) {
        console.error('SSE parse status error', err);
      }
    });

    eventSource.addEventListener('log', (e) => {
      try {
        const newLog = JSON.parse(e.data);
        setJob((prev) => {
          const logs = [...prev.logs, newLog];
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
        alert(data.error || 'Failed to start job.');
      } else {
        // Record active time
        setLastLiveTimestamp(Date.now());
        try {
          localStorage.setItem(STORAGE_IDLE_KEY, String(Date.now()));
        } catch {}
      }
    } catch (e: any) {
      alert(e.message || 'Error communicating with server.');
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
        alert(data.error || 'Failed to start streaming queue.');
      } else {
        setLastLiveTimestamp(Date.now());
        try {
          localStorage.setItem(STORAGE_IDLE_KEY, String(Date.now()));
        } catch {}
      }
    } catch (e: any) {
      alert(e.message || 'Error starting queue stream.');
    }
  };

  // Batch Historical Scrobble
  const handleBatchScrobbleQueue = async (
    tracksToScrobble: QueueTrack[],
    spanHours: number
  ): Promise<boolean> => {
    if (!isConnected) {
      setIsAuthModalOpen(true);
      return false;
    }
    if (tracksToScrobble.length === 0) return false;

    try {
      const res = await fetch('/api/job/batch-scrobble-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracks: tracksToScrobble,
          spanHours,
          apiKey: credentials.apiKey,
          apiSecret: credentials.apiSecret,
          sessionKey: credentials.sessionKey,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTimeout(fetchRecentTracks, 1500);
        setTimeout(fetchUserInfo, 2500);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  // Catch-Up Missing Tracks Handler
  const handleCatchUpBatch = async (params: {
    tracks: QueueTrack[];
    startTime: number;
    endTime: number;
    resumeLive: boolean;
  }): Promise<boolean> => {
    if (!isConnected) {
      setIsAuthModalOpen(true);
      return false;
    }

    try {
      const res = await fetch('/api/job/batch-scrobble-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracks: params.tracks,
          startTime: params.startTime,
          endTime: params.endTime,
          apiKey: credentials.apiKey,
          apiSecret: credentials.apiSecret,
          sessionKey: credentials.sessionKey,
        }),
      });

      const data = await res.json();
      if (data.ok) {
        // Reset idle timestamp to now
        const now = Date.now();
        setLastLiveTimestamp(now);
        try {
          localStorage.setItem(STORAGE_IDLE_KEY, String(now));
        } catch {}
        setIsIdleDismissed(true);

        setTimeout(fetchRecentTracks, 1500);
        setTimeout(fetchUserInfo, 2500);

        // Resume live stream if requested
        if (params.resumeLive) {
          if (queue.length > 0) {
            handleStartStreamingQueue(queue, true);
          } else {
            handleStartJob({
              artist: job.artist,
              track: job.track,
              album: job.album,
              limit: job.limit,
              interval: job.interval,
              jitter: job.jitter,
              isDryRun: job.isDryRun,
            });
          }
        }

        return true;
      }
      return false;
    } catch {
      return false;
    }
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
    setQueue((prev) => [...prev, ...newTracks]);
    setActiveNavTab('queue');
  };

  const handleRemoveTrack = (id: string) => {
    setQueue((prev) => prev.filter((t) => t.id !== id));
  };

  const handleShuffleQueue = () => {
    setQueue((prev) => [...prev].sort(() => Math.random() - 0.5));
  };

  const handleClearQueue = () => {
    setQueue([]);
  };

  const handlePauseJob = async () => {
    await fetch('/api/job/pause', { method: 'POST' });
  };

  const handleResumeJob = async () => {
    await fetch('/api/job/resume', { method: 'POST' });
  };

  const handleStopJob = async () => {
    await fetch('/api/job/stop', { method: 'POST' });
  };

  const handleClearLogs = async () => {
    await fetch('/api/job/clear-logs', { method: 'POST' });
    setJob((prev) => ({ ...prev, logs: [] }));
  };

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
      return false;
    } catch {
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
      return false;
    } catch {
      return false;
    }
  };

  const handleDisconnect = () => {
    localStorage.removeItem(STORAGE_CREDS_KEY);
    setCredentials({
      apiKey: '',
      apiSecret: '',
      username: '',
      password: '',
      sessionKey: '',
    });
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
        {/* Banner */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-zinc-900 via-zinc-900 to-zinc-950 p-6 rounded-2xl border border-zinc-800 shadow-xl">
          <div className="space-y-1">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center space-x-2">
              <span>Universal Last.fm Scrobbler Studio</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-950/80 border border-red-800/60 text-red-400 font-mono font-medium">
                Live Engine
              </span>
            </h1>
            <p className="text-xs sm:text-sm text-zinc-400 max-w-2xl leading-relaxed">
              Universal search for users, artists, and albums · Automatic &gt;1h idle detection with 1-click catch-up backfilling · Continuous live streaming and batch historical scrobbler.
            </p>
          </div>

          <div className="flex items-center space-x-2 shrink-0">
            {/* Quick Simulate 1h Idle trigger */}
            <button
              onClick={handleSimulateIdle}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-xl border border-zinc-700 transition-colors"
              title="Test the 1h Idle Detection and Catch-up banner immediately"
            >
              Simulate 1h Idle
            </button>

            {!isConnected && (
              <button
                onClick={() => setIsAuthModalOpen(true)}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-medium text-xs rounded-xl shadow-lg shadow-red-950/60 transition-all flex items-center space-x-2"
              >
                <Radio className="w-4 h-4 animate-pulse" />
                <span>Connect Account</span>
              </button>
            )}
          </div>
        </div>

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
            isJobRunning={job.status === 'running'}
            onCatchUpBatch={handleCatchUpBatch}
            onDismiss={() => setIsIdleDismissed(true)}
            onSimulateIdle={handleSimulateIdle}
          />
        )}

        {/* 2-Column Responsive Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Column: Interactive Mode & Workspace (7 cols) */}
          <div className="lg:col-span-7 space-y-8">
            {/* Primary Engine Controls & Mode Tab Navigation */}
            <ScrobblerEngine
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
            />

            {/* Sub-panels based on active tab */}
            {activeNavTab === 'search' && (
              <UniversalSearchExplorer
                apiKey={credentials.apiKey}
                onAddTracksToQueue={handleAddTracksToQueue}
                onInstantBatchScrobble={handleBatchScrobbleQueue}
                onStartStreamingQueue={handleStartStreamingQueue}
              />
            )}

            {activeNavTab === 'ai' && (
              <GeminiChatbot
                onAddTracksToQueue={handleAddTracksToQueue}
                onInstantBatchScrobble={handleBatchScrobbleQueue}
                activeTrack={{
                  artist: job.artist,
                  track: job.track,
                  album: job.album,
                }}
                recentTracks={recentTracks}
                queueCount={queue.length}
              />
            )}

            {activeNavTab === 'harvester' && (
              <ProfileHarvester
                apiKey={credentials.apiKey}
                defaultUsername={credentials.username}
                onAddTracksToQueue={handleAddTracksToQueue}
                onInstantBatchScrobble={handleBatchScrobbleQueue}
                onStartStreamingQueue={handleStartStreamingQueue}
              />
            )}

            {activeNavTab === 'artist' && (
              <ArtistCatalogExplorer
                apiKey={credentials.apiKey}
                onAddTracksToQueue={handleAddTracksToQueue}
                onInstantBatchScrobble={handleBatchScrobbleQueue}
                onStartStreamingQueue={handleStartStreamingQueue}
              />
            )}

            {activeNavTab === 'queue' && (
              <ActiveQueueManager
                queue={queue}
                currentTrackIndex={job.currentQueueIndex}
                isStreaming={job.status === 'running'}
                onClearQueue={handleClearQueue}
                onRemoveTrack={handleRemoveTrack}
                onShuffleQueue={handleShuffleQueue}
                onStartStreamingQueue={handleStartStreamingQueue}
                onBatchScrobbleQueue={handleBatchScrobbleQueue}
              />
            )}

            {/* Live Terminal Console */}
            <LiveConsole job={job} onClearLogs={handleClearLogs} />
          </div>

          {/* Right Column: Live Feed & Info (5 cols) */}
          <div className="lg:col-span-5 space-y-6">
            <RecentScrobblesFeed
              recentTracks={recentTracks}
              totalScrobbles={user?.playcount || '0'}
              isLoading={isLoadingTracks}
              onRefresh={fetchRecentTracks}
              username={credentials.username}
            />

            {/* Documentation & Safeguards */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 text-xs text-zinc-400 space-y-3">
              <div className="flex items-center space-x-2 text-zinc-200 font-semibold">
                <Info className="w-4 h-4 text-red-500" />
                <span>Features & Operating Modes</span>
              </div>
              <ul className="space-y-2 list-disc list-inside text-[11px] leading-relaxed">
                <li>
                  <strong className="text-zinc-300">Idle &gt; 1h Catch-up:</strong>{' '}
                  Detects when your Live session has been idle for more than an hour and suggests auto-filling the gap using recent playback history.
                </li>
                <li>
                  <strong className="text-zinc-300">Universal Search:</strong>{' '}
                  Search any user profile, artist, album, or song on Last.fm and scrobble from them with one click.
                </li>
                <li>
                  <strong className="text-zinc-300">Profile Harvester:</strong>{' '}
                  Crawl up to 500 recent songs, top tracks, or loved songs from any user profile.
                </li>
                <li>
                  <strong className="text-zinc-300">Artist & Album Discography:</strong>{' '}
                  Load top tracks or full albums with authentic chronological track sequencing and durations.
                </li>
                <li>
                  <strong className="text-zinc-300">Rate Limit Auto-Recovery:</strong>{' '}
                  Handles Last.fm Code 26 with a 60-second cooldown timer and resumes automatically.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 py-6 text-center text-xs text-zinc-500 font-mono">
        <p>ScrobbleForge Studio · Real-time Last.fm Web Services 2.0 Integration</p>
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
