// ──────────────────────────────────────────────
// src/pages/AdminDashboard.jsx
// Admin management panel for the Hudson repertoire.
//
// Features:
//   - List tracks from the catalogue Cloud Function
//   - Drag-and-drop reordering (client-side, persisted to
//     a public playlist order document in Storage)
//   - Delete a track (removes Storage objects + key)
//   - Read-only guidance for adding new tracks
//
// Security:
//   - Route is guarded by PrivateRoute + user.isAdmin
//   - deleteTrack callable verifies the caller is admin@gmail.com
// ──────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { useAuth } from '../context/AuthContext'
import { functions } from '../firebase'

export default function AdminDashboard() {
  const { user, logout } = useAuth()
  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [draggingId, setDraggingId] = useState(null)

  const showMessage = useCallback((text, type = 'info') => {
    setMessage({ text, type })
    setTimeout(() => setMessage(null), 4000)
  }, [])

  // Load catalogue
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
        console.error('[admin] failed to load catalogue', err)
        showMessage('Failed to load catalogue.', 'error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showMessage])

  const deleteTrack = useCallback(
    async (id) => {
      if (!window.confirm(`Delete “${id}”? This cannot be undone.`)) return
      setSaving(true)
      try {
        const fn = httpsCallable(functions, 'deleteTrack')
        await fn({ id })
        setTracks((prev) => prev.filter((t) => t.id !== id))
        showMessage(`Deleted ${id}.`, 'success')
      } catch (err) {
        console.error('[admin] delete failed', err)
        showMessage(err?.message || 'Delete failed.', 'error')
      } finally {
        setSaving(false)
      }
    },
    [showMessage],
  )

  const moveTrack = useCallback((index, direction) => {
    setTracks((prev) => {
      const next = [...prev]
      const target = index + direction
      if (target < 0 || target >= next.length) return prev
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }, [])

  const handleDragStart = useCallback((e, id) => {
    setDraggingId(id)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(
    (e, targetId) => {
      e.preventDefault()
      if (!draggingId || draggingId === targetId) {
        setDraggingId(null)
        return
      }
      setTracks((prev) => {
        const from = prev.findIndex((t) => t.id === draggingId)
        const to = prev.findIndex((t) => t.id === targetId)
        if (from === -1 || to === -1) return prev
        const next = [...prev]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        return next
      })
      setDraggingId(null)
    },
    [draggingId],
  )

  const saveOrder = useCallback(async () => {
    setSaving(true)
    try {
      const fn = httpsCallable(functions, 'savePlaylistOrder')
      await fn({ order: tracks.map((t) => t.id) })
      showMessage('Playlist order saved.', 'success')
    } catch (err) {
      console.error('[admin] save order failed', err)
      showMessage(err?.message || 'Save failed.', 'error')
    } finally {
      setSaving(false)
    }
  }, [tracks, showMessage])

  const trackCount = tracks.length

  return (
    <div className="flex min-h-screen flex-col bg-ink-900" onContextMenu={(e) => e.preventDefault()}>
      {/* Header */}
      <header className="flex items-center justify-between border-b border-ink-700 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <h1 className="bg-gradient-to-r from-accent to-accent-glow bg-clip-text text-xl font-bold tracking-tight text-transparent">
            Hudson
          </h1>
          <span className="hidden text-xs text-gray-600 sm:inline">· admin panel</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden truncate text-xs text-gray-500 sm:inline">{user?.email}</span>
          <button
            onClick={logout}
            className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-ink-700"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 px-2 py-4 sm:px-6">
        <div className="mx-auto max-w-4xl">
          {message && (
            <div
              className={`mb-4 rounded-lg border px-4 py-2 text-sm ${
                message.type === 'error'
                  ? 'border-red-500/20 bg-red-500/10 text-red-400'
                  : message.type === 'success'
                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                    : 'border-ink-600 bg-ink-800 text-gray-300'
              }`}
            >
              {message.text}
            </div>
          )}

          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-100">Repertoire · {trackCount} tracks</h2>
              <p className="text-xs text-gray-500">Drag to reorder. Changes are saved with the button below.</p>
            </div>
            <button
              onClick={saveOrder}
              disabled={saving || loading}
              className="rounded-lg bg-gradient-to-br from-accent to-accent-glow px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-sm transition hover:shadow-glow disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save order'}
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
            </div>
          ) : tracks.length === 0 ? (
            <div className="rounded-xl border border-ink-700/60 bg-ink-800/50 p-6 text-center">
              <p className="text-gray-400">No tracks uploaded yet.</p>
            </div>
          ) : (
            <ul className="divide-y divide-ink-700/60 rounded-xl border border-ink-700/60 bg-ink-800/30">
              {tracks.map((t, i) => (
                <li
                  key={t.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, t.id)}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, t.id)}
                  className={`flex items-center gap-3 px-3 py-3 transition-colors ${
                    draggingId === t.id ? 'opacity-50' : 'opacity-100'
                  } hover:bg-ink-800/60`}
                >
                  <span className="w-6 shrink-0 cursor-grab text-center text-xs text-gray-500 active:cursor-grabbing">
                    ☰
                  </span>
                  <span className="w-6 shrink-0 text-center text-xs tabular-nums text-gray-500">
                    {String(i + 1).padStart(2, '0')}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-100">{t.title}</p>
                    <p className="truncate text-xs text-gray-500">{t.id}</p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => moveTrack(i, -1)}
                      disabled={i === 0}
                      aria-label="Move up"
                      className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition hover:bg-ink-700 hover:text-gray-100 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveTrack(i, 1)}
                      disabled={i === tracks.length - 1}
                      aria-label="Move down"
                      className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition hover:bg-ink-700 hover:text-gray-100 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => deleteTrack(t.id)}
                      disabled={saving}
                      aria-label="Delete track"
                      className="flex h-8 w-8 items-center justify-center rounded-full text-red-400 transition hover:bg-red-500/10 disabled:opacity-30"
                    >
                      🗑
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Add-track guidance */}
          <div className="mt-6 rounded-xl border border-ink-700/60 bg-ink-800/50 p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-100">Add a new track</h3>
            <ol className="list-decimal space-y-1 pl-4 text-xs text-gray-400">
              <li>Drop the MP3 into <code className="rounded bg-ink-700 px-1 text-accent">mp3_export/</code>.</li>
              <li>Run <code className="rounded bg-ink-700 px-1 text-accent">bash scripts/encrypt_hls.sh</code>.</li>
              <li>Run <code className="rounded bg-ink-700 px-1 text-accent">node scripts/upload_hls.mjs</code>.</li>
              <li>Refresh this page and reorder if needed.</li>
            </ol>
          </div>
        </div>
      </main>
    </div>
  )
}
