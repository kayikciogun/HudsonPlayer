// ──────────────────────────────────────────────
// src/components/Playlist.jsx
// Lists tracks fetched from Firebase Storage.
// Right-click disabled on the list area.
// ──────────────────────────────────────────────
export default function Playlist({ tracks, loading, currentId, onSelect }) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
      </div>
    )
  }

  if (!tracks.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center sm:py-20">
        <p className="text-gray-400">No tracks uploaded yet.</p>
        <p className="text-xs text-gray-600">
          Upload audio files to your Firebase Storage bucket under{' '}
          <code className="rounded bg-ink-700 px-1.5 py-0.5 text-accent">
            tracks/
          </code>
          .
        </p>
      </div>
    )
  }

  return (
    <ul
      className="divide-y divide-ink-700/60 select-none"
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
    >
      {tracks.map((t, i) => {
        const active = t.id === currentId
        return (
          <li key={t.id}>
            <button
              onClick={() => onSelect(t)}
              aria-current={active ? 'true' : undefined}
              className={`group flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left transition-all duration-200 ease-smooth sm:gap-4 sm:px-4 ${
                active
                  ? 'bg-gradient-to-r from-accent/10 via-accent/5 to-transparent'
                  : 'hover:bg-ink-800/80 hover:translate-x-0.5'
              }`}
            >
              <span
                className={`w-5 shrink-0 text-center text-xs tabular-nums transition-colors sm:w-6 ${
                  active ? 'text-accent' : 'text-gray-500 group-hover:text-gray-400'
                }`}
              >
                {active ? (
                  <span className="inline-block">♪</span>
                ) : (
                  String(i + 1).padStart(2, '0')
                )}
              </span>

              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-all duration-200 sm:h-10 sm:w-10 ${
                  active
                    ? 'bg-accent/15 text-accent'
                    : 'bg-ink-700/60 text-gray-500 group-hover:bg-ink-700 group-hover:text-gray-300'
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </div>

              <div className="min-w-0 flex-1">
                <p
                  className={`truncate text-sm font-medium transition-colors ${
                    active ? 'text-accent' : 'text-gray-100 group-hover:text-white'
                  }`}
                >
                  {t.title}
                </p>
                <p className="truncate text-xs text-gray-500">{t.artist}</p>
              </div>

              {active ? (
                <span
                  className="flex shrink-0 items-end gap-0.5"
                  aria-label="Now playing"
                >
                  <span className="block w-0.5 origin-bottom rounded-full bg-accent animate-eq-1" style={{ height: '12px' }} />
                  <span className="block w-0.5 origin-bottom rounded-full bg-accent animate-eq-2" style={{ height: '12px' }} />
                  <span className="block w-0.5 origin-bottom rounded-full bg-accent animate-eq-3" style={{ height: '12px' }} />
                </span>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  className="hidden h-4 w-4 shrink-0 fill-current text-gray-600 opacity-0 transition-opacity group-hover:opacity-100 sm:inline"
                  aria-hidden
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}