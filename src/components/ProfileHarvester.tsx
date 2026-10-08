import React, { useState } from 'react';
import {
  Users,
  Search,
  ListMusic,
  Heart,
  TrendingUp,
  Clock,
  Sparkles,
  Zap,
  PlusCircle,
  CheckSquare,
  Square,
  Music,
  ExternalLink,
} from 'lucide-react';
import { QueueTrack } from '../types';

interface ProfileHarvesterProps {
  apiKey: string;
  defaultUsername: string;
  onAddTracksToQueue: (tracks: QueueTrack[]) => void;
  onInstantBatchScrobble: (tracks: QueueTrack[], spanHours: number) => Promise<boolean>;
  onStartStreamingQueue: (tracks: QueueTrack[], loop: boolean) => Promise<void>;
}

export const ProfileHarvester: React.FC<ProfileHarvesterProps> = ({
  apiKey,
  defaultUsername,
  onAddTracksToQueue,
  onInstantBatchScrobble,
  onStartStreamingQueue,
}) => {
  const [targetUser, setTargetUser] = useState(defaultUsername || '');
  const [fetchType, setFetchType] = useState<'recents' | 'top' | 'loved'>('recents');
  const [period, setPeriod] = useState<string>('overall');
  const [limitPerPage, setLimitPerPage] = useState<number>(50);
  const [pagesToFetch, setPagesToFetch] = useState<number>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [fetchedTracks, setFetchedTracks] = useState<QueueTrack[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isBatchSubmitting, setIsBatchSubmitting] = useState(false);
  const [batchSpanHours, setBatchSpanHours] = useState<number>(24);

  const handleFetch = async () => {
    if (!targetUser.trim()) return;
    if (!apiKey) { setStatusMessage('Connect Last.fm before importing a profile.'); return; }
    setIsLoading(true);
    setStatusMessage(null);
    setFetchedTracks([]); setSelectedIds(new Set());

    try {
      const url = `/api/lastfm/fetch-profile-tracks?username=${encodeURIComponent(
        targetUser.trim()
      )}&type=${fetchType}&period=${period}&limit=${limitPerPage}&pages=${pagesToFetch}&apiKey=${apiKey}`;

      const res = await fetch(url);
      const data = await res.json();

      if (data.ok && Array.isArray(data.tracks)) {
        setFetchedTracks(data.tracks);
        // Default: select all
        setSelectedIds(new Set(data.tracks.map((t: QueueTrack) => t.id)));
        setStatusMessage(
          `✅ Successfully fetched ${data.tracks.length} songs from @${data.username}'s ${fetchType}!`
        );
      } else {
        setStatusMessage(`❌ Error: ${data.error || 'Failed to fetch tracks'}`);
      }
    } catch (e: any) {
      setStatusMessage(`❌ Network error: ${e.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handleSelectAll = () => {
    setSelectedIds(new Set(fetchedTracks.map((t) => t.id)));
  };

  const handleDeselectAll = () => {
    setSelectedIds(new Set());
  };

  const getSelectedTracks = () => {
    return fetchedTracks.filter((t) => selectedIds.has(t.id));
  };

  const handleQueueSelected = () => {
    const selected = getSelectedTracks();
    if (selected.length === 0) return;
    onAddTracksToQueue(selected);
    setStatusMessage(`Added ${selected.length} songs to the scrobble queue!`);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const handleBatchScrobbleSelected = async () => {
    const selected = getSelectedTracks();
    if (selected.length === 0) return;
    if (isBatchSubmitting) return; setIsBatchSubmitting(true);
    setStatusMessage(`Submitting batch of ${selected.length} songs...`);
    const ok = await onInstantBatchScrobble(selected, batchSpanHours);
    setIsBatchSubmitting(false);
    if (ok) {
      setStatusMessage(`🎉 Successfully scrobbled all ${selected.length} tracks to Last.fm!`);
    } else {
      setStatusMessage(`❌ Failed to scrobble batch.`);
    }
  };

  const handleStreamSelected = async () => {
    const selected = getSelectedTracks();
    if (selected.length === 0) return;
    await onStartStreamingQueue(selected, false);
  };

  return (
    <div className="studio-panel overflow-hidden p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-zinc-800">
        <div>
          <div className="flex items-center space-x-2">
            <Users className="w-5 h-5 text-red-500" />
            <h3 className="text-base font-bold text-zinc-100">
              Profile Harvester & Song Importer
            </h3>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Import recent plays, top tracks, or loved songs from a public Last.fm profile.
          </p>
        </div>
      </div>

      {/* Query Controls */}
      <div className="bg-zinc-950/70 p-4 rounded-xl border border-zinc-800/80 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Username */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">
              Last.fm Profile Username
            </label>
            <div className="relative">
              <input
                aria-label="Profile username to import"
                type="text"
                value={targetUser}
                onChange={(e) => setTargetUser(e.target.value)}
                placeholder="e.g. username"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-medium text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-500"
              />
            </div>
          </div>

          {/* Type Selector */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">
              Collection Type
            </label>
            <div className="grid grid-cols-3 gap-1 p-1 bg-zinc-900 rounded-xl border border-zinc-800">
              <button
                type="button"
                onClick={() => setFetchType('recents')}
                className={`text-xs py-1.5 rounded-lg font-medium transition-colors ${
                  fetchType === 'recents'
                    ? 'bg-red-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Recents
              </button>
              <button
                type="button"
                onClick={() => setFetchType('top')}
                className={`text-xs py-1.5 rounded-lg font-medium transition-colors ${
                  fetchType === 'top'
                    ? 'bg-red-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Top Tracks
              </button>
              <button
                type="button"
                onClick={() => setFetchType('loved')}
                className={`text-xs py-1.5 rounded-lg font-medium transition-colors ${
                  fetchType === 'loved'
                    ? 'bg-red-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Loved
              </button>
            </div>
          </div>

          {/* Timeframe for Top Tracks or Limit */}
          <div>
            {fetchType === 'top' ? (
              <>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Time Period
                </label>
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-medium text-zinc-100 focus:outline-none focus:border-red-500"
                >
                  <option value="overall">All-Time Overall</option>
                  <option value="12month">Past 12 Months</option>
                  <option value="6month">Past 6 Months</option>
                  <option value="3month">Past 3 Months</option>
                  <option value="1month">Past 30 Days</option>
                  <option value="7day">Past 7 Days</option>
                </select>
              </>
            ) : (
              <>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Depth (Pages to Crawl)
                </label>
                <div className="flex items-center space-x-2">
                  <select
                    value={pagesToFetch}
                    onChange={(e) => setPagesToFetch(parseInt(e.target.value, 10))}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-medium text-zinc-100 focus:outline-none focus:border-red-500"
                  >
                    <option value="1">1 Page (50 tracks)</option>
                    <option value="2">2 Pages (100 tracks)</option>
                    <option value="3">3 Pages (150 tracks)</option>
                    <option value="4">4 Pages (200 tracks)</option>
                    <option value="6">6 Pages (300 tracks)</option>
                    <option value="10">10 Pages (500 tracks)</option>
                  </select>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Fetch Action Button */}
        <div className="pt-2 flex items-center justify-between">
          <span className="text-[11px] text-zinc-500">
            Crawl live data directly via Last.fm Web Services API
          </span>
          <button
            type="button"
            disabled={isLoading || !targetUser.trim()}
            onClick={handleFetch}
            className="flex items-center space-x-2 px-5 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-medium shadow-md shadow-red-950/50 transition-all disabled:opacity-50"
          >
            <Search className="w-3.5 h-3.5" />
            <span>{isLoading ? 'Crawling Profile...' : `Fetch ${fetchType.toUpperCase()} from @${targetUser}`}</span>
          </button>
        </div>
      </div>

      {/* Status banner */}
      {statusMessage && (
        <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-xl text-xs font-mono text-zinc-300">
          {statusMessage}
        </div>
      )}

      {/* Results & Batch Operations */}
      {fetchedTracks.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-zinc-950/80 border border-zinc-800 rounded-xl">
            <div className="flex items-center space-x-3 text-xs">
              <span className="font-bold text-zinc-200">
                {selectedIds.size} / {fetchedTracks.length} Selected
              </span>
              <button
                onClick={handleSelectAll}
                className="text-zinc-400 hover:text-zinc-200 underline text-xs"
              >
                Select All
              </button>
              <button
                onClick={handleDeselectAll}
                className="text-zinc-400 hover:text-zinc-200 underline text-xs"
              >
                Clear
              </button>
            </div>

            {/* Quick Actions for Selected Tracks */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleQueueSelected}
                disabled={selectedIds.size === 0 || isBatchSubmitting}
                className="flex items-center space-x-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium border border-zinc-700 transition-colors disabled:opacity-50"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>Add to Queue</span>
              </button>

              <button
                onClick={handleStreamSelected}
                disabled={selectedIds.size === 0 || isBatchSubmitting}
                className="flex items-center space-x-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium border border-zinc-700 transition-colors disabled:opacity-50"
              >
                <Clock className="w-3.5 h-3.5 text-red-400" />
                <span>Stream Paced</span>
              </button>

              <button
                onClick={handleBatchScrobbleSelected}
                disabled={selectedIds.size === 0 || isBatchSubmitting}
                className="flex items-center space-x-1.5 px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-medium shadow-md transition-all disabled:opacity-50"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>Scrobble All Selected Now</span>
              </button>
            </div>
          </div>

          {/* Tracks List */}
          <div className="max-h-80 overflow-y-auto space-y-1.5 border border-zinc-800/80 rounded-xl p-2 bg-zinc-950/40">
            {fetchedTracks.map((item, idx) => {
              const isSelected = selectedIds.has(item.id);
              return (
                <div
                  key={item.id}
                  role="checkbox" aria-checked={isSelected} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelect(item.id); } }}
                  onClick={() => toggleSelect(item.id)}
                  className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all border ${
                    isSelected
                      ? 'bg-zinc-900 border-zinc-700'
                      : 'bg-zinc-950/60 border-zinc-900 opacity-60 hover:opacity-100'
                  }`}
                >
                  <div className="flex items-center space-x-3 min-w-0 pr-2">
                    <button
                      aria-label={`Select ${item.name}`}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(item.id);
                      }}
                      className="text-zinc-400 hover:text-zinc-200 shrink-0"
                    >
                      {isSelected ? (
                        <CheckSquare className="w-4 h-4 text-red-500" />
                      ) : (
                        <Square className="w-4 h-4" />
                      )}
                    </button>

                    <div className="w-8 h-8 rounded bg-zinc-800 shrink-0 overflow-hidden flex items-center justify-center">
                      {item.image ? (
                        <img
                          src={item.image}
                          alt={item.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <Music className="w-3.5 h-3.5 text-zinc-600" />
                      )}
                    </div>

                    <div className="min-w-0 text-left">
                      <p className="text-xs font-semibold text-zinc-200 truncate">
                        {item.name}
                      </p>
                      <p className="text-[11px] text-zinc-400 truncate">
                        {item.artist} {item.album ? `· ${item.album}` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2 text-right shrink-0">
                    {item.playcount && (
                      <span className="text-[10px] font-mono text-zinc-500">
                        {parseInt(String(item.playcount), 10).toLocaleString()} plays
                      </span>
                    )}
                    <span className="text-[10px] text-zinc-600 font-mono">
                      #{idx + 1}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
