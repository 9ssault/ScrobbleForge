import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';

const ENV_API_KEY = process.env.LASTFM_API_KEY || '';
const ENV_API_SECRET = process.env.LASTFM_API_SECRET || '';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Calculate Last.fm api_sig MD5 signature
function generateLastFmSig(params: Record<string, string>, apiSecret: string): string {
  const sortedKeys = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback' && k !== 'api_sig')
    .sort();

  let sigString = '';
  for (const key of sortedKeys) {
    sigString += key + params[key];
  }
  sigString += apiSecret;

  return crypto.createHash('md5').update(sigString, 'utf8').digest('hex');
}

// Helper to make signed or unsigned Last.fm requests
async function callLastFmApi(
  params: Record<string, string>,
  apiSecret?: string,
  method: 'GET' | 'POST' = 'POST'
) {
  const requestParams: Record<string, string> = { ...params };
  if (apiSecret) {
    requestParams.api_sig = generateLastFmSig(requestParams, apiSecret);
  }
  requestParams.format = 'json';

  const body = new URLSearchParams(requestParams);

  if (method === 'GET') {
    const url = `${LASTFM_API_URL}?${body.toString()}`;
    const res = await fetch(url);
    const data = await res.json();
    return { status: res.status, ok: res.ok, data };
  } else {
    const res = await fetch(LASTFM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'ScrobbleForge/2.0 (web-scrobbler)',
      },
      body: body.toString(),
    });
    const data = await res.json();
    return { status: res.status, ok: res.ok, data };
  }
}

// Background Job State
interface QueueTrack {
  id: string;
  name: string;
  artist: string;
  album?: string;
  duration?: number;
  image?: string;
  playcount?: string | number;
  rank?: string | number;
}

interface ScrobbleLog {
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

interface JobState {
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

let activeJob: JobState = {
  status: 'idle',
  artist: 'rvaia',
  track: 'kill bill',
  album: 'kill bill',
  limit: 1800,
  interval: 2,
  jitter: true,
  isDryRun: false,
  mode: 'live',
  queueMode: 'single_loop',
  queue: [],
  currentQueueIndex: 0,
  scrobblesCompleted: 0,
  failedCount: 0,
  startedAt: null,
  lastScrobbleTime: null,
  rateLimitCooldownSeconds: 0,
  rateLimitResumeAt: null,
  currentError: null,
  logs: [],
};

// Store clients for SSE real-time notifications
const sseClients: Response[] = [];

function emitSSE(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(payload);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

function addLog(
  level: ScrobbleLog['level'],
  message: string,
  extra?: Partial<ScrobbleLog>
) {
  const log: ScrobbleLog = {
    id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: Date.now(),
    level,
    message,
    ...extra,
  };
  activeJob.logs.push(log);
  if (activeJob.logs.length > 500) {
    activeJob.logs.shift(); // retain last 500 logs
  }
  emitSSE('log', log);
  emitSSE('status', getJobStatusPayload());
}

function getJobStatusPayload() {
  return {
    ...activeJob,
    logs: activeJob.logs.slice(-50), // last 50 for quick updates
  };
}

let jobTimeoutHandle: NodeJS.Timeout | null = null;

// Credentials cached for background worker
let workerCredentials: {
  apiKey: string;
  apiSecret: string;
  sessionKey: string;
  username: string;
} | null = null;

async function executeScrobbleStep() {
  if (activeJob.status !== 'running') return;

  const isQueueMode = activeJob.queue.length > 0 && activeJob.queueMode !== 'single_loop';

  // Check completion limit
  if (activeJob.scrobblesCompleted >= activeJob.limit) {
    activeJob.status = 'completed';
    addLog(
      'success',
      `🎉 Target limit reached! Successfully scrobbled ${activeJob.scrobblesCompleted}/${activeJob.limit} tracks.`
    );
    emitSSE('completed', getJobStatusPayload());
    return;
  }

  // Check if queue_once completed
  if (isQueueMode && activeJob.queueMode === 'queue_once' && activeJob.currentQueueIndex >= activeJob.queue.length) {
    activeJob.status = 'completed';
    addLog(
      'success',
      `🎉 Full queue completed! Finished all ${activeJob.queue.length} tracks.`
    );
    emitSSE('completed', getJobStatusPayload());
    return;
  }

  let currentArtist = activeJob.artist;
  let currentTrackName = activeJob.track;
  let currentAlbum = activeJob.album;

  if (isQueueMode) {
    const trackItem = activeJob.queue[activeJob.currentQueueIndex];
    if (trackItem) {
      currentArtist = trackItem.artist;
      currentTrackName = trackItem.name;
      currentAlbum = trackItem.album || '';
    }
  }

  const currentCount = activeJob.scrobblesCompleted + 1;
  const targetLimit = activeJob.limit;

  // Handle dry-run mode
  if (activeJob.isDryRun) {
    activeJob.scrobblesCompleted = currentCount;
    activeJob.lastScrobbleTime = Date.now();
    addLog(
      'info',
      `[DRY RUN] Simulated scrobble for "${currentTrackName}" by ${currentArtist} (${currentCount}/${targetLimit})`,
      { artist: currentArtist, track: currentTrackName, album: currentAlbum, count: currentCount, total: targetLimit }
    );
    advanceQueueIndex();
    scheduleNextStep();
    return;
  }

  if (!workerCredentials || !workerCredentials.sessionKey) {
    activeJob.status = 'error';
    activeJob.currentError = 'Missing Last.fm authentication session.';
    addLog('error', 'Authentication failed: No valid Last.fm session key.');
    return;
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      method: 'track.scrobble',
      api_key: workerCredentials.apiKey,
      sk: workerCredentials.sessionKey,
      'artist[0]': currentArtist,
      'track[0]': currentTrackName,
      'timestamp[0]': timestamp.toString(),
    };
    if (currentAlbum) {
      params['album[0]'] = currentAlbum;
    }

    const response = await callLastFmApi(
      params,
      workerCredentials.apiSecret,
      'POST'
    );

    if (response.data && response.data.error) {
      const errorCode = response.data.error;
      const errorMsg = response.data.message || 'Unknown Last.fm error';

      if (errorCode === 26) {
        // Last.fm Rate Limit Exceeded: Wait 60 seconds (just like python script)
        activeJob.status = 'rate_limited';
        activeJob.rateLimitCooldownSeconds = 60;
        activeJob.rateLimitResumeAt = Date.now() + 60000;
        addLog(
          'rate_limit',
          `⚠️ Rate limit reached (Code 26: ${errorMsg}). Cooling down for 60 seconds...`
        );

        jobTimeoutHandle = setTimeout(() => {
          if (activeJob.status === 'rate_limited') {
            activeJob.status = 'running';
            activeJob.rateLimitCooldownSeconds = 0;
            activeJob.rateLimitResumeAt = null;
            addLog('info', '✅ Cooldown completed. Resuming scrobble stream...');
            executeScrobbleStep();
          }
        }, 60000);
        return;
      } else {
        // Other API errors
        activeJob.failedCount += 1;
        addLog('error', `Last.fm WSError [Code ${errorCode}]: ${errorMsg}`);
        activeJob.status = 'error';
        activeJob.currentError = `WSError: ${errorMsg} (Code ${errorCode})`;
        return;
      }
    }

    // Success!
    activeJob.scrobblesCompleted = currentCount;
    activeJob.lastScrobbleTime = Date.now();
    addLog(
      'success',
      `Scrobbled "${currentTrackName}" by ${currentArtist} (${currentCount}/${targetLimit})`,
      { artist: currentArtist, track: currentTrackName, album: currentAlbum, count: currentCount, total: targetLimit }
    );

    advanceQueueIndex();
    scheduleNextStep();
  } catch (err: any) {
    activeJob.failedCount += 1;
    const errorMsg = err?.message || 'Network error';
    addLog(
      'warn',
      `Network glitch: ${errorMsg}. Backing off for 10s before retry...`
    );
    jobTimeoutHandle = setTimeout(() => {
      if (activeJob.status === 'running') {
        executeScrobbleStep();
      }
    }, 10000);
  }
}

function advanceQueueIndex() {
  if (activeJob.queue.length > 0 && activeJob.queueMode !== 'single_loop') {
    activeJob.currentQueueIndex += 1;
    if (activeJob.currentQueueIndex >= activeJob.queue.length) {
      if (activeJob.queueMode === 'queue_loop') {
        activeJob.currentQueueIndex = 0; // wrap around
      }
    }
  }
}

function scheduleNextStep() {
  if (activeJob.status !== 'running') return;

  let delay = activeJob.interval * 1000;
  if (activeJob.jitter) {
    // Add jitter between -500ms and +500ms, ensuring delay is at least 500ms
    const jitterMs = (Math.random() - 0.5) * 1000;
    delay = Math.max(500, delay + jitterMs);
  }

  jobTimeoutHandle = setTimeout(() => {
    executeScrobbleStep();
  }, delay);
}

// API Routes

// SSE endpoint
app.get('/api/job/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);
  res.write(`event: status\ndata: ${JSON.stringify(getJobStatusPayload())}\n\n`);

  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// Server config status endpoint (safe: does not reveal secret)
app.get('/api/lastfm/server-config', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    hasServerApiKey: Boolean(ENV_API_KEY),
    serverApiKey: ENV_API_KEY || null,
  });
});

// Authenticate with Last.fm
app.post('/api/lastfm/auth', async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret, username, password, sessionKey } = req.body;
    const resolvedApiKey = (apiKey || ENV_API_KEY || '').trim();
    const resolvedApiSecret = (apiSecret || ENV_API_SECRET || '').trim();

    if (!resolvedApiKey || !resolvedApiSecret) {
      return res
        .status(400)
        .json({ ok: false, error: 'API Key and API Secret are required.' });
    }

    if (sessionKey && username) {
      const userInfo = await callLastFmApi(
        { method: 'user.getInfo', user: username, api_key: resolvedApiKey },
        undefined,
        'GET'
      );
      if (userInfo.data && userInfo.data.user) {
        workerCredentials = {
          apiKey: resolvedApiKey,
          apiSecret: resolvedApiSecret,
          sessionKey,
          username,
        };
        return res.json({
          ok: true,
          sessionKey,
          username,
          user: userInfo.data.user,
        });
      }
    }

    if (!username || !password) {
      return res
        .status(400)
        .json({ ok: false, error: 'Username and password are required.' });
    }

    const params = {
      method: 'auth.getMobileSession',
      username,
      password,
      api_key: resolvedApiKey,
    };

    const authRes = await callLastFmApi(params, resolvedApiSecret, 'POST');

    if (authRes.data && authRes.data.session) {
      const key = authRes.data.session.key;
      const userName = authRes.data.session.name;

      let userProfile = null;
      try {
        const infoRes = await callLastFmApi(
          { method: 'user.getInfo', user: userName, api_key: apiKey },
          undefined,
          'GET'
        );
        if (infoRes.data && infoRes.data.user) {
          userProfile = infoRes.data.user;
        }
      } catch (e) {}

      workerCredentials = {
        apiKey,
        apiSecret,
        sessionKey: key,
        username: userName,
      };

      return res.json({
        ok: true,
        sessionKey: key,
        username: userName,
        user: userProfile,
      });
    }

    return res.status(400).json({
      ok: false,
      error:
        authRes.data?.message ||
        'Authentication failed. Please verify credentials.',
      errorCode: authRes.data?.error,
    });
  } catch (err: any) {
    return res
      .status(500)
      .json({ ok: false, error: err.message || 'Internal server error' });
  }
});

// Get User Profile & Total Scrobbles
app.get('/api/lastfm/user-info', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.query.apiKey as string) || workerCredentials?.apiKey;
    const username =
      (req.query.username as string) || workerCredentials?.username;

    if (!apiKey || !username) {
      return res
        .status(400)
        .json({ ok: false, error: 'API Key and username required' });
    }

    const response = await callLastFmApi(
      { method: 'user.getInfo', user: username, api_key: apiKey },
      undefined,
      'GET'
    );

    if (response.data && response.data.user) {
      return res.json({ ok: true, user: response.data.user });
    }

    return res.status(400).json({
      ok: false,
      error: response.data?.message || 'Could not fetch user info',
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Get Live Recent Tracks from Last.fm
app.get('/api/lastfm/recent-tracks', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.query.apiKey as string) || workerCredentials?.apiKey;
    const username =
      (req.query.username as string) || workerCredentials?.username;
    const limit = (req.query.limit as string) || '15';

    if (!apiKey || !username) {
      return res
        .status(400)
        .json({ ok: false, error: 'API Key and username required' });
    }

    const response = await callLastFmApi(
      {
        method: 'user.getRecentTracks',
        user: username,
        limit,
        api_key: apiKey,
        extended: '1',
      },
      undefined,
      'GET'
    );

    if (response.data && response.data.recenttracks) {
      return res.json({
        ok: true,
        recentTracks: response.data.recenttracks.track || [],
        total: response.data.recenttracks['@attr']?.total || 0,
      });
    }

    return res.status(400).json({
      ok: false,
      error: response.data?.message || 'Could not fetch recent tracks',
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// PROFILE HARVESTER: Fetch recent, top, or loved tracks from ANY user profile with multi-page crawling
app.get('/api/lastfm/fetch-profile-tracks', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.query.apiKey as string) || workerCredentials?.apiKey;
    const username = (req.query.username as string) || workerCredentials?.username;
    const type = (req.query.type as string) || 'recents'; // 'recents' | 'top' | 'loved'
    const period = (req.query.period as string) || 'overall'; // 'overall' | '7day' | '1month' | '3month' | '6month' | '12month'
    const limitPerPage = Math.min(200, Math.max(10, parseInt(req.query.limit as string, 10) || 50));
    const pagesToFetch = Math.min(10, Math.max(1, parseInt(req.query.pages as string, 10) || 1));

    if (!apiKey || !username) {
      return res.status(400).json({ ok: false, error: 'API key and username are required.' });
    }

    const collectedTracks: QueueTrack[] = [];
    let method = 'user.getRecentTracks';
    if (type === 'top') method = 'user.getTopTracks';
    if (type === 'loved') method = 'user.getLovedTracks';

    for (let p = 1; p <= pagesToFetch; p++) {
      const params: Record<string, string> = {
        method,
        user: username,
        limit: limitPerPage.toString(),
        page: p.toString(),
        api_key: apiKey,
      };
      if (type === 'top') {
        params.period = period;
      }
      if (type === 'recents') {
        params.extended = '1';
      }

      const response = await callLastFmApi(params, undefined, 'GET');

      if (response.data && !response.data.error) {
        let rawList: any[] = [];
        if (type === 'recents' && response.data.recenttracks?.track) {
          rawList = Array.isArray(response.data.recenttracks.track)
            ? response.data.recenttracks.track
            : [response.data.recenttracks.track];
        } else if (type === 'top' && response.data.toptracks?.track) {
          rawList = Array.isArray(response.data.toptracks.track)
            ? response.data.toptracks.track
            : [response.data.toptracks.track];
        } else if (type === 'loved' && response.data.lovedtracks?.track) {
          rawList = Array.isArray(response.data.lovedtracks.track)
            ? response.data.lovedtracks.track
            : [response.data.lovedtracks.track];
        }

        for (const item of rawList) {
          // Skip currently playing placeholder in recents if it has no UTS timestamp or handle gracefully
          const trackName = item.name;
          const artistName = item.artist?.name || item.artist?.['#text'] || (typeof item.artist === 'string' ? item.artist : 'Unknown');
          const albumName = item.album?.['#text'] || item.album?.title || '';
          const imageUrl = item.image?.[2]?.['#text'] || item.image?.[1]?.['#text'] || '';
          const duration = parseInt(item.duration, 10) || 180;

          if (trackName && artistName) {
            collectedTracks.push({
              id: `${artistName}-${trackName}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
              name: trackName,
              artist: artistName,
              album: albumName,
              duration,
              image: imageUrl,
              playcount: item.playcount,
              rank: item['@attr']?.rank,
            });
          }
        }

        // If fewer tracks returned than requested, we reached the end of the user's history
        if (rawList.length < limitPerPage) break;
      } else {
        break;
      }
    }

    return res.json({
      ok: true,
      username,
      type,
      totalFetched: collectedTracks.length,
      tracks: collectedTracks,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ARTIST DISCOGRAPHY: Fetch artist top tracks
app.get('/api/lastfm/fetch-artist-tracks', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.query.apiKey as string) || workerCredentials?.apiKey;
    const artist = req.query.artist as string;
    const limit = Math.min(200, Math.max(5, parseInt(req.query.limit as string, 10) || 50));

    if (!apiKey || !artist) {
      return res.status(400).json({ ok: false, error: 'API key and artist are required.' });
    }

    const response = await callLastFmApi(
      {
        method: 'artist.getTopTracks',
        artist,
        limit: limit.toString(),
        api_key: apiKey,
      },
      undefined,
      'GET'
    );

    if (response.data && response.data.toptracks?.track) {
      const raw = Array.isArray(response.data.toptracks.track)
        ? response.data.toptracks.track
        : [response.data.toptracks.track];

      const tracks: QueueTrack[] = raw.map((item: any) => ({
        id: `${item.name}-${Math.random().toString(36).substr(2, 5)}`,
        name: item.name,
        artist: item.artist?.name || artist,
        album: '',
        duration: parseInt(item.duration, 10) || 180,
        image: item.image?.[2]?.['#text'] || item.image?.[1]?.['#text'] || '',
        playcount: item.playcount,
        rank: item['@attr']?.rank,
      }));

      return res.json({ ok: true, artist, tracks });
    }

    return res.status(400).json({
      ok: false,
      error: response.data?.message || 'Could not fetch artist tracks',
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ARTIST ALBUMS: Fetch artist top albums
app.get('/api/lastfm/fetch-artist-albums', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.query.apiKey as string) || workerCredentials?.apiKey;
    const artist = req.query.artist as string;
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit as string, 10) || 30));

    if (!apiKey || !artist) {
      return res.status(400).json({ ok: false, error: 'API key and artist are required.' });
    }

    const response = await callLastFmApi(
      {
        method: 'artist.getTopAlbums',
        artist,
        limit: limit.toString(),
        api_key: apiKey,
      },
      undefined,
      'GET'
    );

    if (response.data && response.data.topalbums?.album) {
      const raw = Array.isArray(response.data.topalbums.album)
        ? response.data.topalbums.album
        : [response.data.topalbums.album];

      const albums = raw.map((item: any) => ({
        name: item.name,
        artist: item.artist?.name || artist,
        playcount: item.playcount,
        image: item.image?.[2]?.['#text'] || item.image?.[1]?.['#text'] || '',
        url: item.url,
      }));

      return res.json({ ok: true, artist, albums });
    }

    return res.status(400).json({
      ok: false,
      error: response.data?.message || 'Could not fetch artist albums',
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ALBUM TRACKLIST: Fetch full tracklist for an album
app.get('/api/lastfm/fetch-album-tracks', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.query.apiKey as string) || workerCredentials?.apiKey;
    const artist = req.query.artist as string;
    const album = req.query.album as string;

    if (!apiKey || !artist || !album) {
      return res.status(400).json({ ok: false, error: 'API key, artist, and album are required.' });
    }

    const response = await callLastFmApi(
      {
        method: 'album.getInfo',
        artist,
        album,
        api_key: apiKey,
      },
      undefined,
      'GET'
    );

    if (response.data && response.data.album) {
      const albumData = response.data.album;
      const albumArt = albumData.image?.[3]?.['#text'] || albumData.image?.[2]?.['#text'] || '';
      const rawTracks = albumData.tracks?.track || [];
      const trackList = Array.isArray(rawTracks) ? rawTracks : [rawTracks];

      const tracks: QueueTrack[] = trackList.map((t: any, idx: number) => ({
        id: `${t.name}-${idx}-${Math.random().toString(36).substr(2, 5)}`,
        name: t.name,
        artist: t.artist?.name || artist,
        album: albumData.name,
        duration: parseInt(t.duration, 10) || 200,
        image: albumArt,
        rank: t['@attr']?.rank || idx + 1,
      }));

      return res.json({
        ok: true,
        artist: albumData.artist,
        album: albumData.name,
        image: albumArt,
        tracks,
        totalTracks: tracks.length,
      });
    }

    return res.status(400).json({
      ok: false,
      error: response.data?.message || 'Could not fetch album tracklist',
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Search tracks on Last.fm
app.get('/api/lastfm/search', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.query.apiKey as string) || workerCredentials?.apiKey;
    const track = req.query.track as string;
    const artist = req.query.artist as string;

    if (!apiKey || (!track && !artist)) {
      return res.status(400).json({ ok: false, error: 'Search term required' });
    }

    const response = await callLastFmApi(
      {
        method: 'track.search',
        track: track || artist,
        artist: artist || '',
        limit: '8',
        api_key: apiKey,
      },
      undefined,
      'GET'
    );

    if (response.data && response.data.results) {
      return res.json({
        ok: true,
        tracks: response.data.results.trackmatches?.track || [],
      });
    }

    return res.status(400).json({ ok: false, error: 'No results found' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Search artists on Last.fm
app.get('/api/lastfm/search-artist', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.query.apiKey as string) || workerCredentials?.apiKey || ENV_API_KEY;
    const query = req.query.query as string;
    const limit = (req.query.limit as string) || '12';

    if (!apiKey || !query) {
      return res.status(400).json({ ok: false, error: 'Artist search query required' });
    }

    const response = await callLastFmApi(
      {
        method: 'artist.search',
        artist: query,
        limit,
        api_key: apiKey,
      },
      undefined,
      'GET'
    );

    if (response.data && response.data.results?.artistmatches?.artist) {
      const raw = Array.isArray(response.data.results.artistmatches.artist)
        ? response.data.results.artistmatches.artist
        : [response.data.results.artistmatches.artist];

      const artists = raw.map((a: any) => ({
        name: a.name,
        listeners: a.listeners,
        image: a.image?.[2]?.['#text'] || a.image?.[1]?.['#text'] || '',
        url: a.url,
      }));

      return res.json({ ok: true, artists });
    }

    return res.status(400).json({ ok: false, error: 'No artists found' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Search albums on Last.fm
app.get('/api/lastfm/search-album', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.query.apiKey as string) || workerCredentials?.apiKey || ENV_API_KEY;
    const query = req.query.query as string;
    const limit = (req.query.limit as string) || '12';

    if (!apiKey || !query) {
      return res.status(400).json({ ok: false, error: 'Album search query required' });
    }

    const response = await callLastFmApi(
      {
        method: 'album.search',
        album: query,
        limit,
        api_key: apiKey,
      },
      undefined,
      'GET'
    );

    if (response.data && response.data.results?.albummatches?.album) {
      const raw = Array.isArray(response.data.results.albummatches.album)
        ? response.data.results.albummatches.album
        : [response.data.results.albummatches.album];

      const albums = raw.map((a: any) => ({
        name: a.name,
        artist: a.artist,
        image: a.image?.[2]?.['#text'] || a.image?.[1]?.['#text'] || '',
        url: a.url,
      }));

      return res.json({ ok: true, albums });
    }

    return res.status(400).json({ ok: false, error: 'No albums found' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Search user profile on Last.fm
app.get('/api/lastfm/search-user', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.query.apiKey as string) || workerCredentials?.apiKey || ENV_API_KEY;
    const username = req.query.username as string;

    if (!apiKey || !username) {
      return res.status(400).json({ ok: false, error: 'Username required' });
    }

    const [userInfoRes, recentRes] = await Promise.all([
      callLastFmApi({ method: 'user.getInfo', user: username, api_key: apiKey }, undefined, 'GET'),
      callLastFmApi(
        { method: 'user.getRecentTracks', user: username, limit: '10', api_key: apiKey, extended: '1' },
        undefined,
        'GET'
      ),
    ]);

    if (userInfoRes.data && userInfoRes.data.user) {
      const user = userInfoRes.data.user;
      const recentTracks = recentRes.data?.recenttracks?.track || [];
      return res.json({
        ok: true,
        user,
        recentTracks: Array.isArray(recentTracks) ? recentTracks : [recentTracks],
      });
    }

    return res.status(404).json({ ok: false, error: 'Last.fm user not found' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Update Now Playing
app.post('/api/lastfm/now-playing', async (req: Request, res: Response) => {
  try {
    const { artist, track, album, apiKey, apiSecret, sessionKey } = req.body;
    const resolvedApiKey = apiKey || workerCredentials?.apiKey;
    const resolvedSecret = apiSecret || workerCredentials?.apiSecret;
    const resolvedSession = sessionKey || workerCredentials?.sessionKey;

    if (!resolvedApiKey || !resolvedSecret || !resolvedSession) {
      return res
        .status(400)
        .json({ ok: false, error: 'Missing Last.fm authentication credentials' });
    }

    const params: Record<string, string> = {
      method: 'track.updateNowPlaying',
      artist,
      track,
      api_key: resolvedApiKey,
      sk: resolvedSession,
    };
    if (album) params.album = album;

    const response = await callLastFmApi(params, resolvedSecret, 'POST');
    return res.json({ ok: true, data: response.data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Instant Single Scrobble
app.post('/api/lastfm/single-scrobble', async (req: Request, res: Response) => {
  try {
    const { artist, track, album, apiKey, apiSecret, sessionKey, timestamp } =
      req.body;
    const resolvedApiKey = apiKey || workerCredentials?.apiKey;
    const resolvedSecret = apiSecret || workerCredentials?.apiSecret;
    const resolvedSession = sessionKey || workerCredentials?.sessionKey;

    if (!resolvedApiKey || !resolvedSecret || !resolvedSession) {
      return res
        .status(400)
        .json({ ok: false, error: 'Missing Last.fm authentication credentials' });
    }

    const ts = timestamp || Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      method: 'track.scrobble',
      api_key: resolvedApiKey,
      sk: resolvedSession,
      'artist[0]': artist,
      'track[0]': track,
      'timestamp[0]': ts.toString(),
    };
    if (album) params['album[0]'] = album;

    const response = await callLastFmApi(params, resolvedSecret, 'POST');
    if (response.data && response.data.error) {
      return res.status(400).json({ ok: false, error: response.data.message });
    }

    return res.json({ ok: true, data: response.data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// BATCH SCROBBLE ALL: Takes an array of tracks and submits them in chunks of 50
app.post('/api/job/batch-scrobble-all', async (req: Request, res: Response) => {
  try {
    const {
      tracks,
      spanHours,
      startTime,
      endTime,
      apiKey,
      apiSecret,
      sessionKey,
    } = req.body;

    const resolvedApiKey = apiKey || workerCredentials?.apiKey;
    const resolvedSecret = apiSecret || workerCredentials?.apiSecret;
    const resolvedSession = sessionKey || workerCredentials?.sessionKey;

    if (!resolvedApiKey || !resolvedSecret || !resolvedSession) {
      return res.status(400).json({ ok: false, error: 'Missing Last.fm credentials' });
    }

    if (!Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ ok: false, error: 'No tracks provided for batch scrobbling.' });
    }

    const totalToScrobble = tracks.length;
    const now = Math.floor(Date.now() / 1000);
    const resolvedEnd = endTime ? Math.min(now, Math.floor(endTime)) : now;
    const resolvedStart = startTime
      ? Math.floor(startTime)
      : resolvedEnd - Math.max(60, (spanHours || 24) * 3600);

    const spanDuration = Math.max(60, resolvedEnd - resolvedStart);
    const stepSeconds = Math.max(20, Math.floor(spanDuration / totalToScrobble));

    let completed = 0;
    const batchSize = 50;

    addLog(
      'info',
      `🚀 Commencing batch scrobble: ${totalToScrobble} tracks distributed across time range (${new Date(
        resolvedStart * 1000
      ).toLocaleTimeString()} to ${new Date(resolvedEnd * 1000).toLocaleTimeString()}).`
    );

    for (let i = 0; i < totalToScrobble; i += batchSize) {
      const currentChunk = tracks.slice(i, i + batchSize);
      const params: Record<string, string> = {
        method: 'track.scrobble',
        api_key: resolvedApiKey,
        sk: resolvedSession,
      };

      currentChunk.forEach((t, idx) => {
        const itemGlobalIndex = i + idx;
        const itemTimestamp = resolvedStart + itemGlobalIndex * stepSeconds;
        params[`artist[${idx}]`] = t.artist;
        params[`track[${idx}]`] = t.name;
        params[`timestamp[${idx}]`] = itemTimestamp.toString();
        if (t.album) {
          params[`album[${idx}]`] = t.album;
        }
      });

      const response = await callLastFmApi(params, resolvedSecret, 'POST');

      if (response.data && response.data.error) {
        addLog(
          'error',
          `Batch chunk error: ${response.data.message} (code ${response.data.error})`
        );
        return res.status(400).json({
          ok: false,
          error: response.data.message,
          completed,
        });
      }

      completed += currentChunk.length;
      addLog(
        'success',
        `Batch payload accepted: +${currentChunk.length} tracks scrobbled (${completed}/${totalToScrobble})`
      );

      // Brief delay between 50-track batches to respect Last.fm rate limits
      if (i + batchSize < totalToScrobble) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    addLog('success', `🎉 Batch scrobble complete! Total ${completed} songs added to Last.fm.`);
    return res.json({ ok: true, completed });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// START BACKGROUND STREAMING JOB (Single or Queue)
app.post('/api/job/start', (req: Request, res: Response) => {
  const {
    artist,
    track,
    album,
    limit,
    interval,
    jitter,
    isDryRun,
    queue,
    queueMode,
    credentials,
  } = req.body;

  if (activeJob.status === 'running') {
    return res
      .status(400)
      .json({ ok: false, error: 'A scrobble job is already running.' });
  }

  if (credentials) {
    workerCredentials = credentials;
  }

  if (!isDryRun && (!workerCredentials || !workerCredentials.sessionKey)) {
    return res.status(400).json({
      ok: false,
      error: 'Please connect Last.fm credentials before starting live scrobbles.',
    });
  }

  if (jobTimeoutHandle) {
    clearTimeout(jobTimeoutHandle);
    jobTimeoutHandle = null;
  }

  const resolvedQueue: QueueTrack[] = Array.isArray(queue) ? queue : [];
  const resolvedQueueMode = queueMode || (resolvedQueue.length > 0 ? 'queue_once' : 'single_loop');
  const resolvedLimit = resolvedQueueMode === 'queue_once'
    ? resolvedQueue.length
    : Math.max(1, parseInt(limit, 10) || 1800);

  activeJob = {
    status: 'running',
    artist: (artist || 'rvaia').trim(),
    track: (track || 'kill bill').trim(),
    album: (album || 'kill bill').trim(),
    limit: resolvedLimit,
    interval: Math.max(0.5, parseFloat(interval) || 2),
    jitter: jitter !== false,
    isDryRun: Boolean(isDryRun),
    mode: 'live',
    queueMode: resolvedQueueMode,
    queue: resolvedQueue,
    currentQueueIndex: 0,
    scrobblesCompleted: 0,
    failedCount: 0,
    startedAt: Date.now(),
    lastScrobbleTime: null,
    rateLimitCooldownSeconds: 0,
    rateLimitResumeAt: null,
    currentError: null,
    logs: [],
  };

  const modeDescription = resolvedQueueMode === 'queue_once'
    ? `Queue Mode (${resolvedQueue.length} tracks once)`
    : resolvedQueueMode === 'queue_loop'
    ? `Queue Loop Mode (${resolvedQueue.length} tracks looped up to ${activeJob.limit})`
    : `Single Track Loop ("${activeJob.track}" by ${activeJob.artist})`;

  addLog(
    'info',
    `✨ Scrobble stream initiated: ${modeDescription} [Interval: ${activeJob.interval}s, Jitter: ${activeJob.jitter ? 'ON' : 'OFF'}${activeJob.isDryRun ? ', DRY RUN' : ''}]`
  );

  executeScrobbleStep();
  return res.json({ ok: true, job: getJobStatusPayload() });
});

// Pause Job
app.post('/api/job/pause', (_req: Request, res: Response) => {
  if (activeJob.status === 'running' || activeJob.status === 'rate_limited') {
    if (jobTimeoutHandle) {
      clearTimeout(jobTimeoutHandle);
      jobTimeoutHandle = null;
    }
    activeJob.status = 'paused';
    addLog('warn', '⏸️ Job paused by user.');
    return res.json({ ok: true, job: getJobStatusPayload() });
  }
  return res
    .status(400)
    .json({ ok: false, error: 'Job is not running or active.' });
});

// Resume Job
app.post('/api/job/resume', (_req: Request, res: Response) => {
  if (activeJob.status === 'paused') {
    activeJob.status = 'running';
    addLog('info', '▶️ Job resumed.');
    executeScrobbleStep();
    return res.json({ ok: true, job: getJobStatusPayload() });
  }
  return res.status(400).json({ ok: false, error: 'Job is not paused.' });
});

// Stop / Reset Job
app.post('/api/job/stop', (_req: Request, res: Response) => {
  if (jobTimeoutHandle) {
    clearTimeout(jobTimeoutHandle);
    jobTimeoutHandle = null;
  }
  activeJob.status = 'idle';
  addLog(
    'info',
    `⏹️ Job terminated. Completed ${activeJob.scrobblesCompleted}/${activeJob.limit} scrobbles.`
  );
  return res.json({ ok: true, job: getJobStatusPayload() });
});

// Get Status
app.get('/api/job/status', (_req: Request, res: Response) => {
  return res.json({ ok: true, job: getJobStatusPayload() });
});

// Clear Logs
app.post('/api/job/clear-logs', (_req: Request, res: Response) => {
  activeJob.logs = [];
  emitSSE('status', getJobStatusPayload());
  return res.json({ ok: true });
});

// Gemini AI Chatbot Endpoint
app.post('/api/gemini/chat', async (req: Request, res: Response) => {
  try {
    const { messages, model, role, context } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: 'GEMINI_API_KEY is not configured in the server environment.',
      });
    }

    const ai = new GoogleGenAI({});
    const selectedModel = model || 'gemini-3.5-flash';

    let systemInstruction = `You are ScrobbleAI, an expert musicologist, playlist curator, and Last.fm scrobbler assistant embedded in ScrobbleForge.
Your mission is to help users discover music, explore deep discographies, build playlist queues to scrobble, and analyze listening habits.
When recommending songs, format them clearly as "Artist - Title" (and optional Album).
Whenever you suggest specific tracks, also include a structured JSON block at the very end of your response formatted exactly as:
\`\`\`tracks
[
  {"artist": "Artist Name", "name": "Song Title", "album": "Album Name"}
]
\`\`\`
This enables the ScrobbleForge UI to render instant 1-click "Add to Queue" or "Scrobble Now" buttons for your recommended songs!
Keep your tone passionate, insightful, and knowledgeable about music genres, history, and Last.fm culture.`;

    if (role === 'analyst') {
      systemInstruction += `\nRole: Deep Music Analyst. Focus on detailed discography breakdowns, sonic aesthetics, genre evolution, and track sequencing.`;
    } else if (role === 'fast_recommender') {
      systemInstruction += `\nRole: Fast Recommender. Keep answers punchy, rapid, and direct with instant song ideas.`;
    }

    if (context) {
      systemInstruction += `\nCurrent User Context:\n${JSON.stringify(context, null, 2)}`;
    }

    const contents = (messages || []).map((m: any) => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.text || m.content || '' }],
    }));

    const response = await ai.models.generateContent({
      model: selectedModel,
      contents,
      config: {
        systemInstruction,
      },
    });

    const replyText = response.text || '';

    let suggestedTracks: Array<{ artist: string; name: string; album?: string }> = [];
    const tracksBlockMatch = replyText.match(/```tracks\s*([\s\S]*?)\s*```/);
    if (tracksBlockMatch && tracksBlockMatch[1]) {
      try {
        suggestedTracks = JSON.parse(tracksBlockMatch[1]);
      } catch {}
    }

    const cleanText = replyText.replace(/```tracks\s*[\s\S]*?\s*```/, '').trim();

    return res.json({
      ok: true,
      text: cleanText,
      rawText: replyText,
      suggestedTracks,
      modelUsed: selectedModel,
    });
  } catch (err: any) {
    console.error('Gemini Chat error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Failed to generate response from Gemini',
    });
  }
});

// Start Express and integrate Vite in development or static serve in production
async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ScrobbleForge] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[ScrobbleForge] Failed to start server:', err);
  process.exit(1);
});
