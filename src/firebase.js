// ──────────────────────────────────────────────
// src/firebase.js — Firebase initialization
// Reads config from Vite env vars (see .env.example).
// Exposes auth + storage + functions singletons.
//
// In local dev, set VITE_USE_EMULATOR=true in .env.local
// to point auth + functions at the Firebase emulators
// (firebase emulators:start). This lets us test the
// hardened auth + proxy flow without touching production.
// ──────────────────────────────────────────────
import { initializeApp } from 'firebase/app'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getStorage } from 'firebase/storage'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import { getAnalytics, isSupported } from 'firebase/analytics'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
}

// Initialize core Firebase services
const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const storage = getStorage(app)
// Cloud Functions — region must match functions/index.js onCall({ region }).
export const functions = getFunctions(app, 'us-central1')

// Local emulator wiring. Only active when VITE_USE_EMULATOR=true.
// The emulators run on localhost via `firebase emulators:start`.
if (import.meta.env.VITE_USE_EMULATOR === 'true') {
  connectAuthEmulator(auth, 'http://localhost:9099')
  connectFunctionsEmulator(functions, 'localhost', 5001)
}

// Analytics is only available in browser environments that support it.
// isSupported() guards against SSR / unsupported browsers (e.g. private mode).
export let analytics = null
isSupported()
  .then((ok) => {
    if (ok) analytics = getAnalytics(app)
  })
  .catch(() => {
    /* analytics not supported — safe to ignore */
  })

export default app