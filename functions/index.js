// ──────────────────────────────────────────────
// functions/index.js
//
// Cloud Functions that gate access to the Hudson HLS catalogue.
//
// Approach: PROXY, not signed URLs.
//   - We never mint a Storage signed URL (which needs the
//     iam.serviceAccounts.signBlob permission that 2nd-gen
//     functions don't get by default). Instead, each function
//     reads the bytes from Storage via the Admin SDK and
//     returns them to the caller. The Storage object is never
//     publicly addressable.
//   - Every function verifies request.auth (Firebase ID token)
//     and rejects anonymous sign-in.
//
// Endpoints (all callable):
//
//   catalogue()  → { tracks: [{ id, title }] }
//     Lists every track by scanning the Storage prefix
//     tracks-hls/. No URLs are returned.
//
//   m3u8({ id })  → { text }
//     Returns the index.m3u8 as a string. The on-disk m3u8
//     contains relative URIs (seg_000.ts / <id>.key); the
//     player feeds this to hls.js as a Blob and resolves each
//     line via segment().
//
//   segment({ id, file })  → { base64, contentType }
//     Returns a single .ts segment or .key file as base64.
//     The player turns it into a Blob URL for hls.js.
//
// Why base64 for segments: callable functions return JSON,
// which cannot carry raw binary. base64 is the simplest
// transport. Segments are ~6s of 128kbps audio ≈ 100 KB,
// well within the callable response limit (10 MB).
// ──────────────────────────────────────────────
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { initializeApp } = require('firebase-admin/app')
const { getStorage } = require('firebase-admin/storage')

initializeApp()

const BUCKET = 'hudson-65e88.firebasestorage.app'
const SEGMENT_RE = /^seg_\d{3}\.ts$/
// Track ids contain Turkish letters (Ş, Ö, İ, ç, ğ, …) — allow any
// Unicode letter/digit/underscore/hyphen.
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

// Read a Storage file into a Buffer.
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
// Returns the index.m3u8 as a string. The on-disk m3u8
// contains relative URIs; the player feeds it to hls.js
// as a Blob and resolves each line via segment().
exports.m3u8 = onCall(
  { region: 'us-central1', cors: true },
  async (req) => {
    assertAuth(req)
    const id = safeId(req.data?.id)

    const buf = await readBytes(`tracks-hls/${id}/index.m3u8`)
    return { text: buf.toString('utf8') }
  },
)

// ─── segment ────────────────────────────────────
// Returns a single segment or key as base64 + content type.
exports.segment = onCall(
  { region: 'us-central1', cors: true },
  async (req) => {
    assertAuth(req)
    const id = safeId(req.data?.id)
    const file = req.data?.file
    if (typeof file !== 'string') {
      throw new HttpsError('invalid-argument', 'Bad file name.')
    }

    let path, contentType
    if (SEGMENT_RE.test(file)) {
      path = `tracks-hls/${id}/${file}`
      contentType = 'video/mp2t'
    } else if (KEY_RE.test(file) && file === `${id}.key`) {
      path = `keys/${file}`
      contentType = 'application/octet-stream'
    } else {
      throw new HttpsError('invalid-argument', 'Unsupported file.')
    }

    const buf = await readBytes(path)
    return {
      base64: buf.toString('base64'),
      contentType,
    }
  },
)