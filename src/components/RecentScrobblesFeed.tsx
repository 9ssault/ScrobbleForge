import React, { useState, useEffect, useMemo } from 'react';
import {
  RefreshCw,
  ExternalLink,
  Music,
  Radio,
  Disc3,
  BarChart3,
  TrendingUp,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { RecentTrack } from '../types';

interface RecentScrobblesFeedProps {
  recentTracks: RecentTrack[];
  totalScrobbles: number | string;
  isLoading: boolean;
  onRefresh: () => void;
  username: string;
  enabled: boolean;
}

interface HourlyScrobblePoint {
  hourLabel: string;
  fullTime: string;
  count: number;
}

export const RecentScrobblesFeed: React.FC<RecentScrobblesFeedProps> = ({
  recentTracks,
  totalScrobbles,
  isLoading,
  onRefresh,
  username,
  enabled,
}) => {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [chartType, setChartType] = useState<'area' | 'bar'>('area');
  const [showChart, setShowChart] = useState(true);

  // Auto-refresh interval (12s)
  useEffect(() => {
    if (!autoRefresh || !enabled) return;
    const interval = setInterval(() => {
      if (!document.hidden) onRefresh();
    }, 20000);
    return () => clearInterval(interval);
  }, [autoRefresh, enabled, onRefresh]);

  // Compute 24-hour hourly frequency distribution using Recharts data format
  const { hourlyData, total24h, peakHour, peakCount } = useMemo(() => {
    const now = Date.now();
    const buckets: HourlyScrobblePoint[] = [];

    // Create 24 hourly buckets: from 23 hours ago up to current hour
    for (let h = 23; h >= 0; h--) {
      const targetTime = new Date(now - h * 3600 * 1000);
      const hourLabel = targetTime.toLocaleTimeString([], {
        hour: 'numeric',
        hour12: true,
      });
      const fullTime = targetTime.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      buckets.push({
        hourLabel,
        fullTime,
        count: 0,
      });
    }

    let sum24h = 0;
    let maxCount = 0;
    let maxHour = '';

    recentTracks.forEach((track) => {
      if (track['@attr']?.nowplaying === 'true' || !track.date?.uts) return;
      const trackTime = parseInt(track.date.uts, 10) * 1000;

      const diffMs = now - trackTime;
      const diffHours = Math.floor(diffMs / 3600000);

      // Within last 24 hours
      if (diffHours >= 0 && diffHours < 24) {
        const bucketIndex = 23 - diffHours;
        if (buckets[bucketIndex]) {
          buckets[bucketIndex].count += 1;
          sum24h += 1;
        }
      }
    });

    buckets.forEach((b) => {
      if (b.count > maxCount) {
        maxCount = b.count;
        maxHour = b.hourLabel;
      }
    });

    return {
      hourlyData: buckets,
      total24h: sum24h,
      peakHour: maxHour || 'None',
      peakCount: maxCount,
    };
  }, [recentTracks]);

  const formatTimestamp = (track: RecentTrack) => {
    if (track['@attr']?.nowplaying === 'true') {
      return (
        <span className="flex items-center space-x-1.5 text-red-400 font-medium">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
          <span>Now Playing</span>
        </span>
      );
    }
    if (track.date?.uts) {
      const uts = parseInt(track.date.uts, 10);
      const diffSec = Math.floor(Date.now() / 1000 - uts);
      if (diffSec < 60) return `${diffSec}s ago`;
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
      return `${Math.floor(diffSec / 86400)}d ago`;
    }
    return track.date?.['#text'] || 'Recently';
  };

  return (
    <div className="studio-panel p-5 flex flex-col space-y-4">
      {/* Top Header */}
      <div className="flex flex-wrap gap-3 items-center justify-between pb-3 border-b border-zinc-800">
        <div>
          <div className="flex items-center space-x-2">
            <Disc3
              className="w-4 h-4 text-red-500 animate-spin"
              style={{ animationDuration: '6s' }}
            />
            <h3 className="text-sm font-bold text-zinc-100">Recent listening</h3>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Activity for{' '}
            <span className="font-semibold text-zinc-300">@{username || 'user'}</span>
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowChart(!showChart)}
            className={`p-1.5 rounded-lg text-xs transition-colors flex items-center space-x-1 ${
              showChart
                ? 'bg-red-950/70 border border-red-800/60 text-red-300'
                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
            title="Toggle recent-track sample chart"
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span className="text-[10px] hidden sm:inline">Activity</span>
          </button>

          <label className="flex items-center space-x-1.5 text-xs text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-3.5 h-3.5 rounded text-red-600 bg-zinc-900 border-zinc-700"
            />
            <span className="text-[11px] hidden sm:inline">Auto</span>
          </label>

          <button
            aria-label="Refresh recent listening"
            onClick={onRefresh}
            disabled={isLoading || !enabled}
            className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
            title="Refresh feed"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-red-400' : ''}`}
            />
          </button>
        </div>
      </div>

      {/* RECHARTS COMPONENT: 24-HOUR SCROBBLE FREQUENCY */}
      {showChart && (
        <div className="bg-zinc-950/70 border border-zinc-800 rounded-xl p-3.5 space-y-2.5 animate-in fade-in">
          {/* Chart Header & 24h Summary Metrics */}
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3 text-xs">
              <div>
                <span className="text-zinc-500 mr-1.5">Sample (24h):</span>
                <span className="font-bold text-red-400 font-mono">
                  {total24h} scrobbles
                </span>
              </div>
              {peakCount > 0 && (
                <div>
                  <span className="text-zinc-500 mr-1.5">Peak:</span>
                  <span className="text-zinc-300 font-mono text-[11px]">
                    {peakCount}/hr ({peakHour})
                  </span>
                </div>
              )}
            </div>

            {/* Area vs Bar Switcher */}
            <div className="flex items-center space-x-1 p-0.5 bg-zinc-900 rounded-lg border border-zinc-800">
              <button
                onClick={() => setChartType('area')}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  chartType === 'area'
                    ? 'bg-red-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Area
              </button>
              <button
                onClick={() => setChartType('bar')}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  chartType === 'bar'
                    ? 'bg-red-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Bar
              </button>
            </div>
          </div>

          {/* Recharts Container */}
          <div className="h-28 w-full">
            <ResponsiveContainer width="100%" height="100%">
              {chartType === 'area' ? (
                <AreaChart
                  data={hourlyData}
                  margin={{ top: 8, right: 8, left: -24, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="scrobbleRedGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.5} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="hourLabel"
                    stroke="#71717a"
                    fontSize={9}
                    tickLine={false}
                    interval={3}
                  />
                  <YAxis
                    stroke="#71717a"
                    fontSize={9}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload as HourlyScrobblePoint;
                        return (
                          <div className="bg-zinc-900 border border-zinc-700 px-2.5 py-1.5 rounded-lg shadow-xl text-xs font-mono">
                            <p className="text-zinc-400 text-[10px]">{data.hourLabel}</p>
                            <p className="font-bold text-red-400">
                              {data.count} {data.count === 1 ? 'scrobble' : 'scrobbles'}
                            </p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="#ef4444"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#scrobbleRedGrad)"
                  />
                </AreaChart>
              ) : (
                <BarChart
                  data={hourlyData}
                  margin={{ top: 8, right: 8, left: -24, bottom: 0 }}
                >
                  <XAxis
                    dataKey="hourLabel"
                    stroke="#71717a"
                    fontSize={9}
                    tickLine={false}
                    interval={3}
                  />
                  <YAxis
                    stroke="#71717a"
                    fontSize={9}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload as HourlyScrobblePoint;
                        return (
                          <div className="bg-zinc-900 border border-zinc-700 px-2.5 py-1.5 rounded-lg shadow-xl text-xs font-mono">
                            <p className="text-zinc-400 text-[10px]">{data.hourLabel}</p>
                            <p className="font-bold text-red-400">
                              {data.count} {data.count === 1 ? 'scrobble' : 'scrobbles'}
                            </p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Bar
                    dataKey="count"
                    fill="#ef4444"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={16}
                  />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
      )}

<p className="text-[11px] text-zinc-500 leading-relaxed">Chart covers the latest {recentTracks.length} fetched tracks, not your complete 24-hour history. Now Playing is excluded.</p>
      {/* Tracks List */}
      <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
        {recentTracks.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 text-xs italic">
            {!username ? 'Connect your account to view recent listening.' : isLoading ? 'Fetching recent scrobbles…' : 'No recent scrobbles found on profile.'}
          </div>
        ) : (
          recentTracks.map((item, index) => {
            const artistName = item.artist?.['#text'] || item.artist?.name || 'Unknown Artist';
            const albumName = item.album?.['#text'] || '';
            const albumArt = item.image?.[1]?.['#text'] || item.image?.[0]?.['#text'];
            const isNowPlaying = item['@attr']?.nowplaying === 'true';

            return (
              <div
                key={`${item.name}-${item.date?.uts || index}`}
                className={`p-2.5 rounded-xl border transition-all flex items-center justify-between group ${
                  isNowPlaying
                    ? 'bg-red-950/20 border-red-900/50 hover:bg-red-950/30'
                    : 'bg-zinc-950/60 border-zinc-800/80 hover:bg-zinc-850/40 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center space-x-3 min-w-0 pr-3">
                  {/* Artwork */}
                  <div className="w-10 h-10 rounded-lg bg-zinc-800 shrink-0 overflow-hidden relative flex items-center justify-center border border-zinc-800">
                    {albumArt ? (
                      <img
                        src={albumArt}
                        alt={albumName || item.name}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <Music className="w-4 h-4 text-zinc-600" />
                    )}
                    {isNowPlaying && (
                      <div className="absolute inset-0 bg-red-950/40 flex items-center justify-center">
                        <Radio className="w-3.5 h-3.5 text-red-400 animate-pulse" />
                      </div>
                    )}
                  </div>

                  {/* Track Info */}
                  <div className="min-w-0 text-left">
                    <div className="flex items-center space-x-1.5">
                      <p className="text-xs font-semibold text-zinc-100 truncate group-hover:text-red-400 transition-colors">
                        {item.name}
                      </p>
                    </div>
                    <p className="text-[11px] text-zinc-400 truncate">
                      {artistName} {albumName ? `· ${albumName}` : ''}
                    </p>
                  </div>
                </div>

                {/* Right side: Timestamp & Link */}
                <div className="flex items-center space-x-2 shrink-0 text-right">
                  <div className="text-[11px] text-zinc-500 font-mono">
                    {formatTimestamp(item)}
                  </div>
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-600 hover:text-zinc-300 transition-colors p-1"
                      title="Open on Last.fm"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer link to user profile */}
      {username && (
        <div className="pt-3 border-t border-zinc-800 flex items-center justify-between text-[11px] text-zinc-500">
          <span>Total registered plays: {parseInt(String(totalScrobbles || 0), 10).toLocaleString()}</span>
          <a
            href={`https://www.last.fm/user/${username}`}
            target="_blank"
            rel="noreferrer"
            className="text-red-400 hover:text-red-300 flex items-center space-x-1 transition-colors"
          >
            <span>Open Profile Page</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}
    </div>
  );
};
