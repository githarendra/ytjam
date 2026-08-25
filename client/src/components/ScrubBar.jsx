function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Controlled scrub bar: `value` is whatever the parent wants displayed right now
 *  (live playback position, or the position being dragged to). */
export default function ScrubBar({ value, durationSec, disabled, onChange, onCommit }) {
  const pct = durationSec > 0 ? Math.min(100, (value / durationSec) * 100) : 0;

  return (
    <div className="scrub-row">
      <span className="scrub-time">{formatTime(value)}</span>
      <input
        className="scrub-bar"
        type="range"
        min={0}
        max={durationSec || 0}
        step={0.5}
        value={Math.min(value, durationSec || 0)}
        disabled={disabled || !durationSec}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={(e) => onCommit(Number(e.target.value))}
        onTouchEnd={(e) => onCommit(Number(e.target.value))}
        onKeyUp={(e) => onCommit(Number(e.target.value))}
        style={{ "--fill": `${pct}%` }}
        aria-label="Seek"
      />
      <span className="scrub-time">{formatTime(durationSec)}</span>
    </div>
  );
}
