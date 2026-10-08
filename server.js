// server.ts
import "dotenv/config";
import express from "express";
import path2 from "path";
import { fileURLToPath } from "url";
import crypto2 from "crypto";

// activity.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
var file = process.env.ACTIVITY_DB_PATH || path.resolve("data/activity.sqlite");
mkdirSync(path.dirname(file), { recursive: true, mode: 448 });
var activityDb = new DatabaseSync(file);
activityDb.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    timestamp INTEGER NOT NULL, level TEXT NOT NULL, category TEXT NOT NULL, operation TEXT, jobId TEXT,
    requestId TEXT, outcome TEXT, record TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS activity_time ON activity(timestamp);
  CREATE INDEX IF NOT EXISTS activity_level ON activity(level, seq);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
var retentionDays = Math.max(1, Number(process.env.ACTIVITY_RETENTION_DAYS) || 90);
var lastPruned = 0;
function recordActivity(level, message, extra = {}) {
  const record = { id: crypto.randomUUID(), timestamp: Date.now(), level, message: message.slice(0, 1500), category: extra.category || "job" };
  for (const key of ["track", "artist", "album", "count", "total", "operation", "jobId", "requestId", "outcome", "httpStatus", "errorCode", "durationMs", "retryAfterSeconds", "accepted", "ignored", "attempted", "scrobbleTimestamp"]) {
    if (extra[key] !== void 0) Object.assign(record, { [key]: extra[key] });
  }
  const result = activityDb.prepare("INSERT INTO activity(id,timestamp,level,category,operation,jobId,requestId,outcome,record) VALUES(?,?,?,?,?,?,?,?,?)").run(record.id, record.timestamp, level, record.category, record.operation || null, record.jobId || null, record.requestId || null, record.outcome || null, JSON.stringify(record));
  record.seq = Number(result.lastInsertRowid);
  if (Date.now() - lastPruned > 36e5) {
    activityDb.prepare("DELETE FROM activity WHERE timestamp < ?").run(Date.now() - retentionDays * 864e5);
    lastPruned = Date.now();
  }
  return record;
}
function readActivity(options = {}) {
  const conditions = ["1=1"];
  const values = [];
  if (options.before) {
    conditions.push("seq < ?");
    values.push(options.before);
  }
  if (options.after) {
    conditions.push("seq > ?");
    values.push(options.after);
  }
  if (options.level && options.level !== "all") {
    conditions.push("level = ?");
    values.push(options.level);
  }
  if (options.search) {
    conditions.push("record LIKE ? ESCAPE '\\'");
    values.push(`%${options.search.replace(/[\\%_]/g, "\\$&")}%`);
  }
  const limit = Math.min(500, Math.max(1, options.limit || 100));
  const rows = activityDb.prepare(`SELECT seq,record FROM activity WHERE ${conditions.join(" AND ")} ORDER BY seq DESC LIMIT ?`).all(...values, limit + 1);
  const hasMore = rows.length > limit;
  const logs = rows.slice(0, limit).map((row) => ({ ...JSON.parse(String(row.record)), seq: Number(row.seq) })).reverse();
  return { logs, hasMore, nextBefore: logs[0]?.seq || null };
}
function activitySummary() {
  const row = activityDb.prepare(`SELECT COUNT(*) totalEvents,
    COALESCE(SUM(CASE WHEN outcome='accepted' THEN json_extract(record,'$.accepted') ELSE 0 END),0) accepted,
    COALESCE(SUM(CASE WHEN category='api' THEN json_extract(record,'$.ignored') ELSE 0 END),0) ignored,
    SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) failedRequests,
    SUM(CASE WHEN outcome='rate_limited' THEN 1 ELSE 0 END) rateLimitHits,
    SUM(CASE WHEN outcome='uncertain' THEN 1 ELSE 0 END) uncertainRequests,
    SUM(CASE WHEN outcome='attempt' THEN 1 ELSE 0 END) requests,
    SUM(CASE WHEN outcome='simulated' THEN 1 ELSE 0 END) simulated,
    MIN(timestamp) oldestAt, MAX(timestamp) latestAt FROM activity`).get();
  return { ...row, retentionDays, storage: "sqlite", healthy: true };
}
function* exportActivity() {
  for (const row of activityDb.prepare("SELECT seq,record FROM activity ORDER BY seq").iterate()) {
    yield { ...JSON.parse(String(row.record)), seq: Number(row.seq) };
  }
}
function saveCheckpoint(job) {
  activityDb.prepare("INSERT INTO settings(key,value) VALUES('job',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(job));
}
function loadCheckpoint() {
  const row = activityDb.prepare("SELECT value FROM settings WHERE key='job'").get();
  return row ? JSON.parse(String(row.value)) : null;
}

// server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path2.dirname(__filename);
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
  return crypto2.createHash("md5").update(sigString, "utf8").digest("hex");
}
var LastFmError = class extends Error {
  constructor(status, code, message, retryAfterSeconds = 0, uncertain = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.uncertain = uncertain;
  }
};
var cooldownResumeAt = null;
function retryAfter(value) {
  if (!value) return 60;
  const seconds = Number(value);
  return Math.max(1, Number.isFinite(seconds) ? seconds : Math.ceil((Date.parse(value) - Date.now()) / 1e3) || 60);
}
function respondError(res, error) {
  const e = error instanceof LastFmError ? error : new LastFmError(500, void 0, "Internal operation failed. Check the activity journal.");
  if (e.retryAfterSeconds) res.setHeader("Retry-After", String(e.retryAfterSeconds));
  return res.status(e.status).json({ ok: false, error: e.message, errorCode: e.code, retryAfterSeconds: e.retryAfterSeconds, uncertain: e.uncertain });
}
async function callLastFmApi(params, apiSecret, method = "POST", jobId) {
  const requestId = crypto2.randomUUID();
  const operation = params.method;
  const context = {
    category: "api",
    operation,
    requestId,
    track: params["track[0]"] || params.track,
    artist: params["artist[0]"] || params.artist,
    jobId
  };
  if (cooldownResumeAt && cooldownResumeAt > Date.now()) {
    const seconds = Math.ceil((cooldownResumeAt - Date.now()) / 1e3);
    addLog("warn", `${operation} deferred during Last.fm cooldown (${seconds}s remaining).`, { ...context, outcome: "deferred", retryAfterSeconds: seconds });
    throw new LastFmError(429, 26, "Last.fm cooldown is active. Try again after the countdown.", seconds);
  }
  const started = Date.now();
  const attempted = operation === "track.scrobble" ? Object.keys(params).filter((k) => /^track\[\d+\]$/.test(k)).length : 0;
  addLog("info", `Request started: ${operation}${attempted ? ` (${attempted} tracks)` : ""}.`, { ...context, outcome: "attempt", attempted });
  const requestParams = { ...params };
  if (apiSecret) requestParams.api_sig = generateLastFmSig(requestParams, apiSecret);
  requestParams.format = "json";
  const body = new URLSearchParams(requestParams);
  let upstreamStatus;
  try {
    const res = await fetch(method === "GET" ? `${LASTFM_API_URL}?${body}` : LASTFM_API_URL, {
      method,
      signal: AbortSignal.timeout(2e4),
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ScrobbleForge/3.0" },
      ...method === "POST" ? { body: body.toString() } : {}
    });
    upstreamStatus = res.status;
    let data;
    try {
      data = await res.json();
    } catch {
      if (res.status !== 429) throw new LastFmError(502, void 0, "Last.fm returned an unreadable response; submission outcome is unknown.", 0, method === "POST");
      data = {};
    }
    const code = data.error === void 0 ? void 0 : Number(data.error);
    if (res.status === 429 || code === 26) {
      const seconds = retryAfter(res.headers.get("retry-after"));
      cooldownResumeAt = Math.max(cooldownResumeAt || 0, Date.now() + seconds * 1e3);
      throw new LastFmError(429, code || 26, "Last.fm request rate limit reached.", seconds);
    }
    if (!res.ok || code) {
      const message = code === 9 ? "Last.fm session expired. Reconnect your account." : code === 29 ? "Last.fm daily scrobble limit reached. Wait before submitting more." : `Last.fm rejected ${operation}${code ? ` (code ${code})` : ` (HTTP ${res.status})`}.`;
      throw new LastFmError(code === 9 ? 401 : 502, code, message, 0, !res.ok && !code && method === "POST");
    }
    let accepted = 0, ignored = 0, dailyLimited = false;
    if (operation === "track.scrobble") {
      const result = data.scrobbles;
      const attr = result?.["@attr"];
      const entries = Array.isArray(result?.scrobble) ? result.scrobble : result?.scrobble ? [result.scrobble] : [];
      accepted = Number(attr?.accepted);
      ignored = Number(attr?.ignored);
      if (!Number.isInteger(accepted) || !Number.isInteger(ignored) || accepted < 0 || ignored < 0 || accepted + ignored !== attempted || entries.length !== attempted) {
        throw new LastFmError(502, void 0, "Last.fm did not confirm all track outcomes. Do not blindly resubmit.", 0, true);
      }
      if (entries.some((entry) => !Number.isInteger(Number(entry.ignoredMessage?.code))) || entries.filter((entry) => Number(entry.ignoredMessage?.code) === 0).length !== accepted) throw new LastFmError(502, void 0, "Last.fm returned inconsistent track outcomes. Do not blindly resubmit.", 0, true);
      entries.forEach((entry, index) => {
        const ignoredCode = Number(entry.ignoredMessage?.code);
        if (ignoredCode === 5) dailyLimited = true;
        const reasons = { 1: "Artist was ignored", 2: "Track was ignored", 3: "Timestamp is too old", 4: "Timestamp is in the future", 5: "Daily scrobble limit exceeded" };
        addLog(ignoredCode === 5 ? "rate_limit" : ignoredCode ? "warn" : "success", ignoredCode ? `Track ignored: ${reasons[ignoredCode] || `reason ${ignoredCode}`}.` : "Track confirmed accepted by Last.fm.", {
          ...context,
          track: params[`track[${index}]`],
          artist: params[`artist[${index}]`],
          outcome: ignoredCode === 5 ? "rate_limited" : void 0,
          errorCode: ignoredCode || void 0,
          scrobbleTimestamp: Number(params[`timestamp[${index}]`])
        });
      });
    }
    if (operation === "track.updateNowPlaying" && !data.nowplaying) throw new LastFmError(502, void 0, "Last.fm did not confirm Now Playing.");
    if (operation === "track.updateNowPlaying" && Number(data.nowplaying.ignoredMessage?.code || 0) !== 0) throw new LastFmError(422, Number(data.nowplaying.ignoredMessage.code), "Last.fm ignored the Now Playing update.");
    addLog(ignored ? "warn" : "success", operation === "track.scrobble" ? `Last.fm confirmed ${accepted} accepted, ${ignored} ignored.` : `Request completed: ${operation}.`, {
      ...context,
      outcome: accepted ? "accepted" : ignored ? "ignored" : "success",
      accepted,
      ignored,
      attempted,
      httpStatus: res.status,
      durationMs: Date.now() - started
    });
    return { status: res.status, ok: true, data, accepted, ignored, dailyLimited };
  } catch (error) {
    const e = error instanceof LastFmError ? error : new LastFmError(502, void 0, "Last.fm connection failed or timed out. Submission may be uncertain.", 0, method === "POST");
    addLog(e.status === 429 || e.code === 29 ? "rate_limit" : "error", e.message, { ...context, outcome: e.status === 429 || e.code === 29 ? "rate_limited" : e.uncertain ? "uncertain" : "failed", httpStatus: upstreamStatus, errorCode: e.code, retryAfterSeconds: e.retryAfterSeconds || void 0, durationMs: Date.now() - started });
    throw e;
  }
}
var activeJob = {
  jobId: crypto2.randomUUID(),
  ignoredCount: 0,
  simulatedCount: 0,
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
  const log = recordActivity(level, message, { jobId: extra?.category === "api" ? void 0 : activeJob.jobId, ...extra });
  activeJob.logs.push(log);
  if (activeJob.logs.length > 100) activeJob.logs.shift();
  saveCheckpoint({ ...activeJob, cooldownResumeAt, logs: [] });
  emitSSE("log", log);
  emitSSE("status", getJobStatusPayload());
}
function getJobStatusPayload() {
  return {
    ...activeJob,
    logs: activeJob.logs.slice(-100),
    cooldownResumeAt
  };
}
var restored = loadCheckpoint();
if (restored) {
  cooldownResumeAt = restored.cooldownResumeAt || null;
  activeJob = { ...activeJob, ...restored, logs: readActivity({ limit: 100 }).logs };
  if (["running", "rate_limited"].includes(activeJob.status)) {
    activeJob.status = "paused";
    addLog("warn", "Server restarted. Previous progress restored and paused; confirm before resuming. An in-flight submission may be uncertain.", { category: "system" });
  }
}
var jobTimeoutHandle = null;
var inFlight = false;
var workerCredentials = null;
async function executeScrobbleStep() {
  if (activeJob.status !== "running" || inFlight) return;
  const executingJob = activeJob;
  const isQueueMode = activeJob.queue.length > 0 && activeJob.queueMode !== "single_loop";
  if (activeJob.scrobblesCompleted + (activeJob.ignoredCount || 0) + (activeJob.simulatedCount || 0) >= activeJob.limit) {
    activeJob.status = "completed";
    addLog(
      "success",
      `Job finished: ${activeJob.scrobblesCompleted} accepted, ${activeJob.ignoredCount || 0} ignored, ${activeJob.simulatedCount || 0} simulated.`
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
  const currentCount = activeJob.scrobblesCompleted + (activeJob.ignoredCount || 0) + (activeJob.simulatedCount || 0) + 1;
  const targetLimit = activeJob.limit;
  if (activeJob.isDryRun) {
    activeJob.simulatedCount = (activeJob.simulatedCount || 0) + 1;
    addLog(
      "info",
      `[DRY RUN] Simulated scrobble for "${currentTrackName}" by ${currentArtist} (${currentCount}/${targetLimit})`,
      { artist: currentArtist, track: currentTrackName, album: currentAlbum, count: currentCount, total: targetLimit, outcome: "simulated" }
    );
    advanceQueueIndex();
    saveCheckpoint({ ...activeJob, cooldownResumeAt, logs: [] });
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
    inFlight = true;
    const response = await callLastFmApi(
      params,
      workerCredentials.apiSecret,
      "POST",
      executingJob.jobId
    );
    if (activeJob !== executingJob) return;
    activeJob.scrobblesCompleted += response.accepted;
    activeJob.ignoredCount = (activeJob.ignoredCount || 0) + response.ignored;
    if (response.accepted) activeJob.lastScrobbleTime = Date.now();
    addLog(
      response.accepted ? "success" : "warn",
      response.accepted ? `Scrobbled "${currentTrackName}" by ${currentArtist}.` : `Last.fm ignored "${currentTrackName}"; queue advanced without adding to accepted count.`,
      { artist: currentArtist, track: currentTrackName, album: currentAlbum, count: activeJob.scrobblesCompleted, total: targetLimit }
    );
    advanceQueueIndex();
    if (response.dailyLimited) {
      activeJob.status = "error";
      activeJob.currentError = "Last.fm daily scrobble limit reached. Stop and wait before submitting more.";
      addLog("error", activeJob.currentError);
    }
    scheduleNextStep();
  } catch (err) {
    if (activeJob !== executingJob) return;
    if (err instanceof LastFmError && err.status === 429) {
      activeJob.rateLimitResumeAt = cooldownResumeAt;
      activeJob.rateLimitCooldownSeconds = err.retryAfterSeconds;
      if (activeJob.status === "running") {
        activeJob.status = "rate_limited";
        scheduleCooldown();
      }
      addLog("warn", "Worker is waiting for the recorded Last.fm cooldown; this track was not accepted.");
    } else {
      activeJob.failedCount += 1;
      if (activeJob.status === "running") activeJob.status = "error";
      activeJob.currentError = err instanceof LastFmError ? err.message : "Scrobble failed.";
      addLog("error", activeJob.currentError);
    }
  } finally {
    inFlight = false;
    saveCheckpoint({ ...activeJob, cooldownResumeAt, logs: [] });
    emitSSE("status", getJobStatusPayload());
  }
}
function scheduleCooldown() {
  if (jobTimeoutHandle) clearTimeout(jobTimeoutHandle);
  jobTimeoutHandle = setTimeout(() => {
    if (activeJob.status !== "rate_limited") return;
    if (cooldownResumeAt && cooldownResumeAt > Date.now()) {
      scheduleCooldown();
      return;
    }
    activeJob.status = "running";
    activeJob.rateLimitResumeAt = null;
    activeJob.rateLimitCooldownSeconds = 0;
    addLog("info", "Cooldown completed. Resuming the unaccepted track.");
    void executeScrobbleStep();
  }, Math.max(1, (cooldownResumeAt || Date.now()) - Date.now()));
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
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET" && req.headers.origin) {
    const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol;
    if (req.headers.origin !== `${protocol}://${req.get("host")}`) {
      addLog("warn", "Cross-origin API mutation refused.", { category: "system", httpStatus: 403 });
      return res.status(403).json({ ok: false, error: "Cross-origin mutation refused." });
    }
  }
  if (!req.path.startsWith("/activity") && req.path !== "/job/events") {
    res.on("finish", () => {
      if (res.statusCode >= 400 && res.statusCode !== 429) addLog("warn", `API request rejected (HTTP ${res.statusCode}).`, { category: "system", httpStatus: res.statusCode });
    });
  }
  if (["/lastfm/single-scrobble", "/lastfm/now-playing"].includes(req.path) && req.method === "POST") {
    if (typeof req.body.artist !== "string" || !req.body.artist.trim() || typeof req.body.track !== "string" || !req.body.track.trim()) return res.status(400).json({ ok: false, error: "Artist and track are required." });
    if (req.path.endsWith("single-scrobble") && req.body.timestamp !== void 0 && (!Number.isInteger(Number(req.body.timestamp)) || Number(req.body.timestamp) > Math.floor(Date.now() / 1e3) || Number(req.body.timestamp) < Math.floor(Date.now() / 1e3) - 14 * 86400)) return res.status(400).json({ ok: false, error: "Timestamp must be within the past 14 days." });
    if (instantRunning || batchRunning || inFlight || ["running", "rate_limited", "paused"].includes(activeJob.status)) return res.status(409).json({ ok: false, error: "Stop the active worker before submitting an instant action." });
    instantRunning = true;
  }
  next();
});
app.get("/api/activity", (req, res) => res.json({ ok: true, ...readActivity({ before: Number(req.query.before) || void 0, after: Number(req.query.after) || void 0, limit: Number(req.query.limit) || 100, level: String(req.query.level || "all"), search: String(req.query.search || "") }) }));
app.get("/api/activity/summary", (_req, res) => res.json({ ok: true, summary: { ...activitySummary(), cooldownResumeAt } }));
app.get("/api/activity/export", async (_req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="scrobbleforge-activity.ndjson"');
  try {
    for (const record of exportActivity()) {
      if (res.destroyed) break;
      if (!res.write(JSON.stringify(record) + "\n")) await new Promise((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.once("drain", done);
        res.once("close", done);
      });
    }
    res.end();
  } catch {
    res.destroy();
  }
});
app.post("/api/lastfm/disconnect", (_req, res) => {
  if (jobTimeoutHandle) clearTimeout(jobTimeoutHandle);
  activeJob.status = "idle";
  batchCancel = true;
  workerCredentials = null;
  addLog("info", "Account disconnected; worker stopped and server credentials cleared.", { category: "auth" });
  res.json({ ok: true });
});
app.get("/api/job/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.push(res);
  res.write(`event: status
data: ${JSON.stringify(getJobStatusPayload())}

`);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15e3);
  req.on("close", () => {
    clearInterval(heartbeat);
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
  if (inFlight || instantRunning || batchRunning || ["running", "rate_limited"].includes(activeJob.status)) return res.status(409).json({ ok: false, error: "Pause or stop active submissions before changing credentials." });
  try {
    const { apiKey, apiSecret, username, password, sessionKey } = req.body;
    if ([apiKey, apiSecret, username, password, sessionKey].some((value) => value !== void 0 && typeof value !== "string")) return res.status(400).json({ ok: false, error: "Authentication fields must be strings." });
    const resolvedApiKey = (apiKey || ENV_API_KEY || "").trim();
    const resolvedApiSecret = (apiSecret || ENV_API_SECRET || "").trim();
    if (!resolvedApiKey || !resolvedApiSecret) {
      return res.status(400).json({ ok: false, error: "API Key and API Secret are required." });
    }
    if (sessionKey && username) {
      const userInfo = await callLastFmApi(
        { method: "user.getInfo", sk: sessionKey, api_key: resolvedApiKey },
        resolvedApiSecret,
        "GET"
      );
      if (userInfo.data?.user?.name?.toLowerCase() === username.toLowerCase()) {
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
          { method: "user.getInfo", user: userName, api_key: resolvedApiKey },
          void 0,
          "GET"
        );
        if (infoRes.data && infoRes.data.user) {
          userProfile = infoRes.data.user;
        }
      } catch {
      }
      workerCredentials = {
        apiKey: resolvedApiKey,
        apiSecret: resolvedApiSecret,
        sessionKey: key,
        username: userName
      };
      addLog("success", "Last.fm authentication established.", { category: "auth" });
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
    return respondError(res, err);
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
    return respondError(res, err);
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
    return respondError(res, err);
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
          if (type === "recents" && item["@attr"]?.nowplaying === "true") continue;
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
        throw new LastFmError(502, void 0, "Last.fm returned an incomplete profile page.");
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
    return respondError(res, err);
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
    return respondError(res, err);
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
    return respondError(res, err);
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
    return respondError(res, err);
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
    return respondError(res, err);
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
    return respondError(res, err);
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
    return respondError(res, err);
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
    return respondError(res, err);
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
    return respondError(res, err);
  } finally {
    instantRunning = false;
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
    return res.status(response.accepted ? 200 : 422).json({ ok: response.accepted > 0, accepted: response.accepted, ignored: response.ignored, error: response.ignored ? "Last.fm ignored this track. See activity details." : void 0, data: response.data });
  } catch (err) {
    return respondError(res, err);
  } finally {
    instantRunning = false;
  }
});
var instantRunning = false;
var batchRunning = false;
var batchCancel = false;
var batchProgress = { id: "", total: 0, accepted: 0, ignored: 0, status: "idle" };
app.get("/api/job/batch-status", (_req, res) => res.json({ ok: true, batch: batchProgress }));
app.post("/api/job/cancel-batch", (_req, res) => {
  batchCancel = true;
  addLog("warn", "Batch cancellation requested; any in-flight chunk will finish first.");
  res.json({ ok: true });
});
app.post("/api/job/batch-scrobble-all", async (req, res) => {
  if (instantRunning || batchRunning || ["running", "rate_limited", "paused"].includes(activeJob.status) || inFlight) return res.status(409).json({ ok: false, error: "Stop the active job or batch before starting another submission." });
  batchRunning = true;
  batchCancel = false;
  let completed = 0, ignored = 0;
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
    if (!Array.isArray(tracks) || tracks.length === 0 || tracks.length > 5e3 || tracks.some((t) => typeof t?.name !== "string" || !t.name.trim() || typeof t.artist !== "string" || !t.artist.trim())) {
      return res.status(400).json({ ok: false, error: "No tracks provided for batch scrobbling." });
    }
    const batchId = crypto2.randomUUID();
    const totalToScrobble = tracks.length;
    batchProgress = { id: batchId, total: tracks.length, accepted: 0, ignored: 0, status: "running" };
    const now = Math.floor(Date.now() / 1e3);
    const resolvedEnd = endTime ? Math.min(now, Math.floor(endTime)) : now;
    const resolvedStart = startTime ? Math.floor(startTime) : resolvedEnd - Math.max(60, (spanHours || 24) * 3600);
    if (!Number.isFinite(resolvedStart) || !Number.isFinite(resolvedEnd) || resolvedStart < now - 14 * 86400 || resolvedStart >= resolvedEnd || !Number.isFinite(Number(spanHours || 24))) return res.status(400).json({ ok: false, error: "Choose a valid past time range within 14 days." });
    const spanDuration = resolvedEnd - resolvedStart;
    if (spanDuration < tracks.length) return res.status(400).json({ ok: false, error: "Time range is too short for unique track timestamps." });
    const stepSeconds = spanDuration / totalToScrobble;
    const batchSize = 50;
    addLog(
      "info",
      `\u{1F680} Commencing batch scrobble: ${totalToScrobble} tracks distributed across time range (${new Date(
        resolvedStart * 1e3
      ).toLocaleTimeString()} to ${new Date(resolvedEnd * 1e3).toLocaleTimeString()}).`
    );
    for (let i = 0; i < totalToScrobble; i += batchSize) {
      if (batchCancel) {
        batchProgress.status = "cancelled";
        return res.json({ ok: false, cancelled: true, completed, ignored, error: "Batch cancelled. Previously accepted tracks are retained." });
      }
      const currentChunk = tracks.slice(i, i + batchSize);
      const params = {
        method: "track.scrobble",
        api_key: resolvedApiKey,
        sk: resolvedSession
      };
      currentChunk.forEach((t, idx) => {
        const itemGlobalIndex = i + idx;
        const itemTimestamp = Math.floor(resolvedStart + itemGlobalIndex * stepSeconds);
        params[`artist[${idx}]`] = t.artist;
        params[`track[${idx}]`] = t.name;
        params[`timestamp[${idx}]`] = itemTimestamp.toString();
        if (t.album) {
          params[`album[${idx}]`] = t.album;
        }
      });
      const response = await callLastFmApi(params, resolvedSecret, "POST", batchId);
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
      completed += response.accepted;
      ignored += response.ignored;
      batchProgress.accepted = completed;
      batchProgress.ignored = ignored;
      if (response.dailyLimited) {
        batchProgress.status = "error";
        return res.status(422).json({ ok: false, completed, ignored, errorCode: 29, error: "Last.fm daily scrobble limit reached. Remaining chunks were not submitted." });
      }
      addLog(
        "success",
        `Batch chunk confirmed: ${response.accepted} accepted, ${response.ignored} ignored (${completed} accepted overall).`
      );
      if (i + batchSize < totalToScrobble) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    addLog("success", `\u{1F389} Batch scrobble complete! Total ${completed} songs added to Last.fm.`);
    batchProgress.status = "completed";
    return res.json({ ok: ignored === 0, completed, ignored, error: ignored ? `${ignored} tracks were ignored; see activity history.` : void 0 });
  } catch (err) {
    batchProgress.status = "error";
    const e = err instanceof LastFmError ? err : new LastFmError(500, void 0, "Batch failed; check activity history.");
    if (e.retryAfterSeconds) res.setHeader("Retry-After", String(e.retryAfterSeconds));
    return res.status(e.status).json({ ok: false, error: e.message, errorCode: e.code, completed, ignored, retryAfterSeconds: e.retryAfterSeconds, uncertain: e.uncertain });
  } finally {
    batchRunning = false;
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
  if (instantRunning || batchRunning || inFlight || ["running", "rate_limited", "paused"].includes(activeJob.status)) {
    return res.status(400).json({ ok: false, error: "A scrobble job is already running." });
  }
  if (credentials?.apiKey && credentials?.apiSecret && credentials?.sessionKey) {
    workerCredentials = credentials;
  }
  if (isDryRun !== true && (!workerCredentials || !workerCredentials.sessionKey)) {
    return res.status(400).json({
      ok: false,
      error: "Please connect Last.fm credentials before starting live scrobbles."
    });
  }
  if (jobTimeoutHandle) {
    clearTimeout(jobTimeoutHandle);
    jobTimeoutHandle = null;
  }
  const resolvedQueue = Array.isArray(queue) ? queue.map((t) => ({ id: typeof t?.id === "string" ? t.id : crypto2.randomUUID(), name: t?.name, artist: t?.artist, album: typeof t?.album === "string" ? t.album : "", duration: typeof t?.duration === "number" && Number.isFinite(t.duration) && t.duration > 0 ? t.duration : 180, image: typeof t?.image === "string" && t.image.startsWith("https://") ? t.image : void 0 })) : [];
  if (resolvedQueue.length > 5e3 || resolvedQueue.some((t) => typeof t?.name !== "string" || !t.name.trim() || typeof t.artist !== "string" || !t.artist.trim()) || queueMode && !["single_loop", "queue_once", "queue_loop"].includes(queueMode) || !resolvedQueue.length && queueMode && queueMode !== "single_loop" || !resolvedQueue.length && (typeof artist !== "string" || !artist.trim() || typeof track !== "string" || !track.trim()) || album !== void 0 && typeof album !== "string" || interval !== void 0 && (!Number.isFinite(Number(interval)) || Number(interval) < 0.5 || Number(interval) > 3600) || limit !== void 0 && (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 5e4)) return res.status(400).json({ ok: false, error: "Invalid track, queue, limit (1\u201350000), or interval (0.5\u20133600s)." });
  const resolvedQueueMode = queueMode || (resolvedQueue.length > 0 ? "queue_once" : "single_loop");
  const resolvedLimit = resolvedQueueMode === "queue_once" ? resolvedQueue.length : Math.max(1, parseInt(limit, 10) || 1800);
  activeJob = {
    jobId: crypto2.randomUUID(),
    ignoredCount: 0,
    simulatedCount: 0,
    status: "running",
    artist: (artist || "rvaia").trim(),
    track: (track || "kill bill").trim(),
    album: (album || "kill bill").trim(),
    limit: resolvedLimit,
    interval: Math.max(0.5, parseFloat(interval) || 2),
    jitter: jitter !== false,
    isDryRun: isDryRun === true,
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
    logs: readActivity({ limit: 100 }).logs
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
    if (inFlight) return res.status(409).json({ ok: false, error: "Wait for the in-flight submission to finish." });
    activeJob.status = cooldownResumeAt && cooldownResumeAt > Date.now() ? "rate_limited" : "running";
    activeJob.rateLimitResumeAt = activeJob.status === "rate_limited" ? cooldownResumeAt : null;
    addLog("info", "Job resumed; active cooldowns are preserved.");
    if (activeJob.status === "rate_limited") scheduleCooldown();
    else void executeScrobbleStep();
    return res.json({ ok: true, job: getJobStatusPayload() });
  }
  return res.status(400).json({ ok: false, error: "Job is not paused." });
});
app.post("/api/job/stop", (_req, res) => {
  batchCancel = true;
  if (jobTimeoutHandle) {
    clearTimeout(jobTimeoutHandle);
    jobTimeoutHandle = null;
  }
  activeJob.status = "idle";
  activeJob.rateLimitResumeAt = null;
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
  addLog("info", "Console view cleared; persisted activity history retained.");
  return res.json({ ok: true });
});
app.use("/api", (err, _req, res, _next) => {
  addLog("error", "API request rejected or internal handler failed.", { category: "system", httpStatus: err.status || 500, outcome: "failed" });
  res.status(err.status || 500).json({ ok: false, error: err.status === 400 ? "Invalid JSON request." : "Request failed; check activity history." });
});
app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "Unknown API endpoint." }));
async function startServer() {
  const isDev = process.env.NODE_ENV !== "production" && path2.extname(__filename) === ".ts";
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
    const distPath = path2.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path2.join(distPath, "index.html"));
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
