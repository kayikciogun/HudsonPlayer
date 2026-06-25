// ──────────────────────────────────────────────
// src/components/AdminRoute.jsx
// Guards admin routes. Requires an authenticated user
// whose email matches the fixed admin account.
// ──────────────────────────────────────────────
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function AdminRoute({ children }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-ink-900">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
          <p className="text-sm text-gray-500">Loading admin…</p>
        </div>
      </div>
    )
  }

  if (!user?.isAdmin) return <Navigate to="/adminp" replace />

  return children
}
