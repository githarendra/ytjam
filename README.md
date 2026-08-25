# ytjam

Listen to YouTube together, in sync, across separate browsers — like Spotify Jam, but built on the official YouTube IFrame Player.

**A note on ads:** this plays videos through YouTube's real embedded player, so YouTube's normal ad rules apply — the same as watching on youtube.com. Stripping or blocking YouTube's ads isn't something this project does (it would violate YouTube's Terms of Service), so a Premium-free room won't be literally ad-free. If you want a genuinely ad-free source, the cleanest option is swapping in the Spotify Web Playback SDK for anyone with Spotify Premium — happy to help wire that up later.

## Features

- **Synced playback** — play/pause/skip/seek stay in lockstep across everyone in the room.
- **Search or paste** — find a track by name right in the queue box, or paste a link/video ID directly.
- **Shared queue** — anyone in the room can add tracks; each one shows who added it.
- **Scrub bar** — drag to seek within the current track; syncs to everyone else on release.
- **Host mode (optional)** — the room's host can flip on "Only I control playback" to lock transport controls to themselves. Off by default — everyone can drive.
- **Survives a server restart** — the queue, playback position, and host-only setting are persisted to disk, and clients auto-rejoin their room if the connection drops and comes back.

## How the "Jam" sync works

- The server holds the source of truth for each room: `{ videoId, isPlaying, positionSec, updatedAt }`.
- Anyone permitted to control playback (everyone, unless host mode is on) can hit play/pause/skip/seek; the server timestamps the change and broadcasts it to everyone via Socket.io.
- Each client projects the "true" current position forward from `updatedAt` and reconciles its local YouTube player every few seconds — nudging playback with `seekTo` if it's drifted more than ~1.5s, or fixing play/pause state. This pauses while a client is actively dragging its own scrub bar.
- No accounts, no database — rooms live in memory (and a small JSON file) and are pruned after 6 idle hours.

## Project structure

```
ytjam/
  server/   Express + Socket.io backend (room state, sync broadcast, video lookup, persistence)
  client/   React + Vite frontend (join screen, player, scrub bar, queue, host toggle)
```

## Running it locally

### 1. Server

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

Runs on `http://localhost:4000`. Room state persists to `server/data/rooms.json` — safe to delete if you want a clean slate.

**To enable in-app search** (recommended — otherwise people have to paste links), get a free YouTube Data API key:
1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project (or use an existing one).
2. Enable the **YouTube Data API v3** under "APIs & Services" → "Library".
3. Create an API key under "APIs & Services" → "Credentials".
4. Paste it into `server/.env` as `YOUTUBE_API_KEY=your_key_here`.

Without a key, the search box still works for pasted links/video IDs — typing a plain search phrase will just show a message pointing you to paste a link instead. Google's free tier is generous (10,000 units/day; each search costs 100), plenty for personal use.

### 2. Client

In a second terminal:

```bash
cd client
npm install
cp .env.example .env
npm run dev
```

Runs on `http://localhost:5173`. Open it, create a room, and share the "frequency" code (e.g. `104.7`) with whoever you want to jam with — they join at the same URL.

## Deploying it (so others can use it without your laptop running)

The server serves the built client itself — one process, one URL, no CORS setup, no wiring two services' URLs together. `render.yaml` in this repo defines that single service for [Render](https://render.com)'s Blueprint feature.

### Option A: Blueprint (uses `render.yaml`, fewest manual fields)

1. Push this project to a GitHub repo — make sure `render.yaml` is actually committed and pushed, not just sitting locally.
2. On Render: **New → Blueprint**, connect the repo.
3. Render reads `render.yaml` and proposes **one** service named `ytjam`. Review it, then click **Apply** / **Deploy Blueprint**.
4. If prompted, fill in `YOUTUBE_API_KEY` (optional — enables in-app search; leave blank to allow paste-only for now, you can add it later from the service's Environment tab).
5. Wait for the build to finish, then open the service's URL — that's your whole app, frontend and backend together. Share it the same way you'd share the frequency code locally.

If Render asks for card verification during this flow and you'd rather not, use Option B instead — it's the same end result via a different door.

### Option B: Manual web service (no `render.yaml` involved)

1. Push this project to a GitHub repo.
2. On Render: **New → Web Service** (not Blueprint). Connect the repo.
3. Root Directory: `server`. Build Command: `npm install && npm run build` (this also builds the client). Start Command: `npm start`. Instance Type: Free.
4. In the Environment tab, optionally add `YOUTUBE_API_KEY`.
5. Create the service, then open its URL once it's live.

**Two honest tradeoffs of the free tier**, so you're not caught off guard:
- **Cold starts** — a free Render web service spins down after 15 minutes of no traffic. The first person to open the site after a quiet period waits ~30–60 seconds for it to wake up before the room connects.
- **No persistent disk on free** — `server/data/rooms.json` lives on the service's local filesystem, which free services don't guarantee across restarts/redeploys. Within a live session everything's fine; a redeploy or a spin-down/wake cycle can lose in-progress rooms. For something you want to keep alive and stateful long-term, look at Render's paid tier with a persistent disk, or swap the JSON file for a small hosted database.

If you outgrow the free tier or want an always-on service without cold starts, Render's Starter plan (~$7/mo) removes the spin-down behavior — everything else in this guide stays the same.

## Adding tracks

The queue box does double duty — anyone in the room can use it:
- **Type a search** (e.g. `daft punk one more time`) → pick from results
- **Paste a link** → adds straight away:
  - Full URL: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`
  - Short URL: `https://youtu.be/dQw4w9WgXcQ`
  - Bare video ID: `dQw4w9WgXcQ`

## Host mode

Whoever created the room (or has been there longest, if the original host leaves) can toggle **"Only I control playback"** next to the transport buttons. When on, everyone else's play/pause/skip/scrub controls are disabled — but adding tracks to the queue is always open to everyone, regardless of this setting.

## Ideas for next steps

- Swap the source to Spotify (Web Playback SDK) for accounts with Premium, for genuinely ad-free playback
- Reactions / lightweight chat alongside the queue
- Move persistence from a JSON file to Redis if you need multiple server instances
- "Vote to skip" instead of (or alongside) host-only skip
