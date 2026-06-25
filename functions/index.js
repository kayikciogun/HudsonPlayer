// ──────────────────────────────────────────────
// functions/index.js
//
// Cloud Functions that gate access to the Hudson HLS catalogue.
//
// Architecture (ultra-efficient, decoupled CDN):
//   - .ts segments are AES-128 encrypted → public Storage read.
//     The client fetches them DIRECTLY from Storage (no CF proxy),
//     saving ~100% of Cloud Function egress cost.
//   - The 16-byte AES key is the only secret. It is served via
//     an onRequest HTTP function that validates the Firebase ID
//     token from the Authorization header and returns raw binary
//     (no base64 overhead).
//   - The m3u8 playlist is served via onCall (JSON, small payload)
//     with segment URIs rewritten to absolute Storage URLs and
//     the key URI pointing to the onRequest endpoint.
//
// Endpoints:
//
//   catalogue()  → { tracks: [{ id, title }] }
//     Lists every track by scanning the Storage prefix tracks-hls/.
//
//   m3u8({ id })  → { text }
//     Returns the index.m3u8 with segment URIs rewritten to
//     absolute Storage URLs and the key URI pointing to the
//     onRequest key endpoint.
//
//   key  (onRequest HTTP GET /key?id=<trackId>)
//     Returns the raw 16-byte AES-128 key as binary (no base64).
//     Requires Authorization: Bearer <idToken> header.
// ──────────────────────────────────────────────
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https')
const { initializeApp } = require('firebase-admin/app')
const { getStorage } = require('firebase-admin/storage')
const { getAuth } = require('firebase-admin/auth')

initializeApp()

const BUCKET = 'hudson-65e88.firebasestorage.app'
const STORAGE_BASE = `https://storage.googleapis.com/${BUCKET}`
const ID_RE = /^[\p{L}\p{N}_-]+$/u
const KEY_RE = /^[\p{L}\p{N}_-]+\.key$/u

const bucket = getStorage().bucket(BUCKET)

// ─── Helpers ───────────────────────────────────

function assertAuth(req) {
  if (!req.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.')
  }
  if (
    req.auth.uid == null ||
    req.auth.token?.firebase?.sign_in_provider === 'anonymous'
  ) {
    throw new HttpsError('unauthenticated', 'Anonymous sign-in is not allowed.')
  }
}

function safeId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new HttpsError('invalid-argument', 'Bad track id.')
  }
  return id
}

async function readBytes(path) {
  const [buf] = await bucket.file(path).download()
  return buf
}

// ─── catalogue ─────────────────────────────────
exports.catalogue = onCall(
  { region: 'us-central1', cors: true },
  async (req) => {
    assertAuth(req)

    const [files] = await bucket.getFiles({ prefix: 'tracks-hls/' })
    const ids = new Set()
    for (const f of files) {
      const m = f.name.match(/^tracks-hls\/([\p{L}\p{N}_-]+)\//u)
      if (m) ids.add(m[1])
    }

    const tracks = [...ids].sort().map((id) => ({
      id,
      title: id.replace(/^\d+/, '').replace(/_/g, ' ').trim(),
    }))

    return { tracks }
  },
)

// ─── m3u8 ──────────────────────────────────────
// Returns the index.m3u8 with segment URIs rewritten to absolute
// Storage URLs (public, no auth needed) and the key URI pointing
// to the onRequest key endpoint (auth-gated).
exports.m3u8 = onCall(
  { region: 'us-central1', cors: true },
  async (req) => {
    assertAuth(req)
    const id = safeId(req.data?.id)

    const buf = await readBytes(`tracks-hls/${id}/index.m3u8`)
    let text = buf.toString('utf8')

    // Rewrite segment URIs to absolute Storage URLs (public read).
    // seg_000.ts → https://storage.googleapis.com/<bucket>/tracks-hls/<id>/seg_000.ts
    text = text.replace(
      /^(seg_\d{3}\.ts)$/gm,
      `${STORAGE_BASE}/tracks-hls/${encodeURIComponent(id)}/$1`,
    )

    // Rewrite key URI to the onRequest key endpoint.
    // <id>.key → /api/key?id=<id>
    text = text.replace(
      /#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/,
      (match, uri) => {
        const keyFile = uri.split('/').pop()
        if (KEY_RE.test(keyFile)) {
          return `#EXT-X-KEY:METHOD=AES-128,URI="/api/key?id=${encodeURIComponent(id)}"`
        }
        return match
      },
    )

    return { text }
  },
)

// ─── key (onRequest) ───────────────────────────
// Returns the raw 16-byte AES-128 key as binary.
// Validates the Firebase ID token from the Authorization header.
// No base64 — the client receives the raw bytes directly.
exports.key = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    // CORS preflight
    res.set('Access-Control-Allow-Origin', req.headers.origin || '*')
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.set('Access-Control-Max-Age', '3600')

    if (req.method === 'OPTIONS') {
      res.status(204).send('')
      return
    }

    if (req.method !== 'GET') {
      res.status(405).send('Method Not Allowed')
      return
    }

    // Validate auth token from Authorization header
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).send('Unauthorized')
      return
    }
    const idToken = authHeader.split('Bearer ')[1]
    let decoded
    try {
      decoded = await getAuth().verifyIdToken(idToken)
    } catch {
      res.status(401).send('Unauthorized')
      return
    }
    if (
      !decoded.uid ||
      decoded.firebase?.sign_in_provider === 'anonymous'
    ) {
      res.status(401).send('Unauthorized')
      return
    }

    const id = req.query.id
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      res.status(400).send('Bad track id')
      return
    }

    try {
      const buf = await readBytes(`keys/${id}.key`)
      res.set('Content-Type', 'application/octet-stream')
      res.set('Cache-Control', 'private, max-age=300')
      res.send(buf)
    } catch {
      res.status(404).send('Key not found')
    }
  },
)
