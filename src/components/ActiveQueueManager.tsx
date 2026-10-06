import React, { useState } from 'react';
import {
  ListMusic,
  Trash2,
  Shuffle,
  Play,
  Zap,
  Repeat,
  Music,
  Clock,
  Sparkles,
  Radio,
} from 'lucide-react';
import { QueueTrack } from '../types';

interface ActiveQueueManagerProps {
  queue: QueueTrack[];
  currentTrackIndex: number;
  isStreaming: boolean;
  onClearQueue: () => void;
  onRemoveTrack: (id: string) => void;
  onShuffleQueue: () => void;
  onStartStreamingQueue: (tracks: QueueTrack[], loop: boolean) => Promise<void>;
  onBatchScrobbleQueue: (tracks: QueueTrack[], spanHours: number) => Promise<boolean>;
}

export const ActiveQueueManager: React.FC<ActiveQueueManagerProps> = ({
  queue,
  currentTrackIndex,
  isStreaming,
  onClearQueue,
  onRemoveTrack,
  onShuffleQueue,
  onStartStreamingQueue,
  onBatchScrobbleQueue,
}) => {
  const [isLooping, setIsLooping] = useState(false);
  const [batchSpanHours, setBatchSpanHours] = useState(24);
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  const totalDurationSeconds = queue.reduce((acc, t) => acc + (t.duration || 180), 0);
  const totalMinutes = Math.floor(totalDurationSeconds / 60);
  const formattedDuration =
    totalMinutes > 60
      ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`
      : `${totalMinutes}m`;

  const handleBatchScrobble = async () => {
    if (queue.length === 0) return;
    setIsBatchRunning(true);
    await onBatchScrobbleQueue(queue, batchSpanHours);
    setIsBatchRunning(false);
  };

  if (queue.length === 0) {
    return (
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 text-center text-zinc-500">
        <ListMusic className="w-8 h-8 mx-auto mb-2 text-zinc-600" />
        <p className="text-xs font-semibold text-zinc-300">Your Scrobble Queue is Empty</p>
        <p className="text-[11px] text-zinc-500 mt-1 max-w-sm mx-auto">
          Use the Profile Harvester to import recents/top tracks, or the Artist Explorer to load albums and full artist pages into this queue.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl shadow-xl overflow-hidden p-6 space-y-4">
      {/* Header & Stats */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-800">
        <div>
          <div className="flex items-center space-x-2">
            <ListMusic className="w-5 h-5 text-red-500" />
            <h3 className="text-base font-bold text-zinc-100">
              Scrobble Workspace Queue ({queue.length} Tracks)
            </h3>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5 font-mono">
            Total length: {formattedDuration} · Ready to stream or batch scrobble
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={onShuffleQueue}
            className="p-2 text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs transition-colors"
            title="Shuffle Queue"
          >
            <Shuffle className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setIsLooping(!isLooping)}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center space-x-1 ${
              isLooping
                ? 'bg-red-950 border-red-700 text-red-400'
                : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Repeat className="w-3 h-3" />
            <span>{isLooping ? 'Loop ON' : 'Loop OFF'}</span>
          </button>
          <button
            onClick={onClearQueue}
            className="p-2 text-zinc-400 hover:text-red-400 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs transition-colors"
            title="Clear Queue"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Execution Bar */}
      <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-xl flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center space-x-2">
          <label className="text-xs text-zinc-400">Backfill Span:</label>
          <select
            value={batchSpanHours}
            onChange={(e) => setBatchSpanHours(parseInt(e.target.value, 10))}
            className="bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs rounded-lg px-2 py-1"
          >
            <option value="6">Past 6 Hours</option>
            <option value="24">Past 24 Hours</option>
            <option value="48">Past 2 Days</option>
            <option value="168">Past 7 Days</option>
          </select>
        </div>

        <div className="flex items-center space-x-2">
          <button
            type="button"
            onClick={() => onStartStreamingQueue(queue, isLooping)}
            className="flex items-center space-x-1.5 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-medium rounded-xl border border-zinc-700 transition-colors"
          >
            <Play className="w-3.5 h-3.5 text-red-400 fill-red-400" />
            <span>Stream Queue Paced</span>
          </button>

          <button
            type="button"
            disabled={isBatchRunning}
            onClick={handleBatchScrobble}
            className="flex items-center space-x-1.5 px-5 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-xl shadow-lg shadow-red-950/50 transition-all disabled:opacity-50"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>
              {isBatchRunning ? 'Scrobbling Batches...' : `Batch Scrobble All ${queue.length} Tracks`}
            </span>
          </button>
        </div>
      </div>

      {/* Track List */}
      <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
        {queue.map((track, idx) => {
          const isCurrentlyPlaying = isStreaming && currentTrackIndex === idx;

          return (
            <div
              key={track.id}
              className={`flex items-center justify-between p-2.5 rounded-xl border transition-all ${
                isCurrentlyPlaying
                  ? 'bg-red-950/40 border-red-800 shadow-md shadow-red-950/40'
                  : 'bg-zinc-950/60 border-zinc-850 hover:bg-zinc-850/40'
              }`}
            >
              <div className="flex items-center space-x-3 min-w-0 pr-3">
                <span className="font-mono text-xs text-zinc-500 w-6 text-center shrink-0">
                  {isCurrentlyPlaying ? (
                    <Radio className="w-4 h-4 text-red-500 animate-pulse mx-auto" />
                  ) : (
                    idx + 1
                  )}
                </span>

                <div className="w-8 h-8 rounded bg-zinc-800 shrink-0 overflow-hidden flex items-center justify-center">
                  {track.image ? (
                    <img
                      src={track.image}
                      alt={track.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Music className="w-3.5 h-3.5 text-zinc-600" />
                  )}
                </div>

                <div className="min-w-0 text-left">
                  <p
                    className={`text-xs font-semibold truncate ${
                      isCurrentlyPlaying ? 'text-red-400' : 'text-zinc-200'
                    }`}
                  >
                    {track.name}
                  </p>
                  <p className="text-[11px] text-zinc-400 truncate">
                    {track.artist} {track.album ? `· ${track.album}` : ''}
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-3 shrink-0">
                <span className="text-[10px] font-mono text-zinc-500">
                  {track.duration
                    ? `${Math.floor(track.duration / 60)}:${(track.duration % 60)
                        .toString()
                        .padStart(2, '0')}`
                    : '3:00'}
                </span>
                <button
                  onClick={() => onRemoveTrack(track.id)}
                  className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
                  title="Remove from queue"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
