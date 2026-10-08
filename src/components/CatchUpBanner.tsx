import React, { useState } from 'react';
import {
  Clock,
  Zap,
  AlertTriangle,
  Play,
  RotateCcw,
  CheckCircle,
  X,
  History,
  ListMusic,
  Disc,
} from 'lucide-react';
import { QueueTrack, RecentTrack } from '../types';

interface CatchUpBannerProps {
  lastActiveTime: number | null;
  idleDurationMs: number;
  recentTracks: RecentTrack[];
  queue: QueueTrack[];
  activeTrack: { artist: string; track: string; album: string };
  isJobRunning: boolean;
  onCatchUpBatch: (params: {
    tracks: QueueTrack[];
    startTime: number;
    endTime: number;
    resumeLive: boolean;
  }) => Promise<boolean>;
  onDismiss: () => void;
  onSimulateIdle: () => void;
}

export const CatchUpBanner: React.FC<CatchUpBannerProps> = ({
  lastActiveTime,
  idleDurationMs,
  recentTracks,
  queue,
  activeTrack,
  isJobRunning,
  onCatchUpBatch,
  onDismiss,
  onSimulateIdle,
}) => {
  const [feedback, setFeedback] = useState('');
  const [resumeLive, setResumeLive] = useState(false);
  const [sourceType, setSourceType] = useState<'recents' | 'queue' | 'active_track'>('recents');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [customCount, setCustomCount] = useState<number | null>(null);

  // If currently running, no idle gap banner needed
  if (isJobRunning || !lastActiveTime) {
    return null;
  }

  // 1 hour in ms = 3600000
  const isOneHourOrMore = idleDurationMs >= 3600000;

  // Format idle duration
  const hours = Math.floor(idleDurationMs / 3600000);
  const minutes = Math.floor((idleDurationMs % 3600000) / 60000);
  const idleFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  // Average song length ~3.5 minutes (210s)
  const defaultTracksEstimated = Math.max(
    3,
    Math.min(60, Math.floor(idleDurationMs / 210000))
  );
  const trackCountToUse = customCount ?? defaultTracksEstimated;

  const generateMissingTracks = (): QueueTrack[] => {
    const list: QueueTrack[] = [];

    if (sourceType === 'recents' && recentTracks.length > 0) {
      // Loop over recent tracks to generate missing songs based on recent history
      for (let i = 0; i < trackCountToUse; i++) {
        const item = recentTracks[i % recentTracks.length];
        const artist = item.artist?.['#text'] || item.artist?.name || 'Artist';
        const name = item.name;
        const album = item.album?.['#text'] || '';
        list.push({
          id: `catchup-${i}-${Date.now()}`,
          name,
          artist,
          album,
          duration: 210,
          image: item.image?.[1]?.['#text'],
        });
      }
    } else if (sourceType === 'queue' && queue.length > 0) {
      // Loop through existing queue
      for (let i = 0; i < trackCountToUse; i++) {
        const item = queue[i % queue.length];
        list.push({
          ...item,
          id: `catchup-q-${i}-${Date.now()}`,
        });
      }
    } else {
      // Loop with active track
      for (let i = 0; i < trackCountToUse; i++) {
        list.push({
          id: `catchup-track-${i}-${Date.now()}`,
          name: activeTrack.track || 'Track',
          artist: activeTrack.artist || 'Artist',
          album: activeTrack.album || '',
          duration: 210,
        });
      }
    }

    return list;
  };

  const handleExecuteCatchUp = async () => {
    setIsSubmitting(true);
    const tracks = generateMissingTracks();
    const startTimeSec = Math.floor(lastActiveTime / 1000);
    const endTimeSec = Math.floor(Date.now() / 1000);

    if (!window.confirm(`Submit ${tracks.length} estimated plays? These are not recovered playback records and may duplicate existing history.`)) { setIsSubmitting(false); return; }
    const ok = await onCatchUpBatch({
      tracks,
      startTime: startTimeSec,
      endTime: endTimeSec,
      resumeLive,
    });
    setIsSubmitting(false);
    if (!ok) setFeedback('Backfill was not fully accepted. Check activity results before resubmitting.');
  };

  return (
    <div className="bg-gradient-to-r from-amber-950/70 via-zinc-900 to-amber-950/40 border border-amber-800/80 rounded-2xl p-5 shadow-2xl relative overflow-hidden animate-in fade-in duration-300">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        {/* Left Info */}
        <div className="flex items-start space-x-3.5">
          <div className="p-2.5 rounded-xl bg-amber-900/60 border border-amber-700/80 text-amber-300 shrink-0 mt-0.5">
            <Clock className="w-5 h-5 animate-pulse" />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold uppercase tracking-wider text-amber-400 font-mono">
                Estimated backfill ({idleFormatted})
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-amber-900/80 text-amber-200 border border-amber-700 font-mono">
                {isOneHourOrMore ? '> 1 Hour Gap' : 'Recent Gap'}
              </span>
            </div>

            <h3 className="text-sm font-semibold text-zinc-100">
              Your Live scrobbling session has been idle for {idleFormatted}.
            </h3>

            <p className="text-xs text-zinc-300 leading-relaxed max-w-xl">
              Last recorded activity was at{' '}
              <strong className="text-amber-300 font-mono">
                {new Date(lastActiveTime).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </strong>
              . This does not prove any plays are missing. Preview an estimated backfill of ~
              <strong className="text-white">{trackCountToUse} estimated tracks</strong> into this gap.
            </p>
          </div>
        </div>

        {/* Dismiss and test tools */}
        <div className="flex items-center space-x-2 self-start">
          <button
            onClick={onSimulateIdle}
            className="text-[11px] font-mono px-2 py-1 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700 transition-colors"
            title="Sets the last active timestamp to 1 hour and 15 minutes ago"
          >
            Simulate 1h Idle
          </button>
          <button
            onClick={onDismiss}
            className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
            title="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

{feedback && <p role="alert" className="text-xs text-rose-300 mt-3">{feedback}</p>}
      <details className="text-xs text-zinc-400 mt-4"><summary className="cursor-pointer">Preview estimated tracks and time range</summary><p className="mt-2">{new Date(lastActiveTime).toLocaleString()} → {new Date().toLocaleString()}</p><ol className="mt-2 max-h-40 overflow-auto space-y-1">{generateMissingTracks().map((track, i) => <li key={i}>{i + 1}. {track.artist} — {track.name}</li>)}</ol></details>
      {/* Catch-up Configuration Row */}
      <div className="mt-4 pt-3 border-t border-amber-900/40 flex flex-wrap items-center justify-between gap-3 text-xs">
        {/* Source selector */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-zinc-400 font-medium">Backfill Using:</span>
          <div className="flex items-center space-x-1 p-0.5 bg-zinc-950 rounded-lg border border-zinc-800">
            <button
              onClick={() => setSourceType('recents')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                sourceType === 'recents'
                  ? 'bg-amber-600 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Recent History
            </button>
            <button
              onClick={() => setSourceType('queue')}
              disabled={queue.length === 0}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors disabled:opacity-40 ${
                sourceType === 'queue'
                  ? 'bg-amber-600 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Queue ({queue.length})
            </button>
            <button
              onClick={() => setSourceType('active_track')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                sourceType === 'active_track'
                  ? 'bg-amber-600 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Active Track ({activeTrack.track})
            </button>
          </div>
        </div>

        {/* Count Adjustment */}
        <div className="flex items-center space-x-2">
          <label className="text-zinc-400">Tracks to Fill:</label>
          <input
            type="number"
            min="1"
            max="150"
            aria-label="Estimated backfill track count"
            value={trackCountToUse}
            onChange={(e) => setCustomCount(Math.min(150, Math.max(1, parseInt(e.target.value, 10) || 1)))}
            className="w-16 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-center font-mono text-zinc-100"
          />
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center space-x-1.5 cursor-pointer text-zinc-300">
            <input
              type="checkbox"
              checked={resumeLive}
              onChange={(e) => setResumeLive(e.target.checked)}
              className="w-3.5 h-3.5 rounded text-amber-600 bg-zinc-950 border-zinc-700"
            />
            <span className="text-[11px]">Resume Live Stream</span>
          </label>

          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleExecuteCatchUp}
            className="flex items-center space-x-1.5 px-4 py-2 bg-gradient-to-r from-amber-600 to-red-600 hover:from-amber-500 hover:to-red-500 text-white font-medium rounded-xl shadow-lg shadow-amber-950/60 transition-all hover:scale-[1.02] disabled:opacity-50"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>
              {isSubmitting
                ? 'Backfilling Gap...'
                : `Catch-up ${trackCountToUse} Estimated Tracks`}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
