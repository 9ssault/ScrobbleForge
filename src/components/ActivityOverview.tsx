import React from 'react';
import { Check, ShieldCheck, AlertTriangle, Ban, ArrowUpRight, Database, Activity } from 'lucide-react';
import type { ActivitySummary, JobState } from '../types';

export function ActivityOverview({ summary, job, connection }: { summary: ActivitySummary | null; job: JobState; connection: string }) {
  const cards = [
    { label: 'Accepted scrobbles', value: summary?.accepted, icon: Check, tone: 'text-emerald-400', hint: 'Confirmed by Last.fm' },
    { label: 'Ignored tracks', value: summary?.ignored, icon: Ban, tone: 'text-zinc-400', hint: 'Not added to your profile' },
    { label: 'Failed requests', value: summary?.failedRequests, icon: AlertTriangle, tone: 'text-rose-400', hint: 'Inspect the activity journal' },
    { label: 'Rate-limit hits', value: summary?.rateLimitHits, icon: ShieldCheck, tone: 'text-amber-400', hint: 'Recorded across all operations' },
  ];
  return <section aria-label="Activity overview" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-2 text-zinc-400"><span className={`status-dot ${connection === 'live' ? 'bg-emerald-400' : 'bg-amber-400'}`} /><span className="capitalize">{connection === 'live' ? 'Live updates connected' : connection === 'connecting' ? 'Connecting to engine' : 'Reconnecting to engine'}</span></div>
      <div className="flex items-center gap-2 text-zinc-400"><Database size={13} /><span>{summary ? `${summary.retentionDays}-day persistent journal` : 'Journal status unavailable'}</span><span className="text-zinc-700">/</span><Activity size={13} /><span className="capitalize">Engine {job.status.replace('_', ' ')}</span></div>
    </div>
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      {cards.map(({ label, value, icon: Icon, tone, hint }) => <div key={label} className="metric-card">
        <div className="flex items-center justify-between gap-2"><span className="text-xs text-zinc-400">{label}</span><Icon size={16} className={tone} /></div>
        <div className="mt-4 mb-2 text-3xl sm:text-4xl font-semibold tracking-tight tabular-nums">{value === undefined ? '—' : Number(value || 0).toLocaleString()}</div>
        <p className="text-[11px] text-zinc-500 flex items-center gap-1"><ArrowUpRight size={12} className={tone} />{hint}</p>
      </div>)}
    </div>
    <p className="text-[11px] text-zinc-500">Totals cover retained activity, including instant and batch submissions. Simulations are excluded.{Boolean(summary?.uncertainRequests) && <span className="text-amber-400"> {summary?.uncertainRequests} submissions have uncertain outcomes—review history before retrying.</span>}</p>
  </section>;
}
