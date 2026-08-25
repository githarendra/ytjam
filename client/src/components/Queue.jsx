export default function Queue({ queue, onRemove }) {
  const upNext = queue.slice(1); // first item is "now playing", shown in the player card

  return (
    <div>
      <p className="queue-heading">Up next ({upNext.length})</p>
      {upNext.length === 0 ? (
        <p className="queue-empty">Nothing queued yet — add a track above.</p>
      ) : (
        <ul className="queue-list">
          {upNext.map((item, i) => (
            <li className="queue-item" key={item.id} style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
              {item.thumbnail && <img src={item.thumbnail} alt="" />}
              <span className="queue-item-body">
                <span className="queue-item-title">{item.title}</span>
                {item.addedBy && (
                  <span className="queue-item-adder">
                    <span className="adder-dot" style={{ background: item.addedBy.color }} />
                    {item.addedBy.name}
                  </span>
                )}
              </span>
              <button aria-label="Remove from queue" onClick={() => onRemove(item.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
