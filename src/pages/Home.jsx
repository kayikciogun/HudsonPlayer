// ──────────────────────────────────────────────
// src/pages/Home.jsx
// Main player screen.
//
// The catalogue is fetched from the `catalogue` Cloud Function,
// which verifies the Firebase ID token and lists the tracks
// stored under tracks-hls/. No URLs are returned here — the
// Player requests the m3u8 + segments via Cloud Functions
// when the user picks a track.
// ──────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { useAuth } from '../context/AuthContext'
import { functions } from '../firebase'
import Playlist from '../components/Playlist'
import Player from '../components/Player'

export default function Home() {
  const { user, logout } = useAuth()
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const [current, setCurrent] = useState(null)

  // Fetch the catalogue via the auth-gated Cloud Function.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const catalogue = httpsCallable(functions, 'catalogue')
        const { data } = await catalogue()
        if (cancelled) return
        setTracks(
          (data.tracks || []).map((t) => ({
            id: t.id,
            title: t.title,
            artist: 'Hudson',
          })),
        )
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[home] failed to load catalogue', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const currentIndex = useMemo(
    () => tracks.findIndex((t) => t.id === current?.id),
    [tracks, current],
  )

  const playNext = useCallback(() => {
    if (!tracks.length) return
    const next = (currentIndex + 1) % tracks.length
    setCurrent(tracks[next])
  }, [tracks, currentIndex])

  const playPrev = useCallback(() => {
    if (!tracks.length) return
    const prev = (currentIndex - 1 + tracks.length) % tracks.length
    setCurrent(tracks[prev])
  }, [tracks, currentIndex])

  return (
    <div
      className="flex h-screen flex-col bg-ink-900"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Header */}
      <header className="flex items-center justify-between border-b border-ink-700 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <h1 className="bg-gradient-to-r from-accent to-accent-glow bg-clip-text text-xl font-bold tracking-tight text-transparent">
            Hudson
          </h1>
          <span className="hidden text-xs text-gray-600 sm:inline">
            · private repertoire
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden truncate text-xs text-gray-500 sm:inline">
            {user?.username || user?.email}
          </span>
          <button
            onClick={logout}
            className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-ink-700"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Playlist */}
      <main className="flex-1 overflow-y-auto px-2 py-3 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Repertoire · {tracks.length} tracks
          </h2>
          <Playlist
            tracks={tracks}
            loading={false}
            currentId={current?.id}
            onSelect={setCurrent}
          />
        </div>
      </main>

      {/* Sticky bottom player */}
      <footer className="sticky bottom-0 z-10">
        <Player track={current} onNext={playNext} onPrev={playPrev} />
      </footer>
    </div>
  )
}