# ScrobbleForge — Universal Last.fm Automation & Scrobbler Studio

A high-performance Last.fm batch scrobbler, catalog harvester, playback simulator, and track manager built with **React**, **TypeScript**, and **Express**.

Elevates the original Python `scrobble.py` and `main.py` scripts into a comprehensive Last.fm workstation with zero placeholders and full real-time API capabilities.

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
- **Node.js** version `18.0.0` or higher ([Download Node.js](https://nodejs.org/))
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
   npm install
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
   npm install
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
   npm install
   npm run dev
   ```
3. Open [http://localhost:3000](http://localhost:3000) in your Windows browser.

---

### 🐧 Linux Setup (Ubuntu / Debian / Arch / Fedora)

#### Ubuntu / Debian:
```bash
# 1. Install Node.js 20.x LTS repository
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# 2. Navigate to project directory
cd scrobbleforge

# 3. Install dependencies
npm install

# 4. Start the dev server
npm run dev
```

#### Arch Linux:
```bash
sudo pacman -S nodejs npm git
cd scrobbleforge
npm install
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
   npm install
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
   sudo npm install -g pm2
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

> **Security Note**: Your password and API secret are never transmitted to third parties or logged. Passwords are exchanged with Last.fm directly for an authorized session token (`sk`), keeping your account secure.

---

## 🎯 How to Use Every Feature

### 1. ScrobbleAI (Gemini Music Curator & Copilot)
- Navigate to the **ScrobbleAI** tab.
- Multi-turn conversational interface powered by Google Gemini models:
  - **`gemini-3.5-flash`** (General Tasks): Balanced musical recommendations and playlist generation.
  - **`gemini-3.1-flash-lite`** (Fast Tasks): Rapid quickfire track ideas and instant recommendations.
  - **`gemini-3.1-pro-preview`** (Complex Tasks): In-depth music theory, complex discography analysis, and deep catalog sequencing.
- **1-Click Queue & Scrobble**: Any tracks recommended by ScrobbleAI include instant **"Queue All"** and **"⚡ Scrobble All"** buttons!
- **Context-Aware**: Understands your active track, current queue, and recent listening history to give tailored suggestions.

### 2. Universal Search & Scrobbler (Users, Artists, Albums & Tracks)
- Navigate to the **Search & Scrobble** tab.
- Switch between:
  - **User Profile**: Search any Last.fm username to view profile stats and scrobble their recent plays with one click.
  - **Artist**: Search any artist to view top tracks and full discography.
  - **Album**: Search any album across Last.fm to inspect the full tracklist and scrobble in original sequence.
  - **Track**: Search specific song titles and scrobble them immediately or queue them.

### 2. Live Session Idle Detection (> 1h Gap) & 1-Click Catch-up
- Automatically monitors playback activity during and after Live streaming sessions.
- **> 1 Hour Idle Gap Detection**: When your session has been idle for more than an hour, a prominent amber notification detects the gap (e.g. `Idle for 1h 24m`).
- **Missing Track Calculation**: Estimates how many songs would have played during that silent period based on song length (~3.5 minutes).
- **1-Click Catch-up**: Click **"⚡ Catch-up Missing Tracks"** to automatically distribute the missing songs backwards in time across the gap from when you stopped until now, with an option to resume live playback immediately!
- Includes a **"Simulate 1h Idle"** button for instant demonstration and testing.

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

### 2. Artist Discography & Full Album Scrobbler
- Navigate to the **Artist & Albums** tab.
- Enter any artist name (e.g. `rvaia`, `SZA`, `The Weeknd`, `Kanye West`, `Daft Punk`).
- **Top Tracks view**: Scrobble all popular tracks by this artist with 1 click.
- **Albums view**: Browse albums with high-res artwork. Click any album to view the complete official tracklist in chronological sequence with song durations.
- Click **"Scrobble Full Album"** to scrobble the album in order!

### 3. Active Queue & Playlist Workspace
- Click the **Queue** tab.
- View all songs gathered from profiles, albums, or searches.
- Re-order, shuffle, or remove individual tracks.
- Options:
  - **"Stream Queue Paced"**: Plays through track-by-track, updating your profile's "Now Playing" before each scrobble.
  - **"Batch Scrobble All Tracks"**: Submits all songs in batches of 50, distributed backwards in time across 6h, 24h, 2 days, or 7 days so charts look authentic.

### 4. Continuous Single Loop (`scrobble.py` Engine)
- Click the **Single Loop** tab.
- Set Artist, Track Title, Album, Limit (e.g. 1800), and Interval (e.g. 2s).
- **Random Jitter (±0.5s)**: Simulates human playback timing to avoid uniform bot flags.
- **Code 26 Auto-Recovery**: If Last.fm's rate limit triggers, the engine automatically pauses for 60 seconds with a visual countdown timer before resuming seamlessly.
- Full Start, Pause, Resume, and Stop/Reset controls.

### 5. Instant Actions
- **1-Click Test Scrobble**: Immediately sends 1 scrobble to verify API credentials.
- **Broadcast "Now Playing"**: Sets your public profile status to "Scrobbling now" without incrementing play count.

---

## 🛠️ CLI & NPM Scripts

| Command | Description |
|---|---|
| `npm run dev` | Runs the full-stack server (Vite + Express) on port 3000 |
| `npm run build` | Builds optimized frontend bundle and standalone backend `server.js` |
| `npm start` | Runs the production standalone Node.js server |
| `npm run lint` | Runs TypeScript type checking with zero errors |
| `npm run clean` | Removes compiled `dist/` and build artifacts |

---

## ⚖️ License
Apache-2.0
