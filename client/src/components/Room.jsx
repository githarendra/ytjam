import { useEffect, useRef, useState } from "react";
import { socket, API_BASE } from "../socket.js";
import Player from "./Player.jsx";
import SyncMeter from "./SyncMeter.jsx";
import Queue from "./Queue.jsx";
import ScrubBar from "./ScrubBar.jsx";
import HostToggle from "./HostToggle.jsx";

// Distinguishes a pasted link/bare ID from a search query, without needing the server.
function looksLikeYouTubeLink(input) {
  if (/^[\w-]{11}$/.test(input)) return true; // bare video ID
  try {
    const url = new URL(input);
    return url.hostname.includes("youtube.com") || url.hostname.includes("youtu.be");
  } catch {
    return false;
  }
}

export default function Room({ initialRoom, name, onLeave }) {
  const [room, setRoom] = useState(initialRoom);
  const [queryInput, setQueryInput] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [addError, setAddError] = useState("");
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");

  // Live scrub state: while dragValue is non-null, the scrub bar shows that
  // instead of the polled playback position, and Player pauses reconciliation.
  const [liveTime, setLiveTime] = useState({ current: 0, duration: 0 });
  const [dragValue, setDragValue] = useState(null);

  // If this tab never had a direct click inside the embedded player, the
  // browser may block our sync code from starting audio here. Player falls
  // back to muted playback when that happens and tells us via this flag.
  const playerRef = useRef(null);
  const [needsUnmute, setNeedsUnmute] = useState(false);

  // Backgrounding the tab / locking the screen pauses the YouTube iframe —
  // that's an Android/iOS restriction on cross-origin iframe media, not
  // something fixable from here. This just makes the return trip clean:
  // when Player detects it came back paused, show a prompt instead of
  // leaving the person staring at a silently-stalled video.
  const [needsBackgroundResume, setNeedsBackgroundResume] = useState(false);

  // Brief visual pulse whenever the room's playback state changes — a shared
  // "just synced" moment for play/pause/seek/skip, whoever triggered it.
  const [justSynced, setJustSynced] = useState(false);
  useEffect(() => {
    setJustSynced(true);
    const t = setTimeout(() => setJustSynced(false), 500);
    return () => clearTimeout(t);
  }, [room.playback.updatedAt]);

  useEffect(() => {
    function handleRoomUpdate(updated) {
      setRoom((prev) => ({
        ...updated,
        playback: prev.playback.updatedAt > updated.playback.updatedAt ? prev.playback : updated.playback,
      }));
    }
    function handlePlaybackSync(playback) {
      setRoom((prev) => ({ ...prev, playback }));
    }
    function handleDenied({ reason }) {
      setNotice(reason);
      setTimeout(() => setNotice(""), 2500);
    }
    // If the connection drops and comes back (e.g. the server restarted),
    // rejoin the same frequency so state picks up where it left off.
    function handleReconnect() {
      socket.emit("join-room", { roomId: room.id, name }, (res) => {
        if (res?.room) setRoom(res.room);
      });
    }

    socket.on("room-update", handleRoomUpdate);
    socket.on("playback-sync", handlePlaybackSync);
    socket.on("control-denied", handleDenied);
    socket.on("connect", handleReconnect);

    return () => {
      socket.off("room-update", handleRoomUpdate);
      socket.off("playback-sync", handlePlaybackSync);
      socket.off("control-denied", handleDenied);
      socket.off("connect", handleReconnect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, name]);

  function addTrack(videoId, title, thumbnail) {
    socket.emit("queue-add", { roomId: room.id, videoId, title, thumbnail });
    setQueryInput("");
    setSearchResults(null);
  }

  async function handleSubmitQuery(e) {
    e.preventDefault();
    setAddError("");
    const trimmed = queryInput.trim();
    if (!trimmed) return;

    // A pasted link or bare video ID adds straight to the queue.
    if (looksLikeYouTubeLink(trimmed)) {
      setSearching(true);
      try {
        const res = await fetch(`${API_BASE}/api/video-info?url=${encodeURIComponent(trimmed)}`);
        const data = await res.json();
        if (!res.ok) {
          setAddError(data.error || "Couldn't find that video.");
          return;
        }
        addTrack(data.videoId, data.title, data.thumbnail);
      } catch {
        setAddError("Something went wrong reaching the server.");
      } finally {
        setSearching(false);
      }
      return;
    }

    // Otherwise treat it as a search query.
    setSearching(true);
    setSearchResults(null);
    try {
      const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error || "Search failed.");
        return;
      }
      setSearchResults(data.results);
      if (data.results.length === 0) setAddError("No results — try different words, or paste a link instead.");
    } catch {
      setAddError("Something went wrong reaching the server.");
    } finally {
      setSearching(false);
    }
  }

  function togglePlay() {
    const wasPlaying = room.playback.isPlaying;
    const positionNow = wasPlaying ? liveTime.current : room.playback.positionSec;
    // Optimistic: flip the UI immediately instead of waiting on a round trip.
    // The server's broadcast confirms it moments later (or corrects it, if denied).
    setRoom((prev) => ({
      ...prev,
      playback: { ...prev.playback, isPlaying: !wasPlaying, positionSec: positionNow, updatedAt: Date.now() },
    }));
    socket.emit("playback-control", { roomId: room.id, action: wasPlaying ? "pause" : "play" });
  }

  function skip() {
    // Optimistic: advance the queue locally right away, same logic the server applies.
    setRoom((prev) => {
      const nextQueue = prev.queue.slice(1);
      const next = nextQueue[0];
      return {
        ...prev,
        queue: nextQueue,
        playback: { videoId: next ? next.videoId : null, isPlaying: !!next, positionSec: 0, updatedAt: Date.now() },
      };
    });
    socket.emit("queue-skip", { roomId: room.id });
  }

  function removeFromQueue(itemId) {
    socket.emit("queue-remove", { roomId: room.id, itemId });
  }

  function copyCode() {
    navigator.clipboard?.writeText(room.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function toggleHostOnly() {
    socket.emit("toggle-host-only", { roomId: room.id });
  }

  function handleScrubChange(value) {
    setDragValue(value);
  }

  function handleScrubCommit(value) {
    setDragValue(null);
    // Optimistic: apply the seek locally so the bar doesn't flash back to the
    // old position while waiting for the server to confirm it.
    setRoom((prev) => ({
      ...prev,
      playback: { ...prev.playback, positionSec: value, updatedAt: Date.now() },
    }));
    socket.emit("playback-control", { roomId: room.id, action: "seek", positionSec: value });
  }

  // Fires when the person uses YouTube's own controls (the pause/play overlay,
  // spacebar, clicking the video) instead of our buttons below. Treats it the
  // same as a transport click so the whole room follows — otherwise the sync
  // loop would just resume it a few seconds later, fighting the person.
  function handleNativeControl(action) {
    if (room.hostOnly && room.hostId !== socket.id) return; // not allowed — let it snap back on the next reconcile
    if (room.playback.isPlaying === (action === "play")) return; // already matches, nothing to do
    const positionNow = room.playback.isPlaying ? liveTime.current : room.playback.positionSec;
    setRoom((prev) => ({
      ...prev,
      playback: { ...prev.playback, isPlaying: action === "play", positionSec: positionNow, updatedAt: Date.now() },
    }));
    socket.emit("playback-control", { roomId: room.id, action });
  }

  const nowPlaying = room.queue[0];
  const isHost = room.hostId === socket.id;
  const controlsLocked = room.hostOnly && !isHost;
  const scrubValue = dragValue !== null ? dragValue : liveTime.current;

  return (
    <div className="room-shell">
      <div className="card room-header-card">
        <div>
          <span className="freq-label">Frequency</span>
          <span className="freq-badge">{room.id}</span>
          <div className="copy-hint">
            <button onClick={copyCode}>{copied ? "Copied!" : "Copy code to invite others"}</button>
          </div>
        </div>
        <div className="listeners">
          {room.members.slice(0, 5).map((m) => (
            <div className="avatar" key={m.id} style={{ background: m.color }} title={m.name}>
              {m.name.slice(0, 1).toUpperCase()}
            </div>
          ))}
        </div>
      </div>

      <SyncMeter isPlaying={room.playback.isPlaying} listenerCount={room.members.length} />

      <div className={`card player-frame ${justSynced ? "synced-pulse" : ""}`}>
        {room.playback.videoId ? (
          <Player
            ref={playerRef}
            playback={room.playback}
            suspendSync={dragValue !== null}
            onTimeUpdate={(current, duration) => setLiveTime({ current, duration })}
            onUserControl={handleNativeControl}
            onAutoplayBlocked={setNeedsUnmute}
            onSkip={skip}
            nowPlayingMeta={nowPlaying ? { title: nowPlaying.title, thumbnail: nowPlaying.thumbnail } : null}
            onBackgroundReturn={() => setNeedsBackgroundResume(true)}
          />
        ) : (
          <div className="player-video" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span className="np-empty">Add a track below to start the jam.</span>
          </div>
        )}

        {needsBackgroundResume && (
          <button
            className="unmute-banner"
            onClick={() => {
              playerRef.current?.resumeAfterBackground();
              setNeedsBackgroundResume(false);
            }}
          >
            ⏸ Paused while you were away — tap to rejoin in sync
          </button>
        )}

        {needsUnmute && (
          <button
            className="unmute-banner"
            onClick={() => {
              playerRef.current?.unmute();
              setNeedsUnmute(false);
            }}
          >
            🔇 This tab is muted so it could stay in sync — tap to unmute
          </button>
        )}
        <div className="now-playing">
          <p className="np-title">{nowPlaying ? nowPlaying.title : "Nothing playing"}</p>
          {nowPlaying?.addedBy && (
            <p className="np-adder">
              <span className="adder-dot" style={{ background: nowPlaying.addedBy.color }} />
              added by {nowPlaying.addedBy.name}
            </p>
          )}

          {room.playback.videoId && (
            <ScrubBar
              value={scrubValue}
              durationSec={liveTime.duration}
              disabled={controlsLocked}
              onChange={handleScrubChange}
              onCommit={handleScrubCommit}
            />
          )}

          <div className="transport">
            <button
              className="transport-btn play"
              onClick={togglePlay}
              disabled={!room.playback.videoId || controlsLocked}
              aria-label={room.playback.isPlaying ? "Pause" : "Play"}
            >
              {room.playback.isPlaying ? "❚❚" : "▶"}
            </button>
            <button className="transport-btn" onClick={skip} disabled={room.queue.length === 0 || controlsLocked} aria-label="Skip">
              ⏭
            </button>
            <div className="host-toggle-slot">
              <HostToggle isHost={isHost} hostOnly={room.hostOnly} onToggle={toggleHostOnly} />
            </div>
          </div>
        </div>
      </div>

      {notice && <p className="notice-toast">{notice}</p>}

      <div className="card add-music-card">
        <p className="card-heading">Add music</p>
        <form className="add-track-row" onSubmit={handleSubmitQuery}>
          <input
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="Search for a song, or paste a YouTube link"
          />
          <button type="submit" disabled={searching}>
            {searching ? "…" : "Search"}
          </button>
        </form>
        {addError && <p className="add-error">{addError}</p>}
        <p className="queue-subhead">Anyone in the room can add their own tracks — they'll show who queued each one.</p>

        {searchResults && searchResults.length > 0 && (
          <ul className="search-results">
            {searchResults.map((r, i) => (
              <li className="search-result" key={r.videoId} style={{ animationDelay: `${i * 35}ms` }}>
                {r.thumbnail && <img src={r.thumbnail} alt="" />}
                <span className="search-result-body">
                  <span className="search-result-title">{r.title}</span>
                  <span className="search-result-channel">{r.channel}</span>
                </span>
                <button onClick={() => addTrack(r.videoId, r.title, r.thumbnail)}>Add</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card queue-card">
        <Queue queue={room.queue} onRemove={removeFromQueue} />
      </div>
    </div>
  );
}