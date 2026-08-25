import { customAlphabet } from "nanoid";
import { loadPersistedRooms, persistRooms } from "./persistence.js";

// Room codes look like tuning frequencies: e.g. "104.7"
const digits = customAlphabet("0123456789", 4);

function makeFrequencyCode() {
  const raw = digits(); // "1047"
  return `${raw.slice(0, 3)}.${raw.slice(3)}`;
}

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * Room shape:
 * {
 *   id: string,
 *   createdAt: number,
 *   emptySince: number|null,       // when the last member left, for pruning stale rooms
 *   hostId: string|null,           // current host's socket id
 *   hostOnly: boolean,             // if true, only the host may control transport
 *   members: Map<socketId, { name: string, color: string }>,
 *   queue: Array<{ id, videoId, title, thumbnail, addedBy: { name, color } | null }>,
 *   playback: { videoId: string|null, isPlaying: boolean, positionSec: number, updatedAt: number }
 * }
 */

const MEMBER_COLORS = ["#E8A54B", "#6FCF97", "#7FB7E8", "#E88A9A", "#C79BE8", "#F0D26E"];
const STALE_ROOM_MS = 6 * 60 * 60 * 1000; // prune empty rooms after 6 idle hours

// --- Bootstrap from disk so rooms + queues survive a server restart. ---
for (const saved of loadPersistedRooms()) {
  rooms.set(saved.id, saved);
}

function nextColor(room) {
  return MEMBER_COLORS[room.members.size % MEMBER_COLORS.length];
}

export function createRoom() {
  let id = makeFrequencyCode();
  while (rooms.has(id)) id = makeFrequencyCode();

  const room = {
    id,
    createdAt: Date.now(),
    emptySince: null,
    hostId: null,
    hostOnly: false,
    members: new Map(),
    queue: [],
    playback: { videoId: null, isPlaying: false, positionSec: 0, updatedAt: Date.now() },
  };
  rooms.set(id, room);
  persist();
  return room;
}

export function getRoom(id) {
  return rooms.get(id);
}

export function addMember(room, socketId, name) {
  room.members.set(socketId, { name, color: nextColor(room) });
  room.emptySince = null;
  // First person in (including after everyone left) becomes host.
  if (!room.hostId) room.hostId = socketId;
}

export function removeMember(room, socketId) {
  room.members.delete(socketId);
  if (room.hostId === socketId) {
    // Hand the mic to whoever's been here longest, if anyone's left.
    const next = room.members.keys().next();
    room.hostId = next.done ? null : next.value;
  }
  if (room.members.size === 0) room.emptySince = Date.now();
}

export function pruneStaleRooms() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.emptySince && now - room.emptySince > STALE_ROOM_MS) {
      rooms.delete(id);
    }
  }
  persist();
}

export function serializeRoom(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    hostOnly: room.hostOnly,
    members: Array.from(room.members.entries()).map(([socketId, m]) => ({
      id: socketId,
      name: m.name,
      color: m.color,
    })),
    queue: room.queue,
    playback: room.playback,
  };
}

/** Compute the "true" current position of a room's playback, projecting forward from updatedAt. */
export function livePosition(room) {
  const { isPlaying, positionSec, updatedAt } = room.playback;
  if (!isPlaying) return positionSec;
  const elapsed = (Date.now() - updatedAt) / 1000;
  return positionSec + elapsed;
}

export function advanceQueue(room) {
  room.queue.shift();
  const next = room.queue[0];
  room.playback = {
    videoId: next ? next.videoId : null,
    isPlaying: !!next,
    positionSec: 0,
    updatedAt: Date.now(),
  };
}

/** Only the host may act when hostOnly is enabled; everyone may otherwise. */
export function canControlPlayback(room, socketId) {
  if (!room.hostOnly) return true;
  return room.hostId === socketId;
}

/** Debounced-enough persistence: called after every mutation, writes are cheap at this scale. */
export function persist() {
  persistRooms(rooms);
}
