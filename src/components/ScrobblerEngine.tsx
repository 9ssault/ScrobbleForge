import React, { useState } from 'react';
import {
  Play,
  Pause,
  Square,
  Sparkles,
  Search,
  Radio,
  CheckCircle,
  Calendar,
  Zap,
  Music,
  Users,
  Disc,
  ListMusic,
  Bot,
} from 'lucide-react';
import { JobState, LastFmCredentials, QueueTrack } from '../types';

interface ScrobblerEngineProps {
  job: JobState;
  credentials: LastFmCredentials;
  isConnected: boolean;
  activeNavTab: 'stream' | 'search' | 'ai' | 'harvester' | 'artist' | 'queue' | 'instant';
  onChangeNavTab: (tab: 'stream' | 'search' | 'ai' | 'harvester' | 'artist' | 'queue' | 'instant') => void;
  queueCount: number;
  onStartJob: (params: {
    artist: string;
    track: string;
    album: string;
    limit: number;
    interval: number;
    jitter: boolean;
    isDryRun: boolean;
  }) => Promise<void>;
  onPauseJob: () => Promise<void>;
  onResumeJob: () => Promise<void>;
  onStopJob: () => Promise<void>;
  onSingleScrobble: (artist: string, track: string, album: string) => Promise<boolean>;
  onUpdateNowPlaying: (artist: string, track: string, album: string) => Promise<boolean>;
  onOpenAuth: () => void;
}

export const ScrobblerEngine: React.FC<ScrobblerEngineProps> = ({
  job,
  credentials,
  isConnected,
  activeNavTab,
  onChangeNavTab,
  queueCount,
  onStartJob,
  onPauseJob,
  onResumeJob,
  onStopJob,
  onSingleScrobble,
  onUpdateNowPlaying,
  onOpenAuth,
}) => {
  const [artist, setArtist] = useState(job.artist || 'rvaia');
  const [track, setTrack] = useState(job.track || 'kill bill');
  const [album, setAlbum] = useState(job.album || 'kill bill');
  const [limit, setLimit] = useState(job.limit || 1800);
  const [interval, setInterval] = useState(job.interval || 2);
  const [jitter, setJitter] = useState(job.jitter ?? true);
  const [isDryRun, setIsDryRun] = useState(job.isDryRun ?? false);

  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const presets = [
    {
      label: 'Config Default (rvaia - kill bill)',
      artist: 'rvaia',
      track: 'kill bill',
      album: 'kill bill',
      limit: 1800,
      interval: 2,
    },
    {
      label: 'SZA - Kill Bill',
      artist: 'SZA',
      track: 'Kill Bill',
      album: 'SOS',
      limit: 250,
      interval: 2.5,
    },
    {
      label: 'The Weeknd - Blinding Lights',
      artist: 'The Weeknd',
      track: 'Blinding Lights',
      album: 'After Hours',
      limit: 100,
      interval: 3,
    },
    {
      label: 'Daft Punk - One More Time',
      artist: 'Daft Punk',
      track: 'One More Time',
      album: 'Discovery',
      limit: 100,
      interval: 2,
    },
  ];

  const handleApplyPreset = (p: typeof presets[0]) => {
    setArtist(p.artist);
    setTrack(p.track);
    setAlbum(p.album);
    setLimit(p.limit);
    setInterval(p.interval);
    setActionFeedback(`Loaded preset: ${p.artist} - ${p.track}`);
    setTimeout(() => setActionFeedback(null), 2500);
  };

  const handleSearchTrack = async () => {
    if (!searchQuery.trim() || !credentials.apiKey) return;
    setIsSearching(true);
    try {
      const res = await fetch(
        `/api/lastfm/search?track=${encodeURIComponent(searchQuery)}&apiKey=${credentials.apiKey}`
      );
      const data = await res.json();
      if (data.ok && data.tracks) {
        setSearchResults(Array.isArray(data.tracks) ? data.tracks : [data.tracks]);
      }
    } catch {
      // Ignore
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectSearchResult = (item: any) => {
    setArtist(item.artist || '');
    setTrack(item.name || '');
    setAlbum(item.album || item.name || '');
    setSearchResults([]);
    setSearchQuery('');
  };

  const handleStart = async () => {
    if (!isConnected && !isDryRun) {
      onOpenAuth();
      return;
    }
    await onStartJob({
      artist: artist.trim(),
      track: track.trim(),
      album: album.trim(),
      limit: Number(limit),
      interval: Number(interval),
      jitter,
      isDryRun,
    });
  };

  const handleInstantScrobble = async () => {
    if (!isConnected) {
      onOpenAuth();
      return;
    }
    setActionFeedback('Submitting single test scrobble...');
    const ok = await onSingleScrobble(artist, track, album);
    if (ok) {
      setActionFeedback('✅ 1 scrobble registered on Last.fm successfully!');
    } else {
      setActionFeedback('❌ Failed to scrobble track. Check credentials.');
    }
    setTimeout(() => setActionFeedback(null), 3000);
  };

  const handleNowPlaying = async () => {
    if (!isConnected) {
      onOpenAuth();
      return;
    }
    setActionFeedback('Updating "Now Playing" on Last.fm...');
    const ok = await onUpdateNowPlaying(artist, track, album);
    if (ok) {
      setActionFeedback('🎵 Live status updated: "Scrobbling now" on Last.fm!');
    } else {
      setActionFeedback('❌ Failed to update status.');
    }
    setTimeout(() => setActionFeedback(null), 3000);
  };

  const isJobActive = job.status === 'running' || job.status === 'rate_limited';

  return (
    <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl shadow-xl overflow-hidden flex flex-col">
      {/* Navigation Bar */}
      <div className="px-6 pt-4 pb-2 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-3 bg-zinc-950/40">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-zinc-950 rounded-xl border border-zinc-800">
          <button
            onClick={() => onChangeNavTab('stream')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeNavTab === 'stream'
                ? 'bg-red-600 text-white shadow-md shadow-red-950/50'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>Single Loop</span>
          </button>

          <button
            onClick={() => onChangeNavTab('search')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeNavTab === 'search'
                ? 'bg-red-600 text-white shadow-md shadow-red-950/50'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Search className="w-3.5 h-3.5" />
            <span>Search & Scrobble</span>
          </button>

          <button
            onClick={() => onChangeNavTab('ai')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeNavTab === 'ai'
                ? 'bg-red-600 text-white shadow-md shadow-red-950/50'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            <span>ScrobbleAI</span>
          </button>

          <button
            onClick={() => onChangeNavTab('harvester')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeNavTab === 'harvester'
                ? 'bg-red-600 text-white shadow-md shadow-red-950/50'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Profile Harvester</span>
          </button>

          <button
            onClick={() => onChangeNavTab('artist')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeNavTab === 'artist'
                ? 'bg-red-600 text-white shadow-md shadow-red-950/50'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Disc className="w-3.5 h-3.5" />
            <span>Artist & Albums</span>
          </button>

          <button
            onClick={() => onChangeNavTab('queue')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all relative ${
              activeNavTab === 'queue'
                ? 'bg-red-600 text-white shadow-md shadow-red-950/50'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <ListMusic className="w-3.5 h-3.5" />
            <span>Queue</span>
            {queueCount > 0 && (
              <span className="text-[10px] font-mono bg-red-950 text-red-300 px-1.5 py-0.2 rounded-full border border-red-800 ml-1">
                {queueCount}
              </span>
            )}
          </button>

          <button
            onClick={() => onChangeNavTab('instant')}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeNavTab === 'instant'
                ? 'bg-red-600 text-white shadow-md shadow-red-950/50'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Instant</span>
          </button>
        </div>

        {/* Global Status badge */}
        <div className="flex items-center space-x-2">
          {job.status === 'running' && (
            <span className="flex items-center space-x-1.5 text-xs font-mono text-emerald-400 bg-emerald-950/60 px-2.5 py-1 rounded-full border border-emerald-800/50">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
              <span>ACTIVE</span>
            </span>
          )}
          {job.status === 'rate_limited' && (
            <span className="flex items-center space-x-1.5 text-xs font-mono text-amber-400 bg-amber-950/60 px-2.5 py-1 rounded-full border border-amber-800/50">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              <span>RATE LIMITED (60s)</span>
            </span>
          )}
          {job.status === 'paused' && (
            <span className="text-xs font-mono text-yellow-400 bg-yellow-950/50 px-2.5 py-1 rounded-full border border-yellow-800/50">
              PAUSED
            </span>
          )}
          {job.status === 'completed' && (
            <span className="text-xs font-mono text-cyan-400 bg-cyan-950/50 px-2.5 py-1 rounded-full border border-cyan-800/50">
              COMPLETED
            </span>
          )}
          {job.status === 'idle' && (
            <span className="text-xs font-mono text-zinc-500 bg-zinc-800/60 px-2.5 py-1 rounded-full border border-zinc-700/50">
              IDLE
            </span>
          )}
        </div>
      </div>

      {/* Main Single Track Stream Config Body */}
      {activeNavTab === 'stream' && (
        <div className="p-6 space-y-6">
          {/* Preset Bar */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-400 flex items-center space-x-1">
                <Sparkles className="w-3 h-3 text-red-400" />
                <span>Configuration Presets</span>
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {presets.map((p, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleApplyPreset(p)}
                  className="text-xs px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Track Metadata Card */}
          <div className="bg-zinc-950/60 p-4 rounded-xl border border-zinc-800/80 space-y-4">
            <div className="flex items-center space-x-2">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-zinc-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearchTrack()}
                  placeholder="Search Last.fm catalog to auto-fill artist & track..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-red-500"
                />
              </div>
              <button
                onClick={handleSearchTrack}
                disabled={isSearching || !searchQuery.trim()}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700 transition-colors disabled:opacity-50"
              >
                {isSearching ? 'Searching...' : 'Find Track'}
              </button>
            </div>

            {searchResults.length > 0 && (
              <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-2 max-h-40 overflow-y-auto space-y-1">
                <span className="text-[10px] uppercase text-zinc-500 px-2 font-mono">
                  Select Track to Fill:
                </span>
                {searchResults.map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSelectSearchResult(item)}
                    className="w-full text-left px-2 py-1.5 hover:bg-zinc-800 rounded text-xs text-zinc-300 flex items-center justify-between group"
                  >
                    <span className="truncate font-medium text-zinc-200 group-hover:text-red-400">
                      {item.name} — <span className="text-zinc-400">{item.artist}</span>
                    </span>
                    <span className="text-[10px] text-zinc-500 shrink-0 ml-2">Select</span>
                  </button>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Artist Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  disabled={isJobActive}
                  value={artist}
                  onChange={(e) => setArtist(e.target.value)}
                  placeholder="e.g. rvaia"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-medium text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-500 disabled:opacity-60"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Track Title <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  disabled={isJobActive}
                  value={track}
                  onChange={(e) => setTrack(e.target.value)}
                  placeholder="e.g. kill bill"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-medium text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-500 disabled:opacity-60"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Album (Optional)
                </label>
                <input
                  type="text"
                  disabled={isJobActive}
                  value={album}
                  onChange={(e) => setAlbum(e.target.value)}
                  placeholder="e.g. kill bill"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-medium text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-500 disabled:opacity-60"
                />
              </div>
            </div>
          </div>

          {/* Engine Timing & Limit */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-zinc-950/40 p-4 rounded-xl border border-zinc-800/80">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-zinc-300">
                  Target Scrobble Limit
                </label>
                <span className="text-xs font-mono text-red-400 font-bold">
                  {limit.toLocaleString()} scrobbles
                </span>
              </div>
              <input
                type="number"
                min="1"
                max="50000"
                disabled={isJobActive}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:border-red-500 disabled:opacity-60"
              />
            </div>

            <div className="bg-zinc-950/40 p-4 rounded-xl border border-zinc-800/80">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-zinc-300">
                  Pacing Interval (Seconds)
                </label>
                <span className="text-xs font-mono text-red-400 font-bold">
                  {interval}s / scrobble
                </span>
              </div>
              <input
                type="number"
                step="0.5"
                min="0.5"
                max="60"
                disabled={isJobActive}
                value={interval}
                onChange={(e) => setInterval(Math.max(0.5, parseFloat(e.target.value) || 1))}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:border-red-500 disabled:opacity-60"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 pt-1">
            <label className="flex items-center space-x-2.5 cursor-pointer">
              <input
                type="checkbox"
                disabled={isJobActive}
                checked={jitter}
                onChange={(e) => setJitter(e.target.checked)}
                className="w-4 h-4 rounded text-red-600 bg-zinc-900 border-zinc-700"
              />
              <div>
                <span className="text-xs font-medium text-zinc-300">
                  Random Jitter (±0.5s)
                </span>
                <span className="text-[11px] text-zinc-500 block">
                  Prevents uniform bot flags by staggering request times.
                </span>
              </div>
            </label>

            <label className="flex items-center space-x-2.5 cursor-pointer">
              <input
                type="checkbox"
                disabled={isJobActive}
                checked={isDryRun}
                onChange={(e) => setIsDryRun(e.target.checked)}
                className="w-4 h-4 rounded text-amber-500 bg-zinc-900 border-zinc-700"
              />
              <div>
                <span className="text-xs font-medium text-zinc-300">
                  Simulation / Dry Run
                </span>
                <span className="text-[11px] text-zinc-500 block">
                  Simulate without submitting scrobbles to Last.fm.
                </span>
              </div>
            </label>
          </div>

          {/* Action Buttons */}
          <div className="pt-2 flex flex-wrap items-center gap-3">
            {job.status === 'idle' || job.status === 'completed' || job.status === 'error' ? (
              <button
                type="button"
                onClick={handleStart}
                className="flex-1 sm:flex-initial flex items-center justify-center space-x-2 px-6 py-2.5 bg-red-600 hover:bg-red-500 text-white font-medium text-xs rounded-xl shadow-lg shadow-red-950/60 transition-all hover:scale-[1.02]"
              >
                <Play className="w-4 h-4 fill-white" />
                <span>Start Loop ({limit} scrobbles)</span>
              </button>
            ) : null}

            {job.status === 'running' && (
              <button
                type="button"
                onClick={onPauseJob}
                className="flex-1 sm:flex-initial flex items-center justify-center space-x-2 px-6 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs rounded-xl shadow-md transition-all"
              >
                <Pause className="w-4 h-4 fill-white" />
                <span>Pause</span>
              </button>
            )}

            {job.status === 'paused' && (
              <button
                type="button"
                onClick={onResumeJob}
                className="flex-1 sm:flex-initial flex items-center justify-center space-x-2 px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs rounded-xl shadow-md transition-all"
              >
                <Play className="w-4 h-4 fill-white" />
                <span>Resume</span>
              </button>
            )}

            {isJobActive || job.status === 'paused' ? (
              <button
                type="button"
                onClick={onStopJob}
                className="flex items-center justify-center space-x-2 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium text-xs rounded-xl border border-zinc-700 transition-colors"
              >
                <Square className="w-3.5 h-3.5 fill-zinc-300" />
                <span>Stop</span>
              </button>
            ) : null}
          </div>
        </div>
      )}

      {/* Instant Action Tab */}
      {activeNavTab === 'instant' && (
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-zinc-950/50 p-4 rounded-xl border border-zinc-800 flex flex-col justify-between">
              <div>
                <h4 className="text-xs font-bold text-zinc-200">1-Click Test Scrobble</h4>
                <p className="text-[11px] text-zinc-400 mt-1">
                  Instantly submits exactly 1 scrobble for &ldquo;{track}&rdquo; by {artist} to verify credentials.
                </p>
              </div>
              <button
                type="button"
                onClick={handleInstantScrobble}
                className="mt-4 flex items-center justify-center space-x-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-medium rounded-xl border border-zinc-700 transition-colors"
              >
                <Zap className="w-3.5 h-3.5 text-yellow-400" />
                <span>Send Single Test Scrobble</span>
              </button>
            </div>

            <div className="bg-zinc-950/50 p-4 rounded-xl border border-zinc-800 flex flex-col justify-between">
              <div>
                <h4 className="text-xs font-bold text-zinc-200">Broadcast &ldquo;Now Playing&rdquo;</h4>
                <p className="text-[11px] text-zinc-400 mt-1">
                  Sets your public profile status to &ldquo;Scrobbling now&rdquo; for {track} without incrementing play count.
                </p>
              </div>
              <button
                type="button"
                onClick={handleNowPlaying}
                className="mt-4 flex items-center justify-center space-x-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-medium rounded-xl border border-zinc-700 transition-colors"
              >
                <Radio className="w-3.5 h-3.5 text-red-500 animate-pulse" />
                <span>Broadcast Now Playing</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Feedback banner */}
      {actionFeedback && (
        <div className="p-3 bg-zinc-950 border-t border-zinc-800 text-xs text-zinc-300 font-mono flex items-center space-x-2">
          <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{actionFeedback}</span>
        </div>
      )}
    </div>
  );
};
