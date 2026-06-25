// ──────────────────────────────────────────────
// src/pages/AdminLogin.jsx
// Admin-only login screen at /adminp.
// Uses the same Firebase email/password auth as the
// main app, but signs in with the fixed admin email.
// ──────────────────────────────────────────────
import { useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function AdminLogin() {
  const { user, login } = useAuth()
  const navigate = useNavigate()

  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // If a non-admin user is already signed in, offer to switch accounts.
  if (user && !user.isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-950 px-4 py-8 sm:px-6">
        <div className="w-full max-w-sm text-center">
          <h1 className="bg-gradient-to-r from-accent via-accent-glow to-accent bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
            Hudson
          </h1>
          <p className="mt-2 text-sm text-gray-400">Admin panel · invite only</p>
          <p className="mt-6 text-sm text-gray-300">
            Signed in as <strong className="text-accent">{user.email}</strong>.
          </p>
          <p className="mt-2 text-xs text-gray-500">
            Please sign out and enter the admin password.
          </p>
          <button
            onClick={logout}
            className="mt-6 w-full rounded-lg border border-ink-600 bg-ink-800 px-4 py-2 text-sm font-medium text-gray-200 transition hover:bg-ink-700"
          >
            Sign out
          </button>
        </div>
      </div>
    )
  }

  // Already logged in as admin → go to dashboard.
  if (user?.isAdmin) return <Navigate to="/admin/dashboard" replace />

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await login(password, 'admin@gmail.com')
      navigate('/admin/dashboard')
    } catch (err) {
      const code = err?.code || ''
      if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
        setError('Wrong password.')
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts. Try again later.')
      } else {
        setError('Something went wrong.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-4 py-8 sm:px-6">
      <div className="w-full max-w-sm" onContextMenu={(e) => e.preventDefault()}>
        <div className="mb-6 text-center sm:mb-8">
          <h1 className="bg-gradient-to-r from-accent via-accent-glow to-accent bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
            Hudson
          </h1>
          <p className="mt-2 text-sm text-gray-400">Admin panel · invite only</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-ink-700/60 glass p-5 shadow-glow sm:p-6"
        >
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-gray-400">
              Admin password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              className="w-full cursor-text rounded-lg border border-ink-600 bg-ink-900/60 px-3 py-3 text-base text-gray-100 outline-none transition-all duration-200 ease-smooth placeholder:text-gray-600 focus:border-accent focus:bg-ink-900 focus:ring-2 focus:ring-accent/30 sm:text-sm"
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full cursor-pointer rounded-lg bg-gradient-to-br from-accent to-accent-glow py-3 text-sm font-semibold text-ink-900 shadow-glow-sm transition-all duration-200 ease-smooth hover:shadow-glow active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-glow-sm sm:py-2.5"
          >
            {busy ? 'Please wait…' : 'Enter admin'}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-gray-500">Ask the band for the admin password.</p>
      </div>
    </div>
  )
}
