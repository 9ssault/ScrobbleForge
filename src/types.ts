export interface LastFmCredentials {
  apiKey: string;
  apiSecret: string;
  username: string;
  password?: string;
  sessionKey?: string;
}

export interface LastFmUser {
  name: string;
  realname?: string;
  playcount: string;
  url: string;
  image?: Array<{ '#text': string; size: string }>;
  country?: string;
}

export interface QueueTrack {
  id: string;
  name: string;
  artist: string;
  album?: string;
  duration?: number;
  image?: string;
  playcount?: string | number;
  rank?: string | number;
}

export interface RecentTrack {
  name: string;
  artist: { '#text'?: string; name?: string };
  album: { '#text'?: string };
  url: string;
  image?: Array<{ '#text': string; size: string }>;
  date?: { uts: string; '#text': string };
  '@attr'?: { nowplaying?: string };
}

export interface ScrobbleLog {
  id: string;
  seq?: number;
  timestamp: number;
  level: 'info' | 'success' | 'warn' | 'error' | 'rate_limit';
  message: string;
  track?: string;
  artist?: string;
  album?: string;
  count?: number;
  total?: number;
  category?: 'api' | 'job' | 'auth' | 'system' | 'player';
  operation?: string;
  jobId?: string;
  requestId?: string;
  outcome?: 'attempt' | 'accepted' | 'ignored' | 'failed' | 'rate_limited' | 'success' | 'simulated' | 'uncertain' | 'deferred' | 'played';
  httpStatus?: number;
  errorCode?: number;
  durationMs?: number;
  retryAfterSeconds?: number;
  accepted?: number;
  ignored?: number;
  attempted?: number;
  scrobbleTimestamp?: number;
}

export interface ActivitySummary {
  totalEvents: number;
  accepted: number;
  ignored: number;
  failedRequests: number;
  rateLimitHits: number;
  requests: number;
  simulated: number;
  played: number;
  uncertainRequests: number;
  retentionDays: number;
  healthy: boolean;
  cooldownResumeAt: number | null;
  oldestAt: number | null;
  latestAt: number | null;
}

// AutoPlayer: real-time local playback simulation. It runs on wall-clock time only,
// needs no credentials and makes no Last.fm API calls, while every completed play is
// journaled locally with category 'player' and outcome 'played'.
export interface PlayerState {
  apiFree: true;
  sessionId: string | null;
  status: 'idle' | 'playing' | 'paused' | 'completed';
  queue: QueueTrack[];
  currentIndex: number;
  activeTrack: QueueTrack | null;
  trackDurationSeconds: number;
  remainingMs: number;
  loopQueue: boolean;
  shuffle: boolean;
  playsCompleted: number;
  trackStartedAt: number | null;
  trackEndsAt: number | null;
  lastPlayAt: number | null;
  startedAt: number | null;
  stoppedReason: string | null;
}

export type NavTab = 'stream' | 'search' | 'harvester' | 'artist' | 'queue' | 'instant' | 'player';

export interface IdleGapInfo {
  lastActiveTime: number;
  idleDurationMs: number;
  idleDurationFormatted: string;
  suggestedTrackCount: number;
  tracks: QueueTrack[];
}

export interface JobState {
  jobId?: string;
  ignoredCount?: number;
  simulatedCount?: number;
  status: 'idle' | 'running' | 'paused' | 'rate_limited' | 'completed' | 'error';
  artist: string;
  track: string;
  album: string;
  limit: number;
  interval: number;
  jitter: boolean;
  isDryRun: boolean;
  mode: 'live' | 'batch_historical';
  queueMode: 'single_loop' | 'queue_once' | 'queue_loop';
  queue: QueueTrack[];
  currentQueueIndex: number;
  scrobblesCompleted: number;
  failedCount: number;
  startedAt: number | null;
  lastScrobbleTime: number | null;
  rateLimitCooldownSeconds: number;
  rateLimitResumeAt: number | null;
  currentError: string | null;
  logs: ScrobbleLog[];
}

