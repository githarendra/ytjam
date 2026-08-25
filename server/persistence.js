import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "rooms.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Loads rooms saved before the last shutdown. Membership is intentionally
 * NOT restored (socket connections don't survive a restart) — everyone just
 * rejoins the same frequency and the queue/playback picks up where it left off.
 */
export function loadPersistedRooms() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return [];

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const saved = JSON.parse(raw);
    return saved.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      emptySince: Date.now(), // nobody's reconnected yet
      hostId: null,
      hostOnly: r.hostOnly || false,
      members: new Map(),
      queue: r.queue || [],
      // Freeze the clock at restart rather than letting position jump forward
      // by however long the server was down.
      playback: { ...r.playback, updatedAt: Date.now() },
    }));
  } catch (err) {
    console.error("Couldn't read persisted rooms, starting fresh:", err.message);
    return [];
  }
}

export function persistRooms(roomsMap) {
  ensureDataDir();
  const serializable = Array.from(roomsMap.values()).map((room) => ({
    id: room.id,
    createdAt: room.createdAt,
    hostOnly: room.hostOnly,
    queue: room.queue,
    playback: room.playback,
  }));

  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(serializable, null, 2));
  } catch (err) {
    console.error("Couldn't persist rooms:", err.message);
  }
}
