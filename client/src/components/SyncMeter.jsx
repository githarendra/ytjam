export default function SyncMeter({ isPlaying, listenerCount }) {
  return (
    <div className="sync-meter">
      <div className={`sync-bars ${isPlaying ? "" : "paused"}`}>
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <p className="sync-label">
        {isPlaying ? (
          <>
            <strong>{listenerCount}</strong> {listenerCount === 1 ? "listener" : "listeners"} in sync
          </>
        ) : (
          "Paused for everyone"
        )}
      </p>
    </div>
  );
}
