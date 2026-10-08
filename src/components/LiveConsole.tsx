import React, { useState, useEffect, useRef } from 'react';
import { Activity, Download, Trash2, AlertTriangle, CheckCircle2, XCircle, Info, Search, ChevronDown, ArrowDown, Database, LoaderCircle } from 'lucide-react';
import { JobState, ScrobbleLog } from '../types';

interface LiveConsoleProps { job: JobState; onClearLogs: () => void; cooldownResumeAt?: number | null; connection: string }
export const LiveConsole: React.FC<LiveConsoleProps> = ({ job, onClearLogs, cooldownResumeAt, connection }) => {
  const [logs, setLogs] = useState<ScrobbleLog[]>([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [clearedAt, setClearedAt] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const id = ++generation.current;
    const timer = setTimeout(async () => {
      setLoading(true); setError('');
      try {
        const query = new URLSearchParams({ level: filter, search, limit: '100' });
        const response = await fetch(`/api/activity?${query}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Could not read saved activity.');
        const data = await response.json();
        if (generation.current === id) { setLogs(previous => { const newest = data.logs.at(-1)?.seq || 0; const combined = [...data.logs, ...previous.filter(log => (log.seq || 0) > newest)]; return [...new Map(combined.map((log: ScrobbleLog) => [log.id, log])).values()]; }); setHasMore(data.hasMore); setNextBefore(data.nextBefore); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Activity unavailable.'); }
      finally { if (generation.current === id) setLoading(false); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [filter, search, connection]);
  useEffect(() => {
    setLogs(previous => {
      const byId = new Map(previous.map(log => [log.id, log]));
      for (const log of job.logs) {
        if ((filter === 'all' || log.level === filter) && (!search || JSON.stringify(log).toLowerCase().includes(search.toLowerCase()))) byId.set(log.id, log);
      }
      return [...byId.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0));
    });
  }, [job.logs, filter, search]);
  useEffect(() => { if (autoScroll && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [logs, autoScroll]);
  async function loadOlder() {
    if (!nextBefore || loading) return;
    const id = generation.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/activity?${new URLSearchParams({ before: String(nextBefore), level: filter, search, limit: '100' })}`);
      if (!response.ok) throw new Error('Could not load older records.');
      const data = await response.json();
      if (id !== generation.current) return;
      setLogs(previous => [...new Map([...data.logs, ...previous].map((log: ScrobbleLog) => [log.id, log])).values()]);
      setHasMore(data.hasMore); setNextBefore(data.nextBefore);
    } catch (e) { setError(e instanceof Error ? e.message : 'History unavailable.'); }
    finally { if (id === generation.current) setLoading(false); }
  }
  const resumeAt = cooldownResumeAt || job.rateLimitResumeAt;
  const seconds = resumeAt ? Math.max(0, Math.ceil((resumeAt - now) / 1000)) : 0;
  const processed = job.scrobblesCompleted + (job.ignoredCount || 0) + (job.simulatedCount || 0);
  const percentage = job.startedAt && job.limit ? Math.min(100, processed / job.limit * 100) : 0;
  const visible = logs.filter(log => log.timestamp > clearedAt && (filter === 'all' || log.level === filter) && (!search || JSON.stringify(log).toLowerCase().includes(search.toLowerCase())));
  return <section className="studio-panel overflow-hidden" aria-label="Activity journal">
    <div className="p-5 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/70">
      <div className="flex items-center gap-3"><div className="panel-icon"><Activity size={18} /></div><div><h2 className="text-sm font-semibold">Activity journal</h2><p className="text-xs text-zinc-500 mt-0.5">Every operation. A persistent, inspectable trail.</p></div></div>
      <div className="flex items-center gap-2">
        <a href="/api/activity/export" className="secondary-button text-xs flex items-center gap-2" title="Export all retained records, not only visible entries"><Download size={14} />Export NDJSON</a>
        <button aria-label="Clear console view without deleting saved activity" className="icon-button" onClick={() => { setClearedAt(Date.now()); onClearLogs(); }}><Trash2 size={15} /></button>
      </div>
    </div>
    <div className="px-5 py-4 bg-zinc-950/30 border-b border-zinc-800/60">
      <div className="flex flex-wrap justify-between gap-2 text-xs mb-3"><span className="text-zinc-400">Current job <span className="text-zinc-200 ml-2">{job.startedAt ? `${job.queueMode === 'single_loop' ? job.track : 'Queue stream'}` : 'No active session'}</span></span><span className="text-zinc-500 tabular-nums">{job.scrobblesCompleted} accepted · {job.ignoredCount || 0} ignored · {job.simulatedCount || 0} simulated</span></div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden" role="progressbar" aria-label="Job progress" aria-valuenow={Math.round(percentage)} aria-valuemin={0} aria-valuemax={100}><div className={`h-full rounded-full transition-all ${seconds ? 'bg-amber-400' : 'bg-red-500'}`} style={{ width: `${percentage}%` }} /></div>
    </div>
    {seconds > 0 && <div role="status" className="p-4 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between gap-3 text-xs text-amber-300"><span className="flex items-center gap-2"><AlertTriangle size={16} />Last.fm cooldown active. New requests are deferred.</span><span className="font-mono shrink-0">{seconds}s remaining</span></div>}
    {job.currentError && <div role="alert" className="px-5 py-3 text-xs text-rose-300 bg-rose-500/10">{job.currentError}</div>}
    <div className="p-4 flex flex-wrap items-center gap-3 border-b border-zinc-800/60">
      <label className="relative flex-1 min-w-40"><Search size={14} className="absolute left-3 top-3 text-zinc-500" /><input aria-label="Search activity records" value={search} onChange={e => { setSearch(e.target.value); setClearedAt(0); }} placeholder="Search events, tracks, methods…" className="w-full pl-9 pr-3 py-2.5 text-xs" /></label>
      <select aria-label="Filter activity severity" value={filter} onChange={e => { setFilter(e.target.value); setClearedAt(0); }} className="py-2.5 px-3 text-xs"><option value="all">All events</option><option value="info">Information</option><option value="success">Success</option><option value="rate_limit">Rate limits</option><option value="warn">Warnings</option><option value="error">Errors</option></select>
      <button className={`icon-button ${autoScroll ? 'text-red-400' : ''}`} aria-label="Follow latest events" aria-pressed={autoScroll} onClick={() => setAutoScroll(!autoScroll)}><ArrowDown size={15} /></button>
    </div>
    {error && <p role="alert" className="p-4 text-xs text-rose-300">{error}</p>}
    <div ref={viewport} className="max-h-[460px] min-h-[280px] overflow-y-auto p-3 space-y-1">
      {(hasMore || clearedAt > 0) && <button className="w-full secondary-button text-xs mb-3" disabled={loading} onClick={() => { setClearedAt(0); if (hasMore) void loadOlder(); }}>{loading ? 'Loading…' : clearedAt ? 'Restore saved history' : 'Load older events'}</button>}
      {visible.length === 0 && <div className="py-16 text-center"><Database size={28} className="mx-auto text-zinc-600 mb-3" /><p className="text-sm text-zinc-300">{loading ? 'Reading the journal…' : 'No events to display'}</p><p className="text-xs text-zinc-500 mt-2">{search || filter !== 'all' ? 'Try another filter or search term.' : 'Connect your account or start a dry run to record activity.'}</p></div>}
      {visible.map(log => {
        const tone = log.level === 'success' ? 'text-emerald-400' : log.level === 'error' ? 'text-rose-400' : log.level === 'rate_limit' || log.level === 'warn' ? 'text-amber-400' : 'text-zinc-500';
        const Icon = log.level === 'success' ? CheckCircle2 : log.level === 'error' ? XCircle : log.level === 'rate_limit' || log.level === 'warn' ? AlertTriangle : Info;
        return <div key={log.id} className="rounded-xl hover:bg-white/[0.025] border border-transparent hover:border-zinc-800/60">
          <button className="w-full text-left flex items-start gap-3 p-3" onClick={() => setExpanded(expanded === log.id ? null : log.id)} aria-expanded={expanded === log.id}>
            <Icon size={15} className={`${tone} shrink-0 mt-0.5`} /><div className="min-w-0 flex-1"><p className="text-xs text-zinc-300 leading-relaxed break-words">{log.message}</p><div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-500 mt-1.5"><time dateTime={new Date(log.timestamp).toISOString()}>{new Date(log.timestamp).toLocaleString()}</time><span>·</span><span>{log.operation || log.category || 'job'}</span>{log.durationMs !== undefined && <span className="font-mono">{log.durationMs}ms</span>}{log.level === 'rate_limit' && <span className="text-amber-400">RATE LIMIT</span>}</div></div><ChevronDown size={13} className="text-zinc-600 shrink-0" />
          </button>
          {expanded === log.id && <dl className="ml-10 mr-3 mb-3 p-3 bg-zinc-950/70 rounded-lg grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">{Object.entries(log).filter(([key]) => !['message', 'timestamp', 'level'].includes(key)).map(([key, value]) => <div key={key} className="min-w-0"><dt className="text-zinc-500">{key}</dt><dd className="text-zinc-300 font-mono break-all">{String(value)}</dd></div>)}</dl>}
        </div>;
      })}
      {loading && <LoaderCircle size={18} className="animate-spin text-zinc-500 mx-auto my-3" />}
    </div>
    <div className="px-5 py-3 border-t border-zinc-800/60 text-[11px] text-zinc-500 flex flex-wrap justify-between gap-2"><span>{visible.length} loaded events · Clear view never deletes history</span><span>Credentials and raw payloads are never journaled</span></div>
  </section>;
};
