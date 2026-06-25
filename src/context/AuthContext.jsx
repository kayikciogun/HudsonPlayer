// ──────────────────────────────────────────────
// src/context/AuthContext.jsx
// Real Firebase email/password auth, presented to the
// user as a single password field. The username is fixed
// to "hudson" and mapped to hudson@gmail.com.
//
//   - No shared password in the bundle.
//   - No anonymous sign-in (the Cloud Function rejects it).
//   - The account (hudson@gmail.com) is created in the
//     Firebase Console under Authentication → Users.
//   - Session persists via Firebase's default local storage.
// ──────────────────────────────────────────────
import { createContext, useContext, useEffect, useState } from 'react'
import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from 'firebase/auth'
import { auth } from '../firebase'

// The fixed username is mapped to this Firebase Auth email.
const FIXED_EMAIL = 'hudson@gmail.com'

const AuthContext = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      if (fbUser) {
        const email = fbUser.email || ''
        const username = email === FIXED_EMAIL ? 'hudson' : email
        setUser({
          name: username || 'Band member',
          username,
          email: fbUser.email,
          uid: fbUser.uid,
          isAnonymous: fbUser.isAnonymous,
        })
      } else {
        setUser(null)
      }
      setLoading(false)
    })
    return unsub
  }, [])

  async function login(password) {
    const cred = await signInWithEmailAndPassword(auth, FIXED_EMAIL, password)
    return cred.user
  }

  async function logout() {
    try {
      await signOut(auth)
    } catch {
      /* ignore */
    }
  }

  const value = { user, loading, login, logout }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}