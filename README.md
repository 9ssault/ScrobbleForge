# ScrobbleForge — Universal Last.fm Automation & Scrobbler Studio

A high-performance Last.fm batch scrobbler, catalog harvester, playback simulator, Spotify player, and track manager built with **React**, **TypeScript**, and **Express**.

Elevates the original Python `scrobble.py` and `main.py` scripts into a comprehensive Last.fm workstation with zero placeholders and full real-time API capabilities.

---

## ▶️ AutoPlayer — local simulation or real Spotify playback

The **Auto player** tab has two modes, both driven by the queue you already built.

### 1. Local simulation (zero Last.fm API calls)
Walks the queue on a real-time schedule without touching the Last.fm API: no credentials, no
metadata lookups, no `track.scrobble` submissions, no cooldowns and no daily caps. Every finished
play is written to this workspace's own persistent activity journal (`category: player`,
`outcome: played`), counted in the dashboard summary as **played**, and exportable with the rest of
the activity NDJSON.

### 2. Spotify playback (real audio, real scrobbles)
Plays the queue **inside Spotify** and submits what you actually listened to Last.fm through the
studio's normal scrobble endpoints (identical rate-limit pacing, cooldowns and journal):

- **Devices** — any Spotify Connect device (phone, desktop, speaker, TV), or this browser itself via
  the Web Playback SDK ("Play in this browser"). Spotify Premium is required by Spotify for
  playback control.
- **Matching** — every queued track is searched on Spotify (using `track:` / `artist:` filters) and
  scored against the wanted artist, so covers by other artists are rejected. Up to 100 queued tracks
  are resolved per session.
- **Now Playing** — sent when a track starts.
- **Scrobbling** — a finished play is submitted when it satisfies Last.fm's rules: the track is
  longer than 30 seconds and you heard at least half of it (or four minutes, whichever comes first).
  The timestamp is the real UTC time the track started.
- **Journal** — each completed play is also recorded locally (`source: spotify`, `outcome: played`)
  together with whether it was scrobbled, so the dashboard separates played from accepted.
- Keep the tab open while tracking: playback state is polled from this page.

#### Connecting Spotify (once)
1. Create an app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard) — the
   Client ID is public and PKCE means no client secret is needed.
2. Add the redirect URI shown in the Auto player tab to that app. Production requires HTTPS, e.g.
   `https://your-host/spotify-callback`; for local development Spotify only accepts a loopback IP,
   e.g. `http://127.0.0.1:3000/spotify-callback` (`localhost` is not accepted).
3. Add your Spotify account e-mail under the app's **Users Management** (development-mode apps must
   allow-list every listener).
4. Paste the Client ID into the Auto player tab. It is saved in that browser only and is never
   sent to the server, so the app does not hold or serve your Spotify application details.
5. Press **Connect Spotify**, pick a device, then **Start Spotify player**.

| Route | Purpose |
| --- | --- |
| `POST /api/player/start` | `{ queue, trackDurationSeconds, loopQueue, shuffle }` — starts a local simulation session (1–5000 tracks, 1–3600s per play) |
| `POST /api/player/pause` / `/resume` | Pause and resume the current simulated play, keeping the remaining time |
| `POST /api/player/stop` | Ends the simulation and journals a summary line |
| `GET /api/player/status` | Current simulation state (also streamed over `/api/job/events` as the `player` event) |
| `POST /api/player/played` | `{ track, artist, album?, durationMs?, source, scrobbled, sessionId? }` — journals a completed Spotify play |

Spotify scrobbles go through the existing `/api/lastfm/now-playing` and
`/api/lastfm/single-scrobble` endpoints, so cooldowns, rate-limit pacing and journaling behave
exactly like the rest of the studio.

> **Other services:** Spotify is the only major music service with a public playback-control API, so
> it is the one that can actually start audio for you — and Spotify Connect lets it drive every
> Spotify device. Services without an API (Apple Music, YouTube Music, …) can still be tracked when
> you play them yourself, using the local simulation mode or the instant actions.

---

## 📱 Quick Access: Mobile & Web (No Install Needed)

You can run ScrobbleForge directly on **any smartphone, tablet, or computer** through the web browser:

### iOS / iPhone / iPad (Safari)
1. Open the hosted ScrobbleForge URL in **Safari**.
2. Tap the **Share** button (box with an arrow pointing up at the bottom of the screen).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add** in the top-right corner.
5. Launch ScrobbleForge from your home screen like a native mobile app (runs full-screen with no browser address bar!).

### Android (Chrome / Brave / Firefox)
1. Open the hosted ScrobbleForge URL in **Chrome**.
2. Tap the **Three Dots menu (⋮)** in the top right.
3. Select **Install app** or **Add to Home screen**.
4. Confirm by tapping **Install**.
5. The ScrobbleForge icon will appear on your home screen and app drawer.

---

## 💻 Platform-by-Platform Local Setup Guide

If you wish to host or run ScrobbleForge locally on your own machine, follow the instructions for your platform below.

### 📋 Prerequisites (For Local Hosting)
- **Node.js** version `22.13.0` or higher ([Download Node.js](https://nodejs.org/))
- **Git** (optional, for cloning)

---

### 🍏 macOS Setup

1. **Install Node.js** (via Homebrew if installed, or the official installer):
   ```bash
   brew install node git
   ```
2. **Clone or Download the Project**:
   ```bash
   git clone <REPO_URL> scrobbleforge
   cd scrobbleforge
   ```
3. **Install Dependencies**:
   ```bash
   bun install --frozen-lockfile
   ```
4. **Start the Application**:
   ```bash
   npm run dev
   ```
5. Open [http://localhost:3000](http://localhost:3000) in Safari or Chrome.

---

### 🪟 Windows Setup (PowerShell / CMD / WSL)

#### Option 1: Native Windows (PowerShell or Command Prompt)
1. Download and run the **Node.js LTS Windows Installer (.msi)** from [nodejs.org](https://nodejs.org/). Make sure the "Add to PATH" option is checked.
2. Open **PowerShell** or **Command Prompt** as Administrator.
3. Verify installation:
   ```powershell
   node -v
   npm -v
   ```
4. Navigate to the project directory:
   ```powershell
   cd path\to\scrobbleforge
   ```
5. Install packages:
   ```powershell
   bun install --frozen-lockfile
   ```
6. Launch the server:
   ```powershell
   npm run dev
   ```
7. Open [http://localhost:3000](http://localhost:3000) in your web browser.

#### Option 2: Windows Subsystem for Linux (WSL2)
1. Open your Ubuntu / WSL terminal:
   ```bash
   sudo apt update
   sudo apt install -y nodejs npm git
   ```
2. Navigate to your project folder and run:
   ```bash
   bun install --frozen-lockfile
   npm run dev
   ```
3. Open [http://localhost:3000](http://localhost:3000) in your Windows browser.

---

### 🐧 Linux Setup (Ubuntu / Debian / Arch / Fedora)

#### Ubuntu / Debian:
```bash
# 1. Install Node.js 24.x LTS repository
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git

# 2. Navigate to project directory
cd scrobbleforge

# 3. Install dependencies
bun install --frozen-lockfile

# 4. Start the dev server
npm run dev
```

#### Arch Linux:
```bash
sudo pacman -S nodejs npm git
cd scrobbleforge
bun install --frozen-lockfile
npm run dev
```

---

### 📱 Android Local Setup (via Termux)

You can run the entire ScrobbleForge server natively on your Android phone without a PC using **Termux**:

1. Install **Termux** from [F-Droid](https://f-droid.org/en/packages/com.termux/) (do not use the obsolete Google Play version).
2. Open Termux and update packages:
   ```bash
   pkg update -y && pkg upgrade -y
   ```
3. Install Node.js and Git:
   ```bash
   pkg install nodejs git -y
   ```
4. Navigate to your project folder or clone it:
   ```bash
   cd scrobbleforge
   ```
5. Install dependencies:
   ```bash
   bun install --frozen-lockfile
   ```
6. Start the server:
   ```bash
   npm run dev
   ```
7. Open your mobile browser (Chrome/Firefox) and navigate to:
   ```
   http://localhost:3000
   ```
8. *Tip*: In Termux, swipe down the notification and select "Acquire Wakelock" to keep scrobbling in the background even when your screen is locked!

---

### ☁️ 24/7 VPS / Server Deployment (PM2 & Production)

To keep ScrobbleForge running 24/7 on a remote Linux server (DigitalOcean, Hetzner, AWS, Linode):

1. **Build the production bundle**:
   ```bash
   npm run build
   ```
2. **Install PM2 process manager**:
   ```bash
   sudo bun install --frozen-lockfile -g pm2
   ```
3. **Start with PM2**:
   ```bash
   pm2 start npm --name "scrobbleforge" -- start
   ```
4. **Enable auto-restart on system reboot**:
   ```bash
   pm2 save
   pm2 startup
   ```

---

## 🔑 Getting Your Last.fm API Key (Free, Takes 1 Minute)

ScrobbleForge connects directly to Last.fm's official Web Services API.

1. Log into your account on [Last.fm](https://www.last.fm).
2. Go to the API application creator: **[last.fm/api/account/create](https://www.last.fm/api/account/create)**.
3. Fill in the form:
   - **Application name**: `ScrobbleForge`
   - **Description**: `Personal scrobbler and playlist manager`
   - You can leave callback URL and homepage blank or put `http://localhost:3000`.
4. Click **Submit**.
5. Copy your **API Key** and **Shared Secret**.
6. In ScrobbleForge:
   - Click **Connect Last.fm Account** in the header.
   - Enter your **API Key**, **API Secret**, **Username**, and **Password**.
   - Click **Authenticate & Connect**.

> **Security Note**: The browser sends credentials to your ScrobbleForge server, which forwards them to Last.fm over HTTPS. Passwords, secrets, session keys, and raw API payloads are not written to the activity journal or browser storage. Reconnect after reload. The server caches credentials in memory until disconnect/restart. This is a single-operator app: do not expose it publicly without an authenticated access proxy.

---

## 🎯 How to Use Every Feature

### 1. Universal Search & Scrobbler (Users, Artists, Albums & Tracks)
- Navigate to the **Search & Scrobble** tab.
- Switch between:
  - **User Profile**: Search any Last.fm username to view profile stats and scrobble their recent plays with one click.
  - **Artist**: Search any artist to view top tracks and full discography.
  - **Album**: Search any album across Last.fm to inspect the full tracklist and scrobble in original sequence.
  - **Track**: Search specific song titles and scrobble them immediately or queue them.

### 2. Idle Detection and Estimated Backfill
- An idle gap is **not evidence of missing playback**. The app cannot recover listening that it never observed.
- Backfill creates **estimated plays** using recent history, the editable queue, or the configured track. Preview the tracks/time range and confirm before submitting.
- Existing history may already include those plays. Check Last.fm first to avoid duplicates.
- Only confirmed accepted submissions update playback activity; dry runs do not.
- Developer tools can simulate an idle gap without recording playback.

### 3. Profile Harvester (Clone & Scrobble Any User's Music)
- Navigate to the **Profile Harvester** tab.
- Enter **any Last.fm username** (your own profile, or any friend or public user).
- Select collection type:
  - **Recents**: Crawl 1 to 10 pages (50 to 500 songs) of recent listening history.
  - **Top Tracks**: Pull the user's most played tracks across timeframes (All-Time, 12 Months, 6 Months, 3 Months, 30 Days, 7 Days).
  - **Loved**: Pull all favorited songs.
- Click **Fetch Tracks**.
- Select all or check specific songs, then click:
  - **"Scrobble All Selected Now"** for an instant batch backfill.
  - **"Stream Paced"** to play through with intervals and jitter.
  - **"Add to Queue"** to combine with other playlists.

### 4. Artist Discography & Full Album Scrobbler
- Navigate to the **Artist & Albums** tab.
- Enter any artist name (e.g. `rvaia`, `SZA`, `The Weeknd`, `Kanye West`, `Daft Punk`).
- **Top Tracks view**: Scrobble all popular tracks by this artist with 1 click.
- **Albums view**: Browse albums with high-res artwork. Click any album to view the complete official tracklist in chronological sequence with song durations.
- Click **"Scrobble Full Album"** to scrobble the album in order!

### 5. Active Queue & Playlist Workspace
- Click the **Queue** tab.
- View all songs gathered from profiles, albums, or searches.
- Re-order, shuffle, or remove individual tracks.
- Options:
  - **"Stream Queue Paced"**: Submits tracks one at a time at the configured interval. It does not play audio or automatically broadcast Now Playing.
  - **"Batch Scrobble All Tracks"**: Submits all songs in batches of 50, distributed backwards in time across 6h, 24h, 2 days, or 7 days inside your selected historical time range. It does not verify that those plays occurred.

### 6. Continuous Single Loop (`scrobble.py` Engine)
- Click the **Single Loop** tab.
- Set Artist, Track Title, Album, Limit (e.g. 1800), and Interval (e.g. 2s).
- **Random Jitter (±0.5s)**: Varies spacing slightly; it does not bypass Last.fm limits or guarantee acceptance.
- **Code 26 Auto-Recovery**: If Last.fm's rate limit triggers, the engine automatically pauses for the `Retry-After` duration (60 seconds when absent) with a visual countdown timer before resuming seamlessly.
- Full Start, Pause, Resume, and Stop/Reset controls.

### 7. Instant Actions
- **1-Click Test Scrobble**: Immediately sends 1 scrobble to verify API credentials.
- **Broadcast "Now Playing"**: Sets your public profile status to "Scrobbling now" without incrementing play count.

---

## 🛠️ CLI & NPM Scripts

| Command | Description |
|---|---|
| `npm run dev` | Runs the full-stack server (Vite + Express) on port 3000 |
| `npm run build` | Builds optimized frontend bundle and standalone backend `server.js` |
| `npm start` | Runs the production standalone Node.js server |
| `npm test` | Runs isolated HTTP regression tests with mocked Last.fm; makes no real scrobbles |
| `npm run lint` | Runs TypeScript type checking with zero errors |
| `npm run clean` | Removes compiled `dist/` and build artifacts |

---

## Activity journal and reliable outcomes

- SQLite persists events in `data/activity.sqlite` by default. Mount a persistent volume here on a VPS/container; back it up using SQLite-aware tooling. Browser refreshes, new jobs, and server restarts do not clear the journal.
- Set `ACTIVITY_DB_PATH` to change the location and `ACTIVITY_RETENTION_DAYS` to change retention (default 90 days). The directory must be writable. Initialization/write failures are errors, not silent in-memory fallback. Retention cleanup runs on writes, at most hourly; exports include all currently retained records.
- The journal records request attempts, HTTP/API outcomes, latency, per-track accepted/ignored details, historical timestamps, rate limits, cooldown deferrals, job controls, and restart recovery. It intentionally does **not** record raw request/response payloads, secrets, sessions, or URLs containing credentials. It is not a capture of every UI click or external listening activity.
- Dashboard totals cover the retained journal. Accepted, ignored, simulated, failed, rate-limited, and uncertain outcomes are distinct. HTTP 200 is not proof that a scrobble was accepted.
- `GET /api/activity?limit=100&before=<sequence>&level=rate_limit&search=<text>` reads paginated history. `GET /api/activity/summary` returns retained totals and cooldown state. `GET /api/activity/export` streams **all retained events** as `scrobbleforge-activity.ndjson` (one JSON record per line), regardless of UI filters.
- Clearing the console only hides its current view; it never deletes the saved journal. Restore saved history or reload to see it again.
- Daily-limit error 29 and per-track ignored code 5 are recorded as rate-limit events and stop further live/batch submissions. They do not use the short temporary cooldown.
- Last.fm HTTP 429 and error code 26 share a cooldown across the single-operator workspace. Resume preserves the cooldown. Live workers retry after known rate-limit rejection; uncertain write/network failures stop rather than risk duplicates. Batch and instant actions return explicit errors and partial counts, and require review before resubmission.
- A stopped job allows an already in-flight request to finish and records its result, but sends no further requests. Batch cancellation stops before the next chunk; already accepted tracks cannot be undone.
- Restart restores the last streaming job checkpoint **paused**. Credentials are not persisted. Reconnect before resuming; a submission interrupted by restart can be uncertain. Batches have live progress/cancellation but are not durable resumable jobs yet.
- Queue JSON import/export uses `scrobbleforge-queue.json`: an array of tracks with `name`, `artist`, optional `album` and `duration` (seconds). Imports are limited to 2 MB/5000 tracks. Reordering/shuffling/editing does not change a running job's queue snapshot.
- The recent-listening chart is explicitly a sample of up to 60 fetched tracks, not a complete 24-hour count. Now Playing is excluded. Polling is consolidated and pauses when the page is hidden or a known cooldown is active.

## Runtime and installation

Use Node **22.13+** (Node 24 LTS recommended for built-in `node:sqlite`) and Bun **1.4.2+** to read the checked-in lockfile. Dependencies are not automatically installed. For a reproducible install, this repository's lockfile contains one unused `@google/genai` root dependency missing from `package.json`; temporarily restore that entry while installing, then restore the original manifest:

```bash
cp package.json package.json.install-backup
node --input-type=module -e "import fs from 'node:fs'; const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.dependencies['@google/genai']='^2.4.0'; fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
bun install --frozen-lockfile
# Restore this even if installation failed. Do not regenerate the lockfile.
mv package.json.install-backup package.json
npm run dev
```

The unused dependency is not imported or bundled. The lockfile was preserved during this upgrade. `npm start` serves the built production output; `npm run dev` runs Express with Vite middleware on `0.0.0.0:3000`.

**Hosting limitations:** this uses a Node/Express server, SQLite, and timers; it is not a Cloudflare Worker build. It has no application-level multi-user authentication or per-user data isolation. Run locally or behind trusted authenticated access. Same-origin mutation checks do not replace authentication. Last.fm browser-authorization migration, durable resumable batches, true full-day analytics, and PWA offline installation remain future work.

---

## ⚖️ License
Apache-2.0
