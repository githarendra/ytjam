import { useState } from "react";
import { socket } from "../socket.js";

export default function JoinScreen({ onJoined }) {
  const [mode, setMode] = useState("join"); // "join" | "create"
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!name.trim()) return setError("Tell us what to call you.");

    setBusy(true);

    if (mode === "create") {
      socket.emit("create-room", null, ({ roomId }) => {
        joinRoom(roomId);
      });
    } else {
      if (!roomCode.trim()) {
        setBusy(false);
        return setError("Enter the frequency your friend shared.");
      }
      joinRoom(roomCode.trim());
    }
  }

  function joinRoom(roomId) {
    socket.emit("join-room", { roomId, name: name.trim() }, (res) => {
      setBusy(false);
      if (res?.error) return setError(res.error);
      onJoined({ room: res.room, name: name.trim() });
    });
  }

  return (
    <div className="screen">
      <div className="tuner-card">
        <p className="wordmark">ytjam</p>
        <h1 className="tuner-headline">Tune in together.</h1>
        <p className="tuner-sub">
          Open a frequency, share the code, and listen in perfect sync — no ads stripped, no accounts, just a shared
          room.
        </p>

        <form className="dial" onSubmit={handleSubmit}>
          <div className="tab-row">
            <button type="button" className={`tab ${mode === "join" ? "active" : ""}`} onClick={() => setMode("join")}>
              Join a room
            </button>
            <button
              type="button"
              className={`tab ${mode === "create" ? "active" : ""}`}
              onClick={() => setMode("create")}
            >
              Start a room
            </button>
          </div>

          <div className="field">
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              className="name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Priya"
              maxLength={24}
              autoFocus
            />
          </div>

          {mode === "join" && (
            <div className="field">
              <label htmlFor="code">Frequency</label>
              <input
                id="code"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
                placeholder="104.7"
                inputMode="decimal"
              />
            </div>
          )}

          <button className="primary-btn" type="submit" disabled={busy}>
            {busy ? "Connecting…" : mode === "join" ? "Join room" : "Open a new frequency"}
          </button>

          {error && <p className="form-error">{error}</p>}
        </form>
      </div>
    </div>
  );
}
