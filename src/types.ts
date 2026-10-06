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
  timestamp: number;
  level: 'info' | 'success' | 'warn' | 'error' | 'rate_limit';
  message: string;
  track?: string;
  artist?: string;
  album?: string;
  count?: number;
  total?: number;
}

export interface IdleGapInfo {
  lastActiveTime: number;
  idleDurationMs: number;
  idleDurationFormatted: string;
  suggestedTrackCount: number;
  tracks: QueueTrack[];
}

export interface JobState {
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

