import React, { useState, useEffect, useRef } from 'react';
import {
  Terminal,
  Copy,
  Download,
  Trash2,
  Lock,
  Unlock,
  AlertTriangle,
  Clock,
  CheckCircle2,
  XCircle,
  Info,
  PauseCircle,
  PlayCircle,
} from 'lucide-react';
import { JobState, ScrobbleLog } from '../types';

interface LiveConsoleProps {
  job: JobState;
  onClearLogs: () => void;
}

export const LiveConsole: React.FC<LiveConsoleProps> = ({ job, onClearLogs }) => {
  const [autoScroll, setAutoScroll] = useState(true);
  const [filterLevel, setFilterLevel] = useState<'all' | 'success' | 'warn' | 'error' | 'rate_limit'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [countdown, setCountdown] = useState<number>(0);

  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll when logs change
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [job.logs, autoScroll]);

  // Rate limit cooldown timer
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (job.status === 'rate_limited' && job.rateLimitResumeAt) {
      const updateTimer = () => {
        const remaining = Math.max(0, Math.ceil((job.rateLimitResumeAt! - Date.now()) / 1000));
        setCountdown(remaining);
      };
      updateTimer();
      timer = setInterval(updateTimer, 1000);
    } else {
      setCountdown(0);
    }
    return () => clearInterval(timer);
  }, [job.status, job.rateLimitResumeAt]);

  const percentage =
    job.limit > 0 ? Math.min(100, Math.round((job.scrobblesCompleted / job.limit) * 100)) : 0;

  // Calculate speed & ETA
  let speedText = '—';
  let etaText = '—';
  if (job.startedAt && job.scrobblesCompleted > 0 && job.status === 'running') {
    const elapsedMinutes = (Date.now() - job.startedAt) / 60000;
    if (elapsedMinutes > 0.05) {
      const ratePerMin = Math.round(job.scrobblesCompleted / elapsedMinutes);
      speedText = `${ratePerMin} / min`;
      const remainingScrobbles = job.limit - job.scrobblesCompleted;
      if (ratePerMin > 0 && remainingScrobbles > 0) {
        const remainingMinutes = Math.ceil(remainingScrobbles / ratePerMin);
        if (remainingMinutes > 60) {
          const hours = Math.floor(remainingMinutes / 60);
          const mins = remainingMinutes % 60;
          etaText = `~${hours}h ${mins}m`;
        } else {
          etaText = `~${remainingMinutes} min`;
        }
      }
    }
  }

  const handleCopyLogs = () => {
    const text = job.logs
      .map((l) => `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const handleDownloadLogs = () => {
    const text = job.logs
      .map((l) => `[${new Date(l.timestamp).toISOString()}] [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `scrobbleforge-${Date.now()}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const filteredLogs = job.logs.filter((log) => {
    if (filterLevel !== 'all' && log.level !== filterLevel) return false;
    if (searchTerm && !log.message.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
      {/* Terminal Title Bar */}
      <div className="px-5 py-3 border-b border-zinc-800/80 bg-zinc-900/80 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="flex space-x-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/80" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
            <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
          </div>
          <div className="flex items-center space-x-2">
            <Terminal className="w-4 h-4 text-zinc-400" />
            <span className="text-xs font-mono font-medium text-zinc-300">
              Scrobble Engine Terminal
            </span>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1.5 rounded-lg text-xs font-mono flex items-center space-x-1 transition-colors ${
              autoScroll
                ? 'bg-zinc-800 text-zinc-200'
                : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'
            }`}
            title={autoScroll ? 'Auto-scroll is ON' : 'Auto-scroll is OFF'}
          >
            {autoScroll ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
            <span className="text-[10px] hidden sm:inline">Auto-scroll</span>
          </button>
          <button
            onClick={handleCopyLogs}
            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs transition-colors"
            title="Copy logs"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleDownloadLogs}
            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs transition-colors"
            title="Download log file"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClearLogs}
            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-red-400 text-xs transition-colors"
            title="Clear console"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Progress & Live Telemetry Gauge */}
      <div className="px-5 py-4 border-b border-zinc-850 bg-zinc-900/40">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
          <div className="flex items-center space-x-2 font-mono text-xs">
            <span className="text-zinc-400">Target:</span>
            <span className="font-semibold text-zinc-200">
              {job.artist} — {job.track}
            </span>
          </div>
          <div className="flex items-center space-x-4 text-xs font-mono">
            <div>
              <span className="text-zinc-500 mr-1.5">Rate:</span>
              <span className="text-zinc-300">{speedText}</span>
            </div>
            <div>
              <span className="text-zinc-500 mr-1.5">ETA:</span>
              <span className="text-zinc-300">{etaText}</span>
            </div>
            <div>
              <span className="text-zinc-500 mr-1.5">Progress:</span>
              <span className="font-bold text-red-400">
                {job.scrobblesCompleted} / {job.limit} ({percentage}%)
              </span>
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-zinc-800 h-2.5 rounded-full overflow-hidden relative">
          <div
            className={`h-full transition-all duration-300 ${
              job.status === 'completed'
                ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                : job.status === 'rate_limited'
                ? 'bg-gradient-to-r from-amber-500 to-yellow-400'
                : 'bg-gradient-to-r from-red-600 via-rose-500 to-orange-500'
            }`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      {/* Rate Limit Active Notice */}
      {job.status === 'rate_limited' && (
        <div className="bg-amber-950/70 border-b border-amber-900/60 px-5 py-2.5 flex items-center justify-between text-xs text-amber-200 font-mono">
          <div className="flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 animate-pulse shrink-0" />
            <span>
              Last.fm Rate Limit reached (Code 26). Engine is waiting for cooldown...
            </span>
          </div>
          <span className="font-bold px-2 py-0.5 rounded bg-amber-900/80 border border-amber-700/60 text-amber-300">
            Resuming in {countdown}s
          </span>
        </div>
      )}

      {/* Filter / Search Bar */}
      <div className="px-5 py-2 border-b border-zinc-900 bg-zinc-950/90 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center space-x-1">
          {(['all', 'success', 'rate_limit', 'warn', 'error'] as const).map((lvl) => (
            <button
              key={lvl}
              onClick={() => setFilterLevel(lvl)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono capitalize transition-colors ${
                filterLevel === lvl
                  ? 'bg-zinc-800 text-zinc-100 font-semibold border border-zinc-700'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {lvl === 'all' ? 'All Logs' : lvl.replace('_', ' ')}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Filter messages..."
          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-[11px] text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-red-500"
        />
      </div>

      {/* Terminal Output Area */}
      <div className="p-5 font-mono text-xs overflow-y-auto max-h-96 min-h-[260px] bg-zinc-950 space-y-1.5 select-text">
        {filteredLogs.length === 0 ? (
          <div className="text-zinc-600 italic py-8 text-center">
            {job.logs.length === 0
              ? 'Console initialized. Click "Start Scrobble Stream" to begin.'
              : 'No log entries match the current filter.'}
          </div>
        ) : (
          filteredLogs.map((log) => {
            let colorClass = 'text-zinc-300';
            let icon = <Info className="w-3.5 h-3.5 text-zinc-500 shrink-0" />;

            if (log.level === 'success') {
              colorClass = 'text-emerald-400';
              icon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
            } else if (log.level === 'rate_limit') {
              colorClass = 'text-amber-400';
              icon = <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />;
            } else if (log.level === 'warn') {
              colorClass = 'text-yellow-300';
              icon = <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />;
            } else if (log.level === 'error') {
              colorClass = 'text-rose-400';
              icon = <XCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />;
            }

            return (
              <div
                key={log.id}
                className="flex items-start space-x-2 leading-relaxed hover:bg-zinc-900/40 px-1 py-0.5 rounded transition-colors"
              >
                <span className="text-zinc-600 select-none shrink-0 text-[11px]">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="shrink-0">{icon}</span>
                <span className={`break-all ${colorClass}`}>{log.message}</span>
              </div>
            );
          })
        )}
        <div ref={logsEndRef} />
      </div>

      {/* Copy Notification Toast */}
      {copyFeedback && (
        <div className="bg-emerald-950 border-t border-emerald-900 text-emerald-300 text-xs py-1.5 text-center font-mono animate-in fade-in">
          Logs copied to clipboard!
        </div>
      )}
    </div>
  );
};
