// ──────────────────────────────────────────────
// src/App.jsx
// Routes:
//   /login  → public login screen
//   /       → protected home (player + playlist)
// Everything else redirects to /.
// ──────────────────────────────────────────────
import { Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Home from './pages/Home'
import PrivateRoute from './components/PrivateRoute'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <Home />
          </PrivateRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}