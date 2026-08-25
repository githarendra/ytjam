import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  createRoom,
  getRoom,
  addMember,
  removeMember,
  serializeRoom,
  livePosition,
  advanceQueue,
  canControlPlayback,
  pruneStaleRooms,
  persist,
} from "./rooms.js";

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

// Pulls title/thumbnail for a YouTube video with no API key required,
// via YouTube's public oEmbed endpoint.
app.get("/api/video-info", async (req, res) => {
  const videoId = extractVideoId(req.query.url || "");
  if (!videoId) return res.status(400).json({ error: "Could not parse a YouTube video ID from that URL." });

  try {
    const result = await lookupByVideoId(videoId);
    if (!result) return res.status(404).json({ error: "Video not found or unavailable." });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Lookup failed." });
  }
});

// Searches YouTube by keyword so people can find tracks without leaving the app.
// Requires a YOUTUBE_API_KEY (the free oEmbed trick only resolves known links, not queries).
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Type something to search for." });

  if (!YOUTUBE_API_KEY) {
    return res.status(501).json({
      error: "Search isn't configured on this server yet — add a YOUTUBE_API_KEY to server/.env, or paste a YouTube link instead.",
    });
  }

  try {
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.searchParams.set("part", "snippet");
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("maxResults", "8");
    searchUrl.searchParams.set("videoEmbeddable", "true");
    searchUrl.searchParams.set("q", q);
    searchUrl.searchParams.set("key", YOUTUBE_API_KEY);

    const r = await fetch(searchUrl);
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      const message = body?.error?.message || "YouTube search failed.";
      return res.status(r.status === 403 ? 403 : 502).json({ error: message });
    }
    const data = await r.json();
    const results = (data.items || []).map((item) => ({
      videoId: item.id.videoId,
      title: decodeEntities(item.snippet.title),
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
    }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: "Search failed." });
  }
});

async function lookupByVideoId(videoId) {
  const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const r = await fetch(oembedUrl);
  if (!r.ok) return null;
  const data = await r.json();
  return { videoId, title: data.title, thumbnail: data.thumbnail_url, author: data.author_name };
}

// Basic HTML entity decoding — the YouTube API returns titles with &amp; etc.
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractVideoId(input) {
  const trimmed = input.trim();
  // Bare 11-char video ID
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes("youtu.be")) return url.pathname.slice(1);
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const shortsMatch = url.pathname.match(/\/shorts\/([\w-]{11})/);
    if (shortsMatch) return shortsMatch[1];
  } catch {
    return null;
  }
  return null;
}

// If the client has been built (client/dist exists — see the root "build"
// script), serve it directly from this same process. That lets the whole
// app deploy as a single service: one URL, no separate static host, no
// cross-origin config to get right. In local dev, the client instead runs
// through its own Vite dev server, so client/dist won't exist and this is
// simply skipped.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get(/^\/(?!api\/|socket\.io\/).*/, (req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
  console.log("Serving built client from", clientDistPath);
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
});

io.on("connection", (socket) => {
  let joinedRoomId = null;

  // Lets each client estimate its clock offset from the server's, so
  // playback-position math stays accurate even on a device with a skewed
  // clock or meaningfully different network latency (e.g. a phone on
  // cellular vs. a PC on the same LAN as the server).
  socket.on("time-sync", (_, ack) => {
    ack?.(Date.now());
  });

  socket.on("create-room", (_, ack) => {
    const room = createRoom();
    ack?.({ roomId: room.id });
  });

  socket.on("join-room", ({ roomId, name }, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack?.({ error: "That frequency doesn't exist. Check the code." });

    socket.join(roomId);
    joinedRoomId = roomId;
    addMember(room, socket.id, name?.slice(0, 24) || "Listener");
    persist();

    ack?.({ room: serializeRoom(room) });
    io.to(roomId).emit("room-update", serializeRoom(room));
  });

  socket.on("playback-control", ({ roomId, action, positionSec }) => {
    const room = getRoom(roomId);
    if (!room || !room.playback.videoId) return;

    if (!canControlPlayback(room, socket.id)) {
      socket.emit("control-denied", { reason: "Only the host controls playback in this room right now." });
      return;
    }

    if (action === "play") {
      room.playback.isPlaying = true;
      room.playback.updatedAt = Date.now();
    } else if (action === "pause") {
      room.playback.positionSec = livePosition(room);
      room.playback.isPlaying = false;
      room.playback.updatedAt = Date.now();
    } else if (action === "seek") {
      room.playback.positionSec = Math.max(0, positionSec);
      room.playback.updatedAt = Date.now();
    }

    persist();
    io.to(roomId).emit("playback-sync", room.playback);
  });

  socket.on("toggle-host-only", ({ roomId }) => {
    const room = getRoom(roomId);
    if (!room || room.hostId !== socket.id) return;
    room.hostOnly = !room.hostOnly;
    persist();
    io.to(roomId).emit("room-update", serializeRoom(room));
  });

  // Anyone in the room can add tracks — the queue is shared, not host-owned.
  socket.on("queue-add", async ({ roomId, videoId, title, thumbnail }) => {
    const room = getRoom(roomId);
    if (!room) return;

    const adder = room.members.get(socket.id);
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      videoId,
      title,
      thumbnail,
      addedBy: adder ? { name: adder.name, color: adder.color } : null,
    };
    room.queue.push(item);

    // If nothing is currently playing, start this one immediately.
    if (!room.playback.videoId) {
      room.playback = { videoId, isPlaying: true, positionSec: 0, updatedAt: Date.now() };
    }

    persist();
    io.to(roomId).emit("room-update", serializeRoom(room));
  });

  socket.on("queue-skip", ({ roomId }) => {
    const room = getRoom(roomId);
    if (!room || room.queue.length === 0) return;
    if (!canControlPlayback(room, socket.id)) {
      socket.emit("control-denied", { reason: "Only the host controls playback in this room right now." });
      return;
    }
    advanceQueue(room);
    persist();
    io.to(roomId).emit("room-update", serializeRoom(room));
  });

  socket.on("queue-remove", ({ roomId, itemId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    room.queue = room.queue.filter((q) => q.id !== itemId);
    persist();
    io.to(roomId).emit("room-update", serializeRoom(room));
  });

  socket.on("disconnect", () => {
    if (!joinedRoomId) return;
    const room = getRoom(joinedRoomId);
    if (!room) return;
    removeMember(room, socket.id);
    persist();
    io.to(joinedRoomId).emit("room-update", serializeRoom(room));
  });
});

// Sweep out rooms that have sat empty for hours (keeps the persisted file tidy).
setInterval(pruneStaleRooms, 30 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`ytjam server listening on http://localhost:${PORT}`);
});
