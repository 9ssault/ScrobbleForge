// server.ts
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
dotenv.config();
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var app = express();
var PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3e3;
var LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
var ENV_API_KEY = process.env.LASTFM_API_KEY || "";
var ENV_API_SECRET = process.env.LASTFM_API_SECRET || "";
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
function generateLastFmSig(params, apiSecret) {
  const sortedKeys = Object.keys(params).filter((k) => k !== "format" && k !== "callback" && k !== "api_sig").sort();
  let sigString = "";
  for (const key of sortedKeys) {
    sigString += key + params[key];
  }
  sigString += apiSecret;
  return crypto.createHash("md5").update(sigString, "utf8").digest("hex");
}
async function callLastFmApi(params, apiSecret, method = "POST") {
  const requestParams = { ...params };
  if (apiSecret) {
    requestParams.api_sig = generateLastFmSig(requestParams, apiSecret);
  }
  requestParams.format = "json";
  const body = new URLSearchParams(requestParams);
  if (method === "GET") {
    const url = `${LASTFM_API_URL}?${body.toString()}`;
    const res = await fetch(url);
    const data = await res.json();
    return { status: res.status, ok: res.ok, data };
  } else {
    const res = await fetch(LASTFM_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "ScrobbleForge/2.0 (web-scrobbler)"
      },
      body: body.toString()
    });
    const data = await res.json();
    return { status: res.status, ok: res.ok, data };
  }
}
var activeJob = {
  status: "idle",
  artist: "rvaia",
  track: "kill bill",
  album: "kill bill",
  limit: 1800,
  interval: 2,
  jitter: true,
  isDryRun: false,
  mode: "live",
  queueMode: "single_loop",
  queue: [],
  currentQueueIndex: 0,
  scrobblesCompleted: 0,
  failedCount: 0,
  startedAt: null,
  lastScrobbleTime: null,
  rateLimitCooldownSeconds: 0,
  rateLimitResumeAt: null,
  currentError: null,
  logs: []
};
var sseClients = [];
function emitSSE(event, data) {
  const payload = `event: ${event}
data: ${JSON.stringify(data)}

`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(payload);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}
function addLog(level, message, extra) {
  const log = {
    id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: Date.now(),
    level,
    message,
    ...extra
  };
  activeJob.logs.push(log);
  if (activeJob.logs.length > 500) {
    activeJob.logs.shift();
  }
  emitSSE("log", log);
  emitSSE("status", getJobStatusPayload());
}
function getJobStatusPayload() {
  return {
    ...activeJob,
    logs: activeJob.logs.slice(-50)
    // last 50 for quick updates
  };
}
var jobTimeoutHandle = null;
var workerCredentials = null;
async function executeScrobbleStep() {
  if (activeJob.status !== "running") return;
  const isQueueMode = activeJob.queue.length > 0 && activeJob.queueMode !== "single_loop";
  if (activeJob.scrobblesCompleted >= activeJob.limit) {
    activeJob.status = "completed";
    addLog(
      "success",
      `\u{1F389} Target limit reached! Successfully scrobbled ${activeJob.scrobblesCompleted}/${activeJob.limit} tracks.`
    );
    emitSSE("completed", getJobStatusPayload());
    return;
  }
  if (isQueueMode && activeJob.queueMode === "queue_once" && activeJob.currentQueueIndex >= activeJob.queue.length) {
    activeJob.status = "completed";
    addLog(
      "success",
      `\u{1F389} Full queue completed! Finished all ${activeJob.queue.length} tracks.`
    );
    emitSSE("completed", getJobStatusPayload());
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
      currentAlbum = trackItem.album || "";
    }
  }
  const currentCount = activeJob.scrobblesCompleted + 1;
  const targetLimit = activeJob.limit;
  if (activeJob.isDryRun) {
    activeJob.scrobblesCompleted = currentCount;
    activeJob.lastScrobbleTime = Date.now();
    addLog(
      "info",
      `[DRY RUN] Simulated scrobble for "${currentTrackName}" by ${currentArtist} (${currentCount}/${targetLimit})`,
      { artist: currentArtist, track: currentTrackName, album: currentAlbum, count: currentCount, total: targetLimit }
    );
    advanceQueueIndex();
    scheduleNextStep();
    return;
  }
  if (!workerCredentials || !workerCredentials.sessionKey) {
    activeJob.status = "error";
    activeJob.currentError = "Missing Last.fm authentication session.";
    addLog("error", "Authentication failed: No valid Last.fm session key.");
    return;
  }
  try {
    const timestamp = Math.floor(Date.now() / 1e3);
    const params = {
      method: "track.scrobble",
      api_key: workerCredentials.apiKey,
      sk: workerCredentials.sessionKey,
      "artist[0]": currentArtist,
      "track[0]": currentTrackName,
      "timestamp[0]": timestamp.toString()
    };
    if (currentAlbum) {
      params["album[0]"] = currentAlbum;
    }
    const response = await callLastFmApi(
      params,
      workerCredentials.apiSecret,
      "POST"
    );
    if (response.data && response.data.error) {
      const errorCode = response.data.error;
      const errorMsg = response.data.message || "Unknown Last.fm error";
      if (errorCode === 26) {
        activeJob.status = "rate_limited";
        activeJob.rateLimitCooldownSeconds = 60;
        activeJob.rateLimitResumeAt = Date.now() + 6e4;
        addLog(
          "rate_limit",
          `\u26A0\uFE0F Rate limit reached (Code 26: ${errorMsg}). Cooling down for 60 seconds...`
        );
        jobTimeoutHandle = setTimeout(() => {
          if (activeJob.status === "rate_limited") {
            activeJob.status = "running";
            activeJob.rateLimitCooldownSeconds = 0;
            activeJob.rateLimitResumeAt = null;
            addLog("info", "\u2705 Cooldown completed. Resuming scrobble stream...");
            executeScrobbleStep();
          }
        }, 6e4);
        return;
      } else {
        activeJob.failedCount += 1;
        addLog("error", `Last.fm WSError [Code ${errorCode}]: ${errorMsg}`);
        activeJob.status = "error";
        activeJob.currentError = `WSError: ${errorMsg} (Code ${errorCode})`;
        return;
      }
    }
    activeJob.scrobblesCompleted = currentCount;
    activeJob.lastScrobbleTime = Date.now();
    addLog(
      "success",
      `Scrobbled "${currentTrackName}" by ${currentArtist} (${currentCount}/${targetLimit})`,
      { artist: currentArtist, track: currentTrackName, album: currentAlbum, count: currentCount, total: targetLimit }
    );
    advanceQueueIndex();
    scheduleNextStep();
  } catch (err) {
    activeJob.failedCount += 1;
    const errorMsg = err?.message || "Network error";
    addLog(
      "warn",
      `Network glitch: ${errorMsg}. Backing off for 10s before retry...`
    );
    jobTimeoutHandle = setTimeout(() => {
      if (activeJob.status === "running") {
        executeScrobbleStep();
      }
    }, 1e4);
  }
}
function advanceQueueIndex() {
  if (activeJob.queue.length > 0 && activeJob.queueMode !== "single_loop") {
    activeJob.currentQueueIndex += 1;
    if (activeJob.currentQueueIndex >= activeJob.queue.length) {
      if (activeJob.queueMode === "queue_loop") {
        activeJob.currentQueueIndex = 0;
      }
    }
  }
}
function scheduleNextStep() {
  if (activeJob.status !== "running") return;
  let delay = activeJob.interval * 1e3;
  if (activeJob.jitter) {
    const jitterMs = (Math.random() - 0.5) * 1e3;
    delay = Math.max(500, delay + jitterMs);
  }
  jobTimeoutHandle = setTimeout(() => {
    executeScrobbleStep();
  }, delay);
}
app.get("/api/job/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.push(res);
  res.write(`event: status
data: ${JSON.stringify(getJobStatusPayload())}

`);
  req.on("close", () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});
app.get("/api/lastfm/server-config", (_req, res) => {
  res.json({
    ok: true,
    hasServerApiKey: Boolean(ENV_API_KEY),
    serverApiKey: ENV_API_KEY || null
  });
});
app.post("/api/lastfm/auth", async (req, res) => {
  try {
    const { apiKey, apiSecret, username, password, sessionKey } = req.body;
    const resolvedApiKey = (apiKey || ENV_API_KEY || "").trim();
    const resolvedApiSecret = (apiSecret || ENV_API_SECRET || "").trim();
    if (!resolvedApiKey || !resolvedApiSecret) {
      return res.status(400).json({ ok: false, error: "API Key and API Secret are required." });
    }
    if (sessionKey && username) {
      const userInfo = await callLastFmApi(
        { method: "user.getInfo", user: username, api_key: resolvedApiKey },
        void 0,
        "GET"
      );
      if (userInfo.data && userInfo.data.user) {
        workerCredentials = {
          apiKey: resolvedApiKey,
          apiSecret: resolvedApiSecret,
          sessionKey,
          username
        };
        return res.json({
          ok: true,
          sessionKey,
          username,
          user: userInfo.data.user
        });
      }
    }
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "Username and password are required." });
    }
    const params = {
      method: "auth.getMobileSession",
      username,
      password,
      api_key: resolvedApiKey
    };
    const authRes = await callLastFmApi(params, resolvedApiSecret, "POST");
    if (authRes.data && authRes.data.session) {
      const key = authRes.data.session.key;
      const userName = authRes.data.session.name;
      let userProfile = null;
      try {
        const infoRes = await callLastFmApi(
          { method: "user.getInfo", user: userName, api_key: apiKey },
          void 0,
          "GET"
        );
        if (infoRes.data && infoRes.data.user) {
          userProfile = infoRes.data.user;
        }
      } catch (e) {
      }
      workerCredentials = {
        apiKey,
        apiSecret,
        sessionKey: key,
        username: userName
      };
      return res.json({
        ok: true,
        sessionKey: key,
        username: userName,
        user: userProfile
      });
    }
    return res.status(400).json({
      ok: false,
      error: authRes.data?.message || "Authentication failed. Please verify credentials.",
      errorCode: authRes.data?.error
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Internal server error" });
  }
});
app.get("/api/lastfm/user-info", async (req, res) => {
  try {
    const apiKey = req.query.apiKey || workerCredentials?.apiKey;
    const username = req.query.username || workerCredentials?.username;
    if (!apiKey || !username) {
      return res.status(400).json({ ok: false, error: "API Key and username required" });
    }
    const response = await callLastFmApi(
      { method: "user.getInfo", user: username, api_key: apiKey },
      void 0,
      "GET"
    );
    if (response.data && response.data.user) {
      return res.json({ ok: true, user: response.data.user });
    }
    return res.status(400).json({
      ok: false,
      error: response.data?.message || "Could not fetch user info"
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/api/lastfm/recent-tracks", async (req, res) => {
  try {
    const apiKey = req.query.apiKey || workerCredentials?.apiKey;
    const username = req.query.username || workerCredentials?.username;
    const limit = req.query.limit || "15";
    if (!apiKey || !username) {
      return res.status(400).json({ ok: false, error: "API Key and username required" });
    }
    const response = await callLastFmApi(
      {
        method: "user.getRecentTracks",
        user: username,
        limit,
        api_key: apiKey,
        extended: "1"
      },
      void 0,
      "GET"
    );
    if (response.data && response.data.recenttracks) {
      return res.json({
        ok: true,
        recentTracks: response.data.recenttracks.track || [],
        total: response.data.recenttracks["@attr"]?.total || 0
      });
    }
    return res.status(400).json({
      ok: false,
      error: response.data?.message || "Could not fetch recent tracks"
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/api/lastfm/fetch-profile-tracks", async (req, res) => {
  try {
    const apiKey = req.query.apiKey || workerCredentials?.apiKey;
    const username = req.query.username || workerCredentials?.username;
    const type = req.query.type || "recents";
    const period = req.query.period || "overall";
    const limitPerPage = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
    const pagesToFetch = Math.min(10, Math.max(1, parseInt(req.query.pages, 10) || 1));
    if (!apiKey || !username) {
      return res.status(400).json({ ok: false, error: "API key and username are required." });
    }
    const collectedTracks = [];
    let method = "user.getRecentTracks";
    if (type === "top") method = "user.getTopTracks";
    if (type === "loved") method = "user.getLovedTracks";
    for (let p = 1; p <= pagesToFetch; p++) {
      const params = {
        method,
        user: username,
        limit: limitPerPage.toString(),
        page: p.toString(),
        api_key: apiKey
      };
      if (type === "top") {
        params.period = period;
      }
      if (type === "recents") {
        params.extended = "1";
      }
      const response = await callLastFmApi(params, void 0, "GET");
      if (response.data && !response.data.error) {
        let rawList = [];
        if (type === "recents" && response.data.recenttracks?.track) {
          rawList = Array.isArray(response.data.recenttracks.track) ? response.data.recenttracks.track : [response.data.recenttracks.track];
        } else if (type === "top" && response.data.toptracks?.track) {
          rawList = Array.isArray(response.data.toptracks.track) ? response.data.toptracks.track : [response.data.toptracks.track];
        } else if (type === "loved" && response.data.lovedtracks?.track) {
          rawList = Array.isArray(response.data.lovedtracks.track) ? response.data.lovedtracks.track : [response.data.lovedtracks.track];
        }
        for (const item of rawList) {
          const trackName = item.name;
          const artistName = item.artist?.name || item.artist?.["#text"] || (typeof item.artist === "string" ? item.artist : "Unknown");
          const albumName = item.album?.["#text"] || item.album?.title || "";
          const imageUrl = item.image?.[2]?.["#text"] || item.image?.[1]?.["#text"] || "";
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
              rank: item["@attr"]?.rank
            });
          }
        }
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
      tracks: collectedTracks
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/api/lastfm/fetch-artist-tracks", async (req, res) => {
  try {
    const apiKey = req.query.apiKey || workerCredentials?.apiKey;
    const artist = req.query.artist;
    const limit = Math.min(200, Math.max(5, parseInt(req.query.limit, 10) || 50));
    if (!apiKey || !artist) {
      return res.status(400).json({ ok: false, error: "API key and artist are required." });
    }
    const response = await callLastFmApi(
      {
        method: "artist.getTopTracks",
        artist,
        limit: limit.toString(),
        api_key: apiKey
      },
      void 0,
      "GET"
    );
    if (response.data && response.data.toptracks?.track) {
      const raw = Array.isArray(response.data.toptracks.track) ? response.data.toptracks.track : [response.data.toptracks.track];
      const tracks = raw.map((item) => ({
        id: `${item.name}-${Math.random().toString(36).substr(2, 5)}`,
        name: item.name,
        artist: item.artist?.name || artist,
        album: "",
        duration: parseInt(item.duration, 10) || 180,
        image: item.image?.[2]?.["#text"] || item.image?.[1]?.["#text"] || "",
        playcount: item.playcount,
        rank: item["@attr"]?.rank
      }));
      return res.json({ ok: true, artist, tracks });
    }
    return res.status(400).json({
      ok: false,
      error: response.data?.message || "Could not fetch artist tracks"
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/api/lastfm/fetch-artist-albums", async (req, res) => {
  try {
    const apiKey = req.query.apiKey || workerCredentials?.apiKey;
    const artist = req.query.artist;
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 30));
    if (!apiKey || !artist) {
      return res.status(400).json({ ok: false, error: "API key and artist are required." });
    }
    const response = await callLastFmApi(
      {
        method: "artist.getTopAlbums",
        artist,
        limit: limit.toString(),
        api_key: apiKey
      },
      void 0,
      "GET"
    );
    if (response.data && response.data.topalbums?.album) {
      const raw = Array.isArray(response.data.topalbums.album) ? response.data.topalbums.album : [response.data.topalbums.album];
      const albums = raw.map((item) => ({
        name: item.name,
        artist: item.artist?.name || artist,
        playcount: item.playcount,
        image: item.image?.[2]?.["#text"] || item.image?.[1]?.["#text"] || "",
        url: item.url
      }));
      return res.json({ ok: true, artist, albums });
    }
    return res.status(400).json({
      ok: false,
      error: response.data?.message || "Could not fetch artist albums"
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/api/lastfm/fetch-album-tracks", async (req, res) => {
  try {
    const apiKey = req.query.apiKey || workerCredentials?.apiKey;
    const artist = req.query.artist;
    const album = req.query.album;
    if (!apiKey || !artist || !album) {
      return res.status(400).json({ ok: false, error: "API key, artist, and album are required." });
    }
    const response = await callLastFmApi(
      {
        method: "album.getInfo",
        artist,
        album,
        api_key: apiKey
      },
      void 0,
      "GET"
    );
    if (response.data && response.data.album) {
      const albumData = response.data.album;
      const albumArt = albumData.image?.[3]?.["#text"] || albumData.image?.[2]?.["#text"] || "";
      const rawTracks = albumData.tracks?.track || [];
      const trackList = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
      const tracks = trackList.map((t, idx) => ({
        id: `${t.name}-${idx}-${Math.random().toString(36).substr(2, 5)}`,
        name: t.name,
        artist: t.artist?.name || artist,
        album: albumData.name,
        duration: parseInt(t.duration, 10) || 200,
        image: albumArt,
        rank: t["@attr"]?.rank || idx + 1
      }));
      return res.json({
        ok: true,
        artist: albumData.artist,
        album: albumData.name,
        image: albumArt,
        tracks,
        totalTracks: tracks.length
      });
    }
    return res.status(400).json({
      ok: false,
      error: response.data?.message || "Could not fetch album tracklist"
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/api/lastfm/search", async (req, res) => {
  try {
    const apiKey = req.query.apiKey || workerCredentials?.apiKey;
    const track = req.query.track;
    const artist = req.query.artist;
    if (!apiKey || !track && !artist) {
      return res.status(400).json({ ok: false, error: "Search term required" });
    }
    const response = await callLastFmApi(
      {
        method: "track.search",
        track: track || artist,
        artist: artist || "",
        limit: "8",
        api_key: apiKey
      },
      void 0,
      "GET"
    );
    if (response.data && response.data.results) {
      return res.json({
        ok: true,
        tracks: response.data.results.trackmatches?.track || []
      });
    }
    return res.status(400).json({ ok: false, error: "No results found" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/api/lastfm/search-artist", async (req, res) => {
  try {
    const apiKey = req.query.apiKey || workerCredentials?.apiKey || ENV_API_KEY;
    const query = req.query.query;
    const limit = req.query.limit || "12";
    if (!apiKey || !query) {
      return res.status(400).json({ ok: false, error: "Artist search query required" });
    }
    const response = await callLastFmApi(
      {
        method: "artist.search",
        artist: query,
        limit,
        api_key: apiKey
      },
      void 0,
      "GET"
    );
    if (response.data && response.data.results?.artistmatches?.artist) {
      const raw = Array.isArray(response.data.results.artistmatches.artist) ? response.data.results.artistmatches.artist : [response.data.results.artistmatches.artist];
      const artists = raw.map((a) => ({
        name: a.name,
        listeners: a.listeners,
        image: a.image?.[2]?.["#text"] || a.image?.[1]?.["#text"] || "",
        url: a.url
      }));
      return res.json({ ok: true, artists });
    }
    return res.status(400).json({ ok: false, error: "No artists found" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/api/lastfm/search-album", async (req, res) => {
  try {
    const apiKey = req.query.apiKey || workerCredentials?.apiKey || ENV_API_KEY;
    const query = req.query.query;
    const limit = req.query.limit || "12";
    if (!apiKey || !query) {
      return res.status(400).json({ ok: false, error: "Album search query required" });
    }
    const response = await callLastFmApi(
      {
        method: "album.search",
        album: query,
        limit,
        api_key: apiKey
      },
      void 0,
      "GET"
    );
    if (response.data && response.data.results?.albummatches?.album) {
      const raw = Array.isArray(response.data.results.albummatches.album) ? response.data.results.albummatches.album : [response.data.results.albummatches.album];
      const albums = raw.map((a) => ({
        name: a.name,
        artist: a.artist,
        image: a.image?.[2]?.["#text"] || a.image?.[1]?.["#text"] || "",
        url: a.url
      }));
      return res.json({ ok: true, albums });
    }
    return res.status(400).json({ ok: false, error: "No albums found" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/api/lastfm/search-user", async (req, res) => {
  try {
    const apiKey = req.query.apiKey || workerCredentials?.apiKey || ENV_API_KEY;
    const username = req.query.username;
    if (!apiKey || !username) {
      return res.status(400).json({ ok: false, error: "Username required" });
    }
    const [userInfoRes, recentRes] = await Promise.all([
      callLastFmApi({ method: "user.getInfo", user: username, api_key: apiKey }, void 0, "GET"),
      callLastFmApi(
        { method: "user.getRecentTracks", user: username, limit: "10", api_key: apiKey, extended: "1" },
        void 0,
        "GET"
      )
    ]);
    if (userInfoRes.data && userInfoRes.data.user) {
      const user = userInfoRes.data.user;
      const recentTracks = recentRes.data?.recenttracks?.track || [];
      return res.json({
        ok: true,
        user,
        recentTracks: Array.isArray(recentTracks) ? recentTracks : [recentTracks]
      });
    }
    return res.status(404).json({ ok: false, error: "Last.fm user not found" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/api/lastfm/now-playing", async (req, res) => {
  try {
    const { artist, track, album, apiKey, apiSecret, sessionKey } = req.body;
    const resolvedApiKey = apiKey || workerCredentials?.apiKey;
    const resolvedSecret = apiSecret || workerCredentials?.apiSecret;
    const resolvedSession = sessionKey || workerCredentials?.sessionKey;
    if (!resolvedApiKey || !resolvedSecret || !resolvedSession) {
      return res.status(400).json({ ok: false, error: "Missing Last.fm authentication credentials" });
    }
    const params = {
      method: "track.updateNowPlaying",
      artist,
      track,
      api_key: resolvedApiKey,
      sk: resolvedSession
    };
    if (album) params.album = album;
    const response = await callLastFmApi(params, resolvedSecret, "POST");
    return res.json({ ok: true, data: response.data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/api/lastfm/single-scrobble", async (req, res) => {
  try {
    const { artist, track, album, apiKey, apiSecret, sessionKey, timestamp } = req.body;
    const resolvedApiKey = apiKey || workerCredentials?.apiKey;
    const resolvedSecret = apiSecret || workerCredentials?.apiSecret;
    const resolvedSession = sessionKey || workerCredentials?.sessionKey;
    if (!resolvedApiKey || !resolvedSecret || !resolvedSession) {
      return res.status(400).json({ ok: false, error: "Missing Last.fm authentication credentials" });
    }
    const ts = timestamp || Math.floor(Date.now() / 1e3);
    const params = {
      method: "track.scrobble",
      api_key: resolvedApiKey,
      sk: resolvedSession,
      "artist[0]": artist,
      "track[0]": track,
      "timestamp[0]": ts.toString()
    };
    if (album) params["album[0]"] = album;
    const response = await callLastFmApi(params, resolvedSecret, "POST");
    if (response.data && response.data.error) {
      return res.status(400).json({ ok: false, error: response.data.message });
    }
    return res.json({ ok: true, data: response.data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/api/job/batch-scrobble-all", async (req, res) => {
  try {
    const {
      tracks,
      spanHours,
      startTime,
      endTime,
      apiKey,
      apiSecret,
      sessionKey
    } = req.body;
    const resolvedApiKey = apiKey || workerCredentials?.apiKey;
    const resolvedSecret = apiSecret || workerCredentials?.apiSecret;
    const resolvedSession = sessionKey || workerCredentials?.sessionKey;
    if (!resolvedApiKey || !resolvedSecret || !resolvedSession) {
      return res.status(400).json({ ok: false, error: "Missing Last.fm credentials" });
    }
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ ok: false, error: "No tracks provided for batch scrobbling." });
    }
    const totalToScrobble = tracks.length;
    const now = Math.floor(Date.now() / 1e3);
    const resolvedEnd = endTime ? Math.min(now, Math.floor(endTime)) : now;
    const resolvedStart = startTime ? Math.floor(startTime) : resolvedEnd - Math.max(60, (spanHours || 24) * 3600);
    const spanDuration = Math.max(60, resolvedEnd - resolvedStart);
    const stepSeconds = Math.max(20, Math.floor(spanDuration / totalToScrobble));
    let completed = 0;
    const batchSize = 50;
    addLog(
      "info",
      `\u{1F680} Commencing batch scrobble: ${totalToScrobble} tracks distributed across time range (${new Date(
        resolvedStart * 1e3
      ).toLocaleTimeString()} to ${new Date(resolvedEnd * 1e3).toLocaleTimeString()}).`
    );
    for (let i = 0; i < totalToScrobble; i += batchSize) {
      const currentChunk = tracks.slice(i, i + batchSize);
      const params = {
        method: "track.scrobble",
        api_key: resolvedApiKey,
        sk: resolvedSession
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
      const response = await callLastFmApi(params, resolvedSecret, "POST");
      if (response.data && response.data.error) {
        addLog(
          "error",
          `Batch chunk error: ${response.data.message} (code ${response.data.error})`
        );
        return res.status(400).json({
          ok: false,
          error: response.data.message,
          completed
        });
      }
      completed += currentChunk.length;
      addLog(
        "success",
        `Batch payload accepted: +${currentChunk.length} tracks scrobbled (${completed}/${totalToScrobble})`
      );
      if (i + batchSize < totalToScrobble) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    addLog("success", `\u{1F389} Batch scrobble complete! Total ${completed} songs added to Last.fm.`);
    return res.json({ ok: true, completed });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/api/job/start", (req, res) => {
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
    credentials
  } = req.body;
  if (activeJob.status === "running") {
    return res.status(400).json({ ok: false, error: "A scrobble job is already running." });
  }
  if (credentials) {
    workerCredentials = credentials;
  }
  if (!isDryRun && (!workerCredentials || !workerCredentials.sessionKey)) {
    return res.status(400).json({
      ok: false,
      error: "Please connect Last.fm credentials before starting live scrobbles."
    });
  }
  if (jobTimeoutHandle) {
    clearTimeout(jobTimeoutHandle);
    jobTimeoutHandle = null;
  }
  const resolvedQueue = Array.isArray(queue) ? queue : [];
  const resolvedQueueMode = queueMode || (resolvedQueue.length > 0 ? "queue_once" : "single_loop");
  const resolvedLimit = resolvedQueueMode === "queue_once" ? resolvedQueue.length : Math.max(1, parseInt(limit, 10) || 1800);
  activeJob = {
    status: "running",
    artist: (artist || "rvaia").trim(),
    track: (track || "kill bill").trim(),
    album: (album || "kill bill").trim(),
    limit: resolvedLimit,
    interval: Math.max(0.5, parseFloat(interval) || 2),
    jitter: jitter !== false,
    isDryRun: Boolean(isDryRun),
    mode: "live",
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
    logs: []
  };
  const modeDescription = resolvedQueueMode === "queue_once" ? `Queue Mode (${resolvedQueue.length} tracks once)` : resolvedQueueMode === "queue_loop" ? `Queue Loop Mode (${resolvedQueue.length} tracks looped up to ${activeJob.limit})` : `Single Track Loop ("${activeJob.track}" by ${activeJob.artist})`;
  addLog(
    "info",
    `\u2728 Scrobble stream initiated: ${modeDescription} [Interval: ${activeJob.interval}s, Jitter: ${activeJob.jitter ? "ON" : "OFF"}${activeJob.isDryRun ? ", DRY RUN" : ""}]`
  );
  executeScrobbleStep();
  return res.json({ ok: true, job: getJobStatusPayload() });
});
app.post("/api/job/pause", (_req, res) => {
  if (activeJob.status === "running" || activeJob.status === "rate_limited") {
    if (jobTimeoutHandle) {
      clearTimeout(jobTimeoutHandle);
      jobTimeoutHandle = null;
    }
    activeJob.status = "paused";
    addLog("warn", "\u23F8\uFE0F Job paused by user.");
    return res.json({ ok: true, job: getJobStatusPayload() });
  }
  return res.status(400).json({ ok: false, error: "Job is not running or active." });
});
app.post("/api/job/resume", (_req, res) => {
  if (activeJob.status === "paused") {
    activeJob.status = "running";
    addLog("info", "\u25B6\uFE0F Job resumed.");
    executeScrobbleStep();
    return res.json({ ok: true, job: getJobStatusPayload() });
  }
  return res.status(400).json({ ok: false, error: "Job is not paused." });
});
app.post("/api/job/stop", (_req, res) => {
  if (jobTimeoutHandle) {
    clearTimeout(jobTimeoutHandle);
    jobTimeoutHandle = null;
  }
  activeJob.status = "idle";
  addLog(
    "info",
    `\u23F9\uFE0F Job terminated. Completed ${activeJob.scrobblesCompleted}/${activeJob.limit} scrobbles.`
  );
  return res.json({ ok: true, job: getJobStatusPayload() });
});
app.get("/api/job/status", (_req, res) => {
  return res.json({ ok: true, job: getJobStatusPayload() });
});
app.post("/api/job/clear-logs", (_req, res) => {
  activeJob.logs = [];
  emitSSE("status", getJobStatusPayload());
  return res.json({ ok: true });
});
app.post("/api/gemini/chat", async (req, res) => {
  try {
    const { messages, model, role, context } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: "GEMINI_API_KEY is not configured in the server environment."
      });
    }
    const ai = new GoogleGenAI({});
    const selectedModel = model || "gemini-3.5-flash";
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
    if (role === "analyst") {
      systemInstruction += `
Role: Deep Music Analyst. Focus on detailed discography breakdowns, sonic aesthetics, genre evolution, and track sequencing.`;
    } else if (role === "fast_recommender") {
      systemInstruction += `
Role: Fast Recommender. Keep answers punchy, rapid, and direct with instant song ideas.`;
    }
    if (context) {
      systemInstruction += `
Current User Context:
${JSON.stringify(context, null, 2)}`;
    }
    const contents = (messages || []).map((m) => ({
      role: m.role === "assistant" || m.role === "model" ? "model" : "user",
      parts: [{ text: m.text || m.content || "" }]
    }));
    const candidateModels = [selectedModel];
    if (selectedModel === "gemini-3.1-pro-preview") {
      candidateModels.push("gemini-3.5-flash", "gemini-3.1-flash-lite");
    } else if (selectedModel === "gemini-3.5-flash") {
      candidateModels.push("gemini-3.1-flash-lite");
    } else {
      candidateModels.push("gemini-3.5-flash");
    }
    let response = null;
    let actualModelUsed = selectedModel;
    let fallbackNotice = null;
    let lastError = null;
    for (const modelCandidate of candidateModels) {
      try {
        response = await ai.models.generateContent({
          model: modelCandidate,
          contents,
          config: {
            systemInstruction
          }
        });
        actualModelUsed = modelCandidate;
        if (modelCandidate !== selectedModel) {
          fallbackNotice = `(Auto-switched from ${selectedModel} to ${modelCandidate} due to free-tier quota limits)`;
        }
        break;
      } catch (err) {
        lastError = err;
        const errMsg = err?.message || "";
        const isQuotaOrRateLimit = err?.status === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("Quota exceeded") || errMsg.includes("quota");
        if (isQuotaOrRateLimit) {
          console.warn(`[ScrobbleAI] Quota limit on ${modelCandidate}, trying next candidate...`);
          continue;
        } else {
          throw err;
        }
      }
    }
    if (!response) {
      throw lastError || new Error("All candidate models exhausted");
    }
    const replyText = response.text || "";
    let suggestedTracks = [];
    const tracksBlockMatch = replyText.match(/```tracks\s*([\s\S]*?)\s*```/);
    if (tracksBlockMatch && tracksBlockMatch[1]) {
      try {
        suggestedTracks = JSON.parse(tracksBlockMatch[1]);
      } catch {
      }
    }
    let cleanText = replyText.replace(/```tracks\s*[\s\S]*?\s*```/, "").trim();
    if (fallbackNotice) {
      cleanText += `

*${fallbackNotice}*`;
    }
    return res.json({
      ok: true,
      text: cleanText,
      rawText: replyText,
      suggestedTracks,
      modelUsed: actualModelUsed,
      fallbackNotice
    });
  } catch (err) {
    console.error("Gemini Chat error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Gemini API quota exceeded or service unavailable. Please try switching to Gemini Flash or Lite."
    });
  }
});
async function startServer() {
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== "true"
      },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[ScrobbleForge] Server running on http://0.0.0.0:${PORT}`);
  });
}
startServer().catch((err) => {
  console.error("[ScrobbleForge] Failed to start server:", err);
  process.exit(1);
});
