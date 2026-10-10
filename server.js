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
    requestId TEXT, outcome TEXT, owner TEXT, record TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS activity_time ON activity(timestamp);
  CREATE INDEX IF NOT EXISTS activity_level ON activity(level, seq);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
var activityColumns = activityDb.prepare("PRAGMA table_info(activity)").all().map((column) => String(column.name));
if (!activityColumns.includes("owner")) activityDb.exec("ALTER TABLE activity ADD COLUMN owner TEXT");
activityDb.exec("CREATE INDEX IF NOT EXISTS activity_owner ON activity(owner, seq)");
var retentionDays = Math.max(1, Number(process.env.ACTIVITY_RETENTION_DAYS) || 90);
var lastPruned = 0;
function recordActivity(owner, level, message, extra = {}) {
  const record = { id: crypto.randomUUID(), timestamp: Date.now(), level, message: message.slice(0, 1500), category: extra.category || "job" };
  for (const key of ["track", "artist", "album", "count", "total", "operation", "jobId", "requestId", "outcome", "httpStatus", "errorCode", "durationMs", "retryAfterSeconds", "accepted", "ignored", "attempted", "scrobbleTimestamp"]) {
    if (extra[key] !== void 0) Object.assign(record, { [key]: extra[key] });
  }
  const result = activityDb.prepare("INSERT INTO activity(id,timestamp,level,category,operation,jobId,requestId,outcome,owner,record) VALUES(?,?,?,?,?,?,?,?,?,?)").run(record.id, record.timestamp, level, record.category, record.operation || null, record.jobId || null, record.requestId || null, record.outcome || null, owner, JSON.stringify(record));
  record.seq = Number(result.lastInsertRowid);
  if (Date.now() - lastPruned > 36e5) {
    activityDb.prepare("DELETE FROM activity WHERE timestamp < ?").run(Date.now() - retentionDays * 864e5);
    lastPruned = Date.now();
  }
  return record;
}
function readActivity(owner, options = {}) {
  const conditions = ["owner = ?"];
  const values = [owner];
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
function activitySummary(owner) {
  const row = activityDb.prepare(`SELECT COUNT(*) totalEvents,
    COALESCE(SUM(CASE WHEN outcome='accepted' THEN json_extract(record,'$.accepted') ELSE 0 END),0) accepted,
    COALESCE(SUM(CASE WHEN category='api' THEN json_extract(record,'$.ignored') ELSE 0 END),0) ignored,
    SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) failedRequests,
    SUM(CASE WHEN outcome='rate_limited' THEN 1 ELSE 0 END) rateLimitHits,
    SUM(CASE WHEN outcome='uncertain' THEN 1 ELSE 0 END) uncertainRequests,
    SUM(CASE WHEN outcome='attempt' THEN 1 ELSE 0 END) requests,
    SUM(CASE WHEN outcome='simulated' THEN 1 ELSE 0 END) simulated,
    COALESCE(SUM(CASE WHEN outcome='played' THEN 1 ELSE 0 END),0) played,
    MIN(timestamp) oldestAt, MAX(timestamp) latestAt FROM activity WHERE owner = ?`).get(owner);
  return { ...row, retentionDays, storage: "sqlite", healthy: true };
}
function* exportActivity(owner) {
  for (const row of activityDb.prepare("SELECT seq,record FROM activity WHERE owner = ? ORDER BY seq").iterate(owner)) {
    yield { ...JSON.parse(String(row.record)), seq: Number(row.seq) };
  }
}
function saveCheckpoint(owner, job) {
  activityDb.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`job:${owner}`, JSON.stringify(job));
}
function loadCheckpoint(owner) {
  const row = activityDb.prepare("SELECT value FROM settings WHERE key = ?").get(`job:${owner}`);
  return row ? JSON.parse(String(row.value)) : null;
}

// server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path2.dirname(__filename);
var app = express();
var PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3e3;
var LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
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
async function callLastFmApi(session, params, apiSecret, method = "POST", jobId) {
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
  if (session.cooldownResumeAt && session.cooldownResumeAt > Date.now()) {
    const seconds = Math.ceil((session.cooldownResumeAt - Date.now()) / 1e3);
    session.addLog("warn", `${operation} deferred during Last.fm cooldown (${seconds}s remaining).`, { ...context, outcome: "deferred", retryAfterSeconds: seconds });
    throw new LastFmError(429, 26, "Last.fm cooldown is active. Try again after the countdown.", seconds);
  }
  const started = Date.now();
  const attempted = operation === "track.scrobble" ? Object.keys(params).filter((k) => /^track\[\d+\]$/.test(k)).length : 0;
  session.addLog("info", `Request started: ${operation}${attempted ? ` (${attempted} tracks)` : ""}.`, { ...context, outcome: "attempt", attempted });
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
      session.cooldownResumeAt = Math.max(session.cooldownResumeAt || 0, Date.now() + seconds * 1e3);
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
        session.addLog(ignoredCode === 5 ? "rate_limit" : ignoredCode ? "warn" : "success", ignoredCode ? `Track ignored: ${reasons[ignoredCode] || `reason ${ignoredCode}`}.` : "Track confirmed accepted by Last.fm.", {
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
    session.addLog(ignored ? "warn" : "success", operation === "track.scrobble" ? `Last.fm confirmed ${accepted} accepted, ${ignored} ignored.` : `Request completed: ${operation}.`, {
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
    session.addLog(e.status === 429 || e.code === 29 ? "rate_limit" : "error", e.message, { ...context, outcome: e.status === 429 || e.code === 29 ? "rate_limited" : e.uncertain ? "uncertain" : "failed", httpStatus: upstreamStatus, errorCode: e.code, retryAfterSeconds: e.retryAfterSeconds || void 0, durationMs: Date.now() - started });
    throw e;
  }
}
var DEFAULT_JOB = () => ({
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
});
var DEFAULT_PLAYER = () => ({
  apiFree: true,
  sessionId: null,
  status: "idle",
  queue: [],
  currentIndex: 0,
  activeTrack: null,
  trackDurationSeconds: 30,
  remainingMs: 0,
  loopQueue: true,
  shuffle: false,
  playsCompleted: 0,
  trackStartedAt: null,
  trackEndsAt: null,
  lastPlayAt: null,
  startedAt: null,
  stoppedReason: null
});
var ForgeSession = class {
  constructor(owner) {
    this.lastSeen = Date.now();
    this.credentials = null;
    this.cooldownResumeAt = null;
    this.job = DEFAULT_JOB();
    this.jobTimeout = null;
    this.inFlight = false;
    this.instantRunning = false;
    this.batchRunning = false;
    this.batchCancel = false;
    this.batchProgress = { id: "", total: 0, accepted: 0, ignored: 0, status: "idle" };
    this.sse = [];
    this.player = DEFAULT_PLAYER();
    this.playerTimeout = null;
    this.owner = owner;
    const restored = loadCheckpoint(owner);
    if (restored) {
      this.cooldownResumeAt = restored.cooldownResumeAt || null;
      this.job = { ...this.job, ...restored, logs: readActivity(owner, { limit: 100 }).logs };
      if (["running", "rate_limited"].includes(this.job.status)) {
        this.job.status = "paused";
        this.addLog("warn", "Server restarted. Previous progress restored and paused; confirm before resuming. An in-flight submission may be uncertain.", { category: "system" });
      }
    }
  }
  touch() {
    this.lastSeen = Date.now();
  }
  addLog(level, message, extra) {
    const log = recordActivity(this.owner, level, message, { jobId: extra?.category === "api" ? void 0 : this.job.jobId, ...extra });
    this.job.logs.push(log);
    if (this.job.logs.length > 100) this.job.logs.shift();
    saveCheckpoint(this.owner, { ...this.job, cooldownResumeAt: this.cooldownResumeAt, logs: [] });
    this.emitSSE("log", log);
    this.emitSSE("status", this.jobStatusPayload());
  }
  jobStatusPayload() {
    return { ...this.job, logs: this.job.logs.slice(-100), cooldownResumeAt: this.cooldownResumeAt };
  }
  emitSSE(event, data) {
    const payload = `event: ${event}
data: ${JSON.stringify(data)}

`;
    for (let i = this.sse.length - 1; i >= 0; i--) {
      try {
        this.sse[i].write(payload);
      } catch {
        this.sse.splice(i, 1);
      }
    }
  }
  async executeScrobbleStep() {
    if (this.job.status !== "running" || this.inFlight) return;
    const executingJob = this.job;
    const isQueueMode = this.job.queue.length > 0 && this.job.queueMode !== "single_loop";
    if (this.job.scrobblesCompleted + (this.job.ignoredCount || 0) + (this.job.simulatedCount || 0) >= this.job.limit) {
      this.job.status = "completed";
      this.addLog("success", `Job finished: ${this.job.scrobblesCompleted} accepted, ${this.job.ignoredCount || 0} ignored, ${this.job.simulatedCount || 0} simulated.`);
      this.emitSSE("completed", this.jobStatusPayload());
      return;
    }
    if (isQueueMode && this.job.queueMode === "queue_once" && this.job.currentQueueIndex >= this.job.queue.length) {
      this.job.status = "completed";
      this.addLog("success", `\u{1F389} Full queue completed! Finished all ${this.job.queue.length} tracks.`);
      this.emitSSE("completed", this.jobStatusPayload());
      return;
    }
    let currentArtist = this.job.artist;
    let currentTrackName = this.job.track;
    let currentAlbum = this.job.album;
    if (isQueueMode) {
      const trackItem = this.job.queue[this.job.currentQueueIndex];
      if (trackItem) {
        currentArtist = trackItem.artist;
        currentTrackName = trackItem.name;
        currentAlbum = trackItem.album || "";
      }
    }
    const currentCount = this.job.scrobblesCompleted + (this.job.ignoredCount || 0) + (this.job.simulatedCount || 0) + 1;
    const targetLimit = this.job.limit;
    if (this.job.isDryRun) {
      this.job.simulatedCount = (this.job.simulatedCount || 0) + 1;
      this.addLog(
        "info",
        `[DRY RUN] Simulated scrobble for "${currentTrackName}" by ${currentArtist} (${currentCount}/${targetLimit})`,
        { artist: currentArtist, track: currentTrackName, album: currentAlbum, count: currentCount, total: targetLimit, outcome: "simulated" }
      );
      this.advanceQueueIndex();
      saveCheckpoint(this.owner, { ...this.job, cooldownResumeAt: this.cooldownResumeAt, logs: [] });
      this.scheduleNextStep();
      return;
    }
    if (!this.credentials || !this.credentials.sessionKey) {
      this.job.status = "error";
      this.job.currentError = "Missing Last.fm authentication session.";
      this.addLog("error", "Authentication failed: No valid Last.fm session key.");
      return;
    }
    try {
      const timestamp = Math.floor(Date.now() / 1e3);
      const params = {
        method: "track.scrobble",
        api_key: this.credentials.apiKey,
        sk: this.credentials.sessionKey,
        "artist[0]": currentArtist,
        "track[0]": currentTrackName,
        "timestamp[0]": timestamp.toString()
      };
      if (currentAlbum) params["album[0]"] = currentAlbum;
      this.inFlight = true;
      const response = await callLastFmApi(this, params, this.credentials.apiSecret, "POST", executingJob.jobId);
      if (this.job !== executingJob) return;
      this.job.scrobblesCompleted += response.accepted;
      this.job.ignoredCount = (this.job.ignoredCount || 0) + response.ignored;
      if (response.accepted) this.job.lastScrobbleTime = Date.now();
      this.addLog(
        response.accepted ? "success" : "warn",
        response.accepted ? `Scrobbled "${currentTrackName}" by ${currentArtist}.` : `Last.fm ignored "${currentTrackName}"; queue advanced without adding to accepted count.`,
        { artist: currentArtist, track: currentTrackName, album: currentAlbum, count: this.job.scrobblesCompleted, total: targetLimit }
      );
      this.advanceQueueIndex();
      if (response.dailyLimited) {
        this.job.status = "error";
        this.job.currentError = "Last.fm daily scrobble limit reached. Stop and wait before submitting more.";
        this.addLog("error", this.job.currentError);
      }
      this.scheduleNextStep();
    } catch (err) {
      if (this.job !== executingJob) return;
      if (err instanceof LastFmError && err.status === 429) {
        this.job.rateLimitResumeAt = this.cooldownResumeAt;
        this.job.rateLimitCooldownSeconds = err.retryAfterSeconds;
        if (this.job.status === "running") {
          this.job.status = "rate_limited";
          this.scheduleCooldown();
        }
        this.addLog("warn", "Worker is waiting for the recorded Last.fm cooldown; this track was not accepted.");
      } else {
        this.job.failedCount += 1;
        if (this.job.status === "running") this.job.status = "error";
        this.job.currentError = err instanceof LastFmError ? err.message : "Scrobble failed.";
        this.addLog("error", this.job.currentError);
      }
    } finally {
      this.inFlight = false;
      saveCheckpoint(this.owner, { ...this.job, cooldownResumeAt: this.cooldownResumeAt, logs: [] });
      this.emitSSE("status", this.jobStatusPayload());
    }
  }
  scheduleCooldown() {
    if (this.jobTimeout) clearTimeout(this.jobTimeout);
    this.jobTimeout = setTimeout(() => {
      if (this.job.status !== "rate_limited") return;
      if (this.cooldownResumeAt && this.cooldownResumeAt > Date.now()) {
        this.scheduleCooldown();
        return;
      }
      this.job.status = "running";
      this.job.rateLimitResumeAt = null;
      this.job.rateLimitCooldownSeconds = 0;
      this.addLog("info", "Cooldown completed. Resuming the unaccepted track.");
      void this.executeScrobbleStep();
    }, Math.max(1, (this.cooldownResumeAt || Date.now()) - Date.now()));
  }
  advanceQueueIndex() {
    if (this.job.queue.length > 0 && this.job.queueMode !== "single_loop") {
      this.job.currentQueueIndex += 1;
      if (this.job.currentQueueIndex >= this.job.queue.length) {
        if (this.job.queueMode === "queue_loop") {
          this.job.currentQueueIndex = 0;
        }
      }
    }
  }
  scheduleNextStep() {
    if (this.job.status !== "running") return;
    let delay = this.job.interval * 1e3;
    if (this.job.jitter) {
      const jitterMs = (Math.random() - 0.5) * 1e3;
      delay = Math.max(500, delay + jitterMs);
    }
    this.jobTimeout = setTimeout(() => {
      void this.executeScrobbleStep();
    }, delay);
  }
  // --- AutoPlayer: local playback journaling, still scoped to this visitor. ---
  playerStatusPayload() {
    return { ...this.player, activeTrack: this.player.activeTrack ? { ...this.player.activeTrack } : null };
  }
  emitPlayerState() {
    this.emitSSE("player", this.playerStatusPayload());
  }
  clearPlayerTimer() {
    if (this.playerTimeout) {
      clearTimeout(this.playerTimeout);
      this.playerTimeout = null;
    }
  }
  stopPlayer(reason, status = "idle") {
    this.clearPlayerTimer();
    this.player.status = status;
    this.player.activeTrack = null;
    this.player.trackStartedAt = null;
    this.player.trackEndsAt = null;
    this.player.remainingMs = 0;
    this.player.stoppedReason = reason;
    this.emitPlayerState();
  }
  schedulePlayerStep(ms) {
    this.clearPlayerTimer();
    this.playerTimeout = setTimeout(() => this.completePlay(), Math.max(25, ms));
  }
  startPlay() {
    if (this.player.status !== "playing") return;
    if (!this.player.queue.length) {
      this.stopPlayer("The queue is empty.", "completed");
      return;
    }
    if (this.player.currentIndex >= this.player.queue.length) {
      if (!this.player.loopQueue) {
        this.stopPlayer(`Queue finished after ${this.player.playsCompleted} tracked plays.`, "completed");
        return;
      }
      this.player.currentIndex = 0;
    }
    const track = this.player.queue[this.player.currentIndex];
    this.player.remainingMs = this.player.trackDurationSeconds * 1e3;
    this.player.activeTrack = track;
    this.player.trackStartedAt = Date.now();
    this.player.trackEndsAt = this.player.trackStartedAt + this.player.remainingMs;
    this.player.stoppedReason = null;
    this.emitPlayerState();
    this.schedulePlayerStep(this.player.remainingMs);
  }
  completePlay() {
    if (this.player.status !== "playing" || !this.player.activeTrack) return;
    const track = this.player.activeTrack;
    const durationMs = this.player.trackStartedAt ? Date.now() - this.player.trackStartedAt : this.player.trackDurationSeconds * 1e3;
    this.player.playsCompleted += 1;
    this.player.lastPlayAt = Date.now();
    recordActivity(this.owner, "info", `AutoPlayer completed play ${this.player.playsCompleted}: "${track.name}" by ${track.artist}. Tracked locally - no Last.fm API call was made.`, {
      category: "player",
      track: track.name,
      artist: track.artist,
      album: track.album,
      outcome: "played",
      count: this.player.playsCompleted,
      total: this.player.queue.length,
      jobId: this.player.sessionId || void 0,
      durationMs
    });
    this.player.currentIndex += 1;
    this.player.activeTrack = null;
    this.emitPlayerState();
    this.startPlay();
  }
  pausePlayer() {
    if (this.player.status !== "playing") return false;
    this.clearPlayerTimer();
    this.player.remainingMs = this.player.trackEndsAt ? Math.max(25, this.player.trackEndsAt - Date.now()) : this.player.remainingMs;
    this.player.status = "paused";
    this.emitPlayerState();
    return true;
  }
  resumePlayer() {
    if (this.player.status !== "paused") return false;
    this.player.status = "playing";
    this.player.trackEndsAt = Date.now() + this.player.remainingMs;
    this.emitPlayerState();
    this.schedulePlayerStep(this.player.remainingMs);
    return true;
  }
  dispose() {
    if (this.jobTimeout) {
      clearTimeout(this.jobTimeout);
      this.jobTimeout = null;
    }
    if (this.playerTimeout) {
      clearTimeout(this.playerTimeout);
      this.playerTimeout = null;
    }
    for (const response of this.sse) {
      try {
        response.end();
      } catch {
      }
    }
    this.sse = [];
  }
};
function shuffled(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = crypto2.randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
var SESSION_COOKIE = "sforge_session";
var SESSION_IDLE_MS = 12 * 60 * 60 * 1e3;
var MAX_SESSIONS = 400;
var sessions = /* @__PURE__ */ new Map();
function readSessionCookie(header) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}
function ensureSessionOwner(req, res) {
  const existing = readSessionCookie(req.headers.cookie);
  if (existing && /^[0-9a-fA-F-]{36}$/.test(existing)) return existing;
  const owner = crypto2.randomUUID();
  res.append("Set-Cookie", `${SESSION_COOKIE}=${owner}; Path=/; SameSite=Lax; HttpOnly`);
  return owner;
}
function getSession(owner) {
  const existing = sessions.get(owner);
  if (existing) {
    existing.touch();
    return existing;
  }
  const session = new ForgeSession(owner);
  sessions.set(owner, session);
  return session;
}
function sweepSessions() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [owner, session] of sessions) {
    if (session.lastSeen < cutoff || sessions.size > MAX_SESSIONS) {
      if (session.lastSeen >= cutoff && sessions.size <= MAX_SESSIONS) continue;
      session.dispose();
      sessions.delete(owner);
    }
  }
}
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  const owner = ensureSessionOwner(req, res);
  req.owner = owner;
  req.forge = getSession(owner);
  if (sessions.size > 100) sweepSessions();
  if (req.method !== "GET" && req.headers.origin) {
    const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : req.protocol;
    if (req.headers.origin !== `${protocol}://${req.get("host")}`) {
      req.forge.addLog("warn", "Cross-origin API mutation refused.", { category: "system", httpStatus: 403 });
      return res.status(403).json({ ok: false, error: "Cross-origin mutation refused." });
    }
  }
  if (!req.path.startsWith("/activity") && req.path !== "/job/events") {
    res.on("finish", () => {
      if (res.statusCode >= 400 && res.statusCode !== 429) req.forge.addLog("warn", `API request rejected (HTTP ${res.statusCode}).`, { category: "system", httpStatus: res.statusCode });
    });
  }
  if (["/lastfm/single-scrobble", "/lastfm/now-playing"].includes(req.path) && req.method === "POST") {
    if (typeof req.body.artist !== "string" || !req.body.artist.trim() || typeof req.body.track !== "string" || !req.body.track.trim()) return res.status(400).json({ ok: false, error: "Artist and track are required." });
    if (req.path.endsWith("single-scrobble") && req.body.timestamp !== void 0 && (!Number.isInteger(Number(req.body.timestamp)) || Number(req.body.timestamp) > Math.floor(Date.now() / 1e3) || Number(req.body.timestamp) < Math.floor(Date.now() / 1e3) - 14 * 86400)) return res.status(400).json({ ok: false, error: "Timestamp must be within the past 14 days." });
    if (req.forge.instantRunning || req.forge.batchRunning || req.forge.inFlight || ["running", "rate_limited", "paused"].includes(req.forge.job.status)) return res.status(409).json({ ok: false, error: "Stop the active worker before submitting an instant action." });
    req.forge.instantRunning = true;
  }
  next();
});
app.get("/api/identity", (req, res) => {
  const legacy = activityDb.prepare("SELECT COUNT(*) count FROM activity WHERE owner IS NULL").get();
  return res.json({ ok: true, owner: req.forge.owner, legacyRows: Number(legacy?.count || 0) });
});
app.get("/api/activity", (req, res) => res.json({ ok: true, ...readActivity(req.forge.owner, { before: Number(req.query.before) || void 0, after: Number(req.query.after) || void 0, limit: Number(req.query.limit) || 100, level: String(req.query.level || "all"), search: String(req.query.search || "") }) }));
app.get("/api/activity/summary", (req, res) => res.json({ ok: true, summary: { ...activitySummary(req.forge.owner), cooldownResumeAt: req.forge.cooldownResumeAt } }));
app.get("/api/activity/export", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="scrobbleforge-activity.ndjson"');
  try {
    for (const record of exportActivity(req.forge.owner)) {
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
app.post("/api/lastfm/disconnect", (req, res) => {
  if (req.forge.jobTimeout) clearTimeout(req.forge.jobTimeout);
  req.forge.job.status = "idle";
  req.forge.batchCancel = true;
  req.forge.credentials = null;
  req.forge.addLog("info", "Disconnected; the credentials held for this browser were cleared and its worker stopped.", { category: "auth" });
  res.json({ ok: true });
});
app.get("/api/job/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  req.forge.sse.push(res);
  res.write(`event: status
data: ${JSON.stringify(req.forge.jobStatusPayload())}

`);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15e3);
  req.on("close", () => {
    clearInterval(heartbeat);
    const idx = req.forge.sse.indexOf(res);
    if (idx !== -1) req.forge.sse.splice(idx, 1);
  });
});
app.post("/api/lastfm/auth", async (req, res) => {
  if (req.forge.inFlight || req.forge.instantRunning || req.forge.batchRunning || ["running", "rate_limited"].includes(req.forge.job.status)) return res.status(409).json({ ok: false, error: "Pause or stop active submissions before changing credentials." });
  try {
    const { apiKey, apiSecret, username, password, sessionKey } = req.body;
    if ([apiKey, apiSecret, username, password, sessionKey].some((value) => value !== void 0 && typeof value !== "string")) return res.status(400).json({ ok: false, error: "Authentication fields must be strings." });
    const resolvedApiKey = (apiKey || "").trim();
    const resolvedApiSecret = (apiSecret || "").trim();
    if (!resolvedApiKey || !resolvedApiSecret) {
      return res.status(400).json({ ok: false, error: "API Key and API Secret are required." });
    }
    if (sessionKey && username) {
      const userInfo = await callLastFmApi(
        req.forge,
        { method: "user.getInfo", sk: sessionKey, api_key: resolvedApiKey },
        resolvedApiSecret,
        "GET"
      );
      if (userInfo.data?.user?.name?.toLowerCase() === username.toLowerCase()) {
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
    const authRes = await callLastFmApi(req.forge, params, resolvedApiSecret, "POST");
    if (authRes.data && authRes.data.session) {
      const key = authRes.data.session.key;
      const userName = authRes.data.session.name;
      let userProfile = null;
      try {
        const infoRes = await callLastFmApi(
          req.forge,
          { method: "user.getInfo", user: userName, api_key: resolvedApiKey },
          void 0,
          "GET"
        );
        if (infoRes.data && infoRes.data.user) {
          userProfile = infoRes.data.user;
        }
      } catch {
      }
      req.forge.addLog("success", "Last.fm authentication established.", { category: "auth" });
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
    const apiKey = req.query.apiKey || "";
    const username = req.query.username || "";
    if (!apiKey || !username) {
      return res.status(400).json({ ok: false, error: "API Key and username required" });
    }
    const response = await callLastFmApi(
      req.forge,
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
    const apiKey = req.query.apiKey || "";
    const username = req.query.username || "";
    const limit = req.query.limit || "15";
    if (!apiKey || !username) {
      return res.status(400).json({ ok: false, error: "API Key and username required" });
    }
    const response = await callLastFmApi(
      req.forge,
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
    const apiKey = req.query.apiKey || "";
    const username = req.query.username || "";
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
      const response = await callLastFmApi(req.forge, params, void 0, "GET");
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
    const apiKey = req.query.apiKey || "";
    const artist = req.query.artist;
    const limit = Math.min(200, Math.max(5, parseInt(req.query.limit, 10) || 50));
    if (!apiKey || !artist) {
      return res.status(400).json({ ok: false, error: "API key and artist are required." });
    }
    const response = await callLastFmApi(
      req.forge,
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
    const apiKey = req.query.apiKey || "";
    const artist = req.query.artist;
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 30));
    if (!apiKey || !artist) {
      return res.status(400).json({ ok: false, error: "API key and artist are required." });
    }
    const response = await callLastFmApi(
      req.forge,
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
    const apiKey = req.query.apiKey || "";
    const artist = req.query.artist;
    const album = req.query.album;
    if (!apiKey || !artist || !album) {
      return res.status(400).json({ ok: false, error: "API key, artist, and album are required." });
    }
    const response = await callLastFmApi(
      req.forge,
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
    const apiKey = req.query.apiKey || "";
    const track = req.query.track;
    const artist = req.query.artist;
    if (!apiKey || !track && !artist) {
      return res.status(400).json({ ok: false, error: "Search term required" });
    }
    const response = await callLastFmApi(
      req.forge,
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
    const apiKey = req.query.apiKey || "";
    const query = req.query.query;
    const limit = req.query.limit || "12";
    if (!apiKey || !query) {
      return res.status(400).json({ ok: false, error: "Artist search query required" });
    }
    const response = await callLastFmApi(
      req.forge,
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
    const apiKey = req.query.apiKey || "";
    const query = req.query.query;
    const limit = req.query.limit || "12";
    if (!apiKey || !query) {
      return res.status(400).json({ ok: false, error: "Album search query required" });
    }
    const response = await callLastFmApi(
      req.forge,
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
    const apiKey = req.query.apiKey || "";
    const username = req.query.username;
    if (!apiKey || !username) {
      return res.status(400).json({ ok: false, error: "Username required" });
    }
    const [userInfoRes, recentRes] = await Promise.all([
      callLastFmApi(req.forge, { method: "user.getInfo", user: username, api_key: apiKey }, void 0, "GET"),
      callLastFmApi(
        req.forge,
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
    const resolvedApiKey = apiKey;
    const resolvedSecret = apiSecret;
    const resolvedSession = sessionKey;
    if (!resolvedApiKey || !resolvedSecret || !resolvedSession) {
      return res.status(400).json({ ok: false, error: "Send your own Last.fm credentials (API key, API secret and session key) with each request; the server never stores them." });
    }
    const params = {
      method: "track.updateNowPlaying",
      artist,
      track,
      api_key: resolvedApiKey,
      sk: resolvedSession
    };
    if (album) params.album = album;
    const response = await callLastFmApi(req.forge, params, resolvedSecret, "POST");
    return res.json({ ok: true, data: response.data });
  } catch (err) {
    return respondError(res, err);
  } finally {
    req.forge.instantRunning = false;
  }
});
app.post("/api/lastfm/single-scrobble", async (req, res) => {
  try {
    const { artist, track, album, apiKey, apiSecret, sessionKey, timestamp } = req.body;
    const resolvedApiKey = apiKey;
    const resolvedSecret = apiSecret;
    const resolvedSession = sessionKey;
    if (!resolvedApiKey || !resolvedSecret || !resolvedSession) {
      return res.status(400).json({ ok: false, error: "Send your own Last.fm credentials (API key, API secret and session key) with each request; the server never stores them." });
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
    const response = await callLastFmApi(req.forge, params, resolvedSecret, "POST");
    if (response.data && response.data.error) {
      return res.status(400).json({ ok: false, error: response.data.message });
    }
    return res.status(response.accepted ? 200 : 422).json({ ok: response.accepted > 0, accepted: response.accepted, ignored: response.ignored, error: response.ignored ? "Last.fm ignored this track. See activity details." : void 0, data: response.data });
  } catch (err) {
    return respondError(res, err);
  } finally {
    req.forge.instantRunning = false;
  }
});
app.get("/api/job/batch-status", (req, res) => res.json({ ok: true, batch: req.forge.batchProgress }));
app.post("/api/job/cancel-batch", (req, res) => {
  req.forge.batchCancel = true;
  req.forge.addLog("warn", "Batch cancellation requested; any in-flight chunk will finish first.");
  res.json({ ok: true });
});
app.post("/api/job/batch-scrobble-all", async (req, res) => {
  if (req.forge.instantRunning || req.forge.batchRunning || ["running", "rate_limited", "paused"].includes(req.forge.job.status) || req.forge.inFlight) return res.status(409).json({ ok: false, error: "Stop the active job or batch before starting another submission." });
  req.forge.batchRunning = true;
  req.forge.batchCancel = false;
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
    const resolvedApiKey = apiKey;
    const resolvedSecret = apiSecret;
    const resolvedSession = sessionKey;
    if (!resolvedApiKey || !resolvedSecret || !resolvedSession) {
      return res.status(400).json({ ok: false, error: "Send your own Last.fm credentials (API key, API secret and session key); the server never stores them." });
    }
    if (!Array.isArray(tracks) || tracks.length === 0 || tracks.length > 5e3 || tracks.some((t) => typeof t?.name !== "string" || !t.name.trim() || typeof t.artist !== "string" || !t.artist.trim())) {
      return res.status(400).json({ ok: false, error: "No tracks provided for batch scrobbling." });
    }
    const batchId = crypto2.randomUUID();
    const totalToScrobble = tracks.length;
    req.forge.batchProgress = { id: batchId, total: tracks.length, accepted: 0, ignored: 0, status: "running" };
    const now = Math.floor(Date.now() / 1e3);
    const resolvedEnd = endTime ? Math.min(now, Math.floor(endTime)) : now;
    const resolvedStart = startTime ? Math.floor(startTime) : resolvedEnd - Math.max(60, (spanHours || 24) * 3600);
    if (!Number.isFinite(resolvedStart) || !Number.isFinite(resolvedEnd) || resolvedStart < now - 14 * 86400 || resolvedStart >= resolvedEnd || !Number.isFinite(Number(spanHours || 24))) return res.status(400).json({ ok: false, error: "Choose a valid past time range within 14 days." });
    const spanDuration = resolvedEnd - resolvedStart;
    if (spanDuration < tracks.length) return res.status(400).json({ ok: false, error: "Time range is too short for unique track timestamps." });
    const stepSeconds = spanDuration / totalToScrobble;
    const batchSize = 50;
    req.forge.addLog(
      "info",
      `\u{1F680} Commencing batch scrobble: ${totalToScrobble} tracks distributed across time range (${new Date(
        resolvedStart * 1e3
      ).toLocaleTimeString()} to ${new Date(resolvedEnd * 1e3).toLocaleTimeString()}).`
    );
    for (let i = 0; i < totalToScrobble; i += batchSize) {
      if (req.forge.batchCancel) {
        req.forge.batchProgress.status = "cancelled";
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
      const response = await callLastFmApi(req.forge, params, resolvedSecret, "POST", batchId);
      if (response.data && response.data.error) {
        req.forge.addLog(
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
      req.forge.batchProgress.accepted = completed;
      req.forge.batchProgress.ignored = ignored;
      if (response.dailyLimited) {
        req.forge.batchProgress.status = "error";
        return res.status(422).json({ ok: false, completed, ignored, errorCode: 29, error: "Last.fm daily scrobble limit reached. Remaining chunks were not submitted." });
      }
      req.forge.addLog(
        "success",
        `Batch chunk confirmed: ${response.accepted} accepted, ${response.ignored} ignored (${completed} accepted overall).`
      );
      if (i + batchSize < totalToScrobble) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    req.forge.addLog("success", `\u{1F389} Batch scrobble complete! Total ${completed} songs added to Last.fm.`);
    req.forge.batchProgress.status = "completed";
    return res.json({ ok: ignored === 0, completed, ignored, error: ignored ? `${ignored} tracks were ignored; see activity history.` : void 0 });
  } catch (err) {
    req.forge.batchProgress.status = "error";
    const e = err instanceof LastFmError ? err : new LastFmError(500, void 0, "Batch failed; check activity history.");
    if (e.retryAfterSeconds) res.setHeader("Retry-After", String(e.retryAfterSeconds));
    return res.status(e.status).json({ ok: false, error: e.message, errorCode: e.code, completed, ignored, retryAfterSeconds: e.retryAfterSeconds, uncertain: e.uncertain });
  } finally {
    req.forge.batchRunning = false;
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
  if (req.forge.instantRunning || req.forge.batchRunning || req.forge.inFlight || ["running", "rate_limited", "paused"].includes(req.forge.job.status)) {
    return res.status(400).json({ ok: false, error: "A scrobble job is already running." });
  }
  if (credentials?.apiKey && credentials?.apiSecret && credentials?.sessionKey) {
    req.forge.credentials = { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret, sessionKey: credentials.sessionKey, username: typeof credentials.username === "string" ? credentials.username : "" };
  }
  if (isDryRun !== true && (!req.forge.credentials || !req.forge.credentials.sessionKey)) {
    return res.status(400).json({
      ok: false,
      error: "Please connect Last.fm credentials before starting live scrobbles."
    });
  }
  if (req.forge.jobTimeout) {
    clearTimeout(req.forge.jobTimeout);
    req.forge.jobTimeout = null;
  }
  const resolvedQueue = Array.isArray(queue) ? queue.map((t) => ({ id: typeof t?.id === "string" ? t.id : crypto2.randomUUID(), name: t?.name, artist: t?.artist, album: typeof t?.album === "string" ? t.album : "", duration: typeof t?.duration === "number" && Number.isFinite(t.duration) && t.duration > 0 ? t.duration : 180, image: typeof t?.image === "string" && t.image.startsWith("https://") ? t.image : void 0 })) : [];
  if (resolvedQueue.length > 5e3 || resolvedQueue.some((t) => typeof t?.name !== "string" || !t.name.trim() || typeof t.artist !== "string" || !t.artist.trim()) || queueMode && !["single_loop", "queue_once", "queue_loop"].includes(queueMode) || !resolvedQueue.length && queueMode && queueMode !== "single_loop" || !resolvedQueue.length && (typeof artist !== "string" || !artist.trim() || typeof track !== "string" || !track.trim()) || album !== void 0 && typeof album !== "string" || interval !== void 0 && (!Number.isFinite(Number(interval)) || Number(interval) < 0.5 || Number(interval) > 3600) || limit !== void 0 && (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 5e4)) return res.status(400).json({ ok: false, error: "Invalid track, queue, limit (1\u201350000), or interval (0.5\u20133600s)." });
  const resolvedQueueMode = queueMode || (resolvedQueue.length > 0 ? "queue_once" : "single_loop");
  const resolvedLimit = resolvedQueueMode === "queue_once" ? resolvedQueue.length : Math.max(1, parseInt(limit, 10) || 1800);
  req.forge.job = {
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
    logs: readActivity(req.forge.owner, { limit: 100 }).logs
  };
  const modeDescription = resolvedQueueMode === "queue_once" ? `Queue Mode (${resolvedQueue.length} tracks once)` : resolvedQueueMode === "queue_loop" ? `Queue Loop Mode (${resolvedQueue.length} tracks looped up to ${req.forge.job.limit})` : `Single Track Loop ("${req.forge.job.track}" by ${req.forge.job.artist})`;
  req.forge.addLog(
    "info",
    `\u2728 Scrobble stream initiated: ${modeDescription} [Interval: ${req.forge.job.interval}s, Jitter: ${req.forge.job.jitter ? "ON" : "OFF"}${req.forge.job.isDryRun ? ", DRY RUN" : ""}]`
  );
  req.forge.executeScrobbleStep();
  return res.json({ ok: true, job: req.forge.jobStatusPayload() });
});
app.post("/api/job/pause", (req, res) => {
  if (req.forge.job.status === "running" || req.forge.job.status === "rate_limited") {
    if (req.forge.jobTimeout) {
      clearTimeout(req.forge.jobTimeout);
      req.forge.jobTimeout = null;
    }
    req.forge.job.status = "paused";
    req.forge.addLog("warn", "\u23F8\uFE0F Job paused by user.");
    return res.json({ ok: true, job: req.forge.jobStatusPayload() });
  }
  return res.status(400).json({ ok: false, error: "Job is not running or active." });
});
app.post("/api/job/resume", (req, res) => {
  if (req.forge.job.status === "paused") {
    if (req.forge.inFlight) return res.status(409).json({ ok: false, error: "Wait for the in-flight submission to finish." });
    req.forge.job.status = req.forge.cooldownResumeAt && req.forge.cooldownResumeAt > Date.now() ? "rate_limited" : "running";
    req.forge.job.rateLimitResumeAt = req.forge.job.status === "rate_limited" ? req.forge.cooldownResumeAt : null;
    req.forge.addLog("info", "Job resumed; active cooldowns are preserved.");
    if (req.forge.job.status === "rate_limited") req.forge.scheduleCooldown();
    else void req.forge.executeScrobbleStep();
    return res.json({ ok: true, job: req.forge.jobStatusPayload() });
  }
  return res.status(400).json({ ok: false, error: "Job is not paused." });
});
app.post("/api/job/stop", (req, res) => {
  req.forge.batchCancel = true;
  if (req.forge.jobTimeout) {
    clearTimeout(req.forge.jobTimeout);
    req.forge.jobTimeout = null;
  }
  req.forge.job.status = "idle";
  req.forge.job.rateLimitResumeAt = null;
  req.forge.addLog(
    "info",
    `\u23F9\uFE0F Job terminated. Completed ${req.forge.job.scrobblesCompleted}/${req.forge.job.limit} scrobbles.`
  );
  return res.json({ ok: true, job: req.forge.jobStatusPayload() });
});
app.get("/api/job/status", (req, res) => {
  return res.json({ ok: true, job: req.forge.jobStatusPayload() });
});
app.post("/api/job/clear-logs", (req, res) => {
  req.forge.addLog("info", "Console view cleared; persisted activity history retained.");
  return res.json({ ok: true });
});
app.get("/api/player/status", (req, res) => {
  return res.json({ ok: true, player: req.forge.playerStatusPayload() });
});
app.post("/api/player/start", (req, res) => {
  if (req.forge.player.status === "playing" || req.forge.player.status === "paused") {
    return res.status(409).json({ ok: false, error: "The AutoPlayer is already running. Stop the current session first." });
  }
  const { queue, trackDurationSeconds, loopQueue, shuffle } = req.body;
  const resolvedQueue = Array.isArray(queue) ? queue.map((t) => ({ id: typeof t?.id === "string" ? t.id : crypto2.randomUUID(), name: t?.name, artist: t?.artist, album: typeof t?.album === "string" ? t.album : "", duration: typeof t?.duration === "number" && Number.isFinite(t.duration) && t.duration > 0 ? t.duration : 30, image: typeof t?.image === "string" && t.image.startsWith("https://") ? t.image : void 0 })) : [];
  const requestedDuration = trackDurationSeconds === void 0 ? 30 : Number(trackDurationSeconds);
  if (!resolvedQueue.length || resolvedQueue.length > 5e3 || resolvedQueue.some((t) => typeof t?.name !== "string" || !t.name.trim() || typeof t.artist !== "string" || !t.artist.trim()) || !Number.isFinite(requestedDuration) || requestedDuration < 1 || requestedDuration > 3600) {
    return res.status(400).json({ ok: false, error: "The AutoPlayer needs 1-5000 tracks and a play duration between 1 and 3600 seconds." });
  }
  req.forge.clearPlayerTimer();
  req.forge.player.sessionId = crypto2.randomUUID();
  req.forge.player.queue = shuffle === true ? shuffled([...resolvedQueue]) : resolvedQueue;
  req.forge.player.currentIndex = 0;
  req.forge.player.trackDurationSeconds = Math.round(requestedDuration);
  req.forge.player.loopQueue = loopQueue !== false;
  req.forge.player.shuffle = shuffle === true;
  req.forge.player.playsCompleted = 0;
  req.forge.player.startedAt = Date.now();
  req.forge.player.lastPlayAt = null;
  req.forge.player.stoppedReason = null;
  req.forge.player.status = "playing";
  recordActivity(req.forge.owner, "info", `AutoPlayer session started: ${req.forge.player.queue.length} track${req.forge.player.queue.length === 1 ? "" : "s"}, ${req.forge.player.trackDurationSeconds}s per play${req.forge.player.loopQueue ? ", looping" : ""}. Local mode - no Last.fm API calls.`, { category: "player", jobId: req.forge.player.sessionId, total: req.forge.player.queue.length });
  req.forge.emitPlayerState();
  req.forge.startPlay();
  return res.json({ ok: true, player: req.forge.playerStatusPayload() });
});
app.post("/api/player/pause", (req, res) => {
  return req.forge.pausePlayer() ? res.json({ ok: true, player: req.forge.playerStatusPayload() }) : res.status(409).json({ ok: false, error: "The AutoPlayer is not playing." });
});
app.post("/api/player/resume", (req, res) => {
  return req.forge.resumePlayer() ? res.json({ ok: true, player: req.forge.playerStatusPayload() }) : res.status(409).json({ ok: false, error: "The AutoPlayer is not paused." });
});
app.post("/api/player/stop", (req, res) => {
  if (req.forge.player.status !== "idle") {
    const played = req.forge.player.playsCompleted;
    req.forge.stopPlayer(`Stopped after ${played} tracked play${played === 1 ? "" : "s"}.`);
    recordActivity(req.forge.owner, "info", `AutoPlayer session stopped after ${played} locally tracked play${played === 1 ? "" : "s"}. No Last.fm API calls were made.`, { category: "player", jobId: req.forge.player.sessionId || void 0, count: played, total: req.forge.player.queue.length });
  }
  return res.json({ ok: true, player: req.forge.playerStatusPayload() });
});
app.post("/api/player/played", (req, res) => {
  const { track, artist, album, durationMs, source, sessionId, scrobbled } = req.body || {};
  if (typeof track !== "string" || !track.trim() || track.length > 500 || typeof artist !== "string" || !artist.trim() || artist.length > 500) {
    return res.status(400).json({ ok: false, error: "A completed play needs a track and artist name (up to 500 characters)." });
  }
  if (album !== void 0 && (typeof album !== "string" || album.length > 500)) {
    return res.status(400).json({ ok: false, error: "Album must be a string up to 500 characters." });
  }
  const resolvedDuration = Number.isFinite(Number(durationMs)) ? Math.max(0, Math.min(Math.round(Number(durationMs)), 864e5)) : 0;
  const resolvedSource = source === "spotify" ? "Spotify" : "Local";
  const resolvedSession = typeof sessionId === "string" && sessionId.length <= 100 ? sessionId : void 0;
  recordActivity(req.forge.owner, "info", `${resolvedSource} playback completed: "${track.trim()}" by ${artist.trim()}${scrobbled === true ? " - submitted to Last.fm." : " - kept local (no Last.fm submission)."}`, {
    category: "player",
    track: track.trim(),
    artist: artist.trim(),
    album: typeof album === "string" && album.trim() ? album.trim() : void 0,
    outcome: "played",
    durationMs: resolvedDuration,
    jobId: resolvedSession
  });
  return res.json({ ok: true });
});
app.use("/api", (err, req, res, _next) => {
  req.forge.addLog("error", "API request rejected or internal handler failed.", { category: "system", httpStatus: err.status || 500, outcome: "failed" });
  res.status(err.status || 500).json({ ok: false, error: err.status === 400 ? "Invalid JSON request." : "Request failed; check activity history." });
});
app.use("/api", (req, res) => res.status(404).json({ ok: false, error: "Unknown API endpoint." }));
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
    app.get("*", (req, res) => {
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
