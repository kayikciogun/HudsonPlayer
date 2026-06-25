// ──────────────────────────────────────────────
// src/components/PrivateRoute.jsx
// Guards the main app. While Firebase resolves the
// session we show a loader; if no user, bounce to /login.
// ──────────────────────────────────────────────
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function PrivateRoute({ children }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-ink-900">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
          <p className="text-sm text-gray-500">Loading Hudson…</p>
        </div>
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />

  return children
}