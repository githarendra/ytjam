export default function HostToggle({ isHost, hostOnly, onToggle }) {
  if (!isHost) {
    return hostOnly ? <p className="host-note">Only the host controls playback here.</p> : null;
  }

  return (
    <label className="host-toggle">
      <input type="checkbox" checked={hostOnly} onChange={onToggle} />
      <span className="switch" aria-hidden="true" />
      <span>Only I control playback</span>
    </label>
  );
}
