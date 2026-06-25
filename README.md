# Hudson

A private, invite-only music player for streaming a band's repertoire securely. Built with **React + Vite + Tailwind CSS + Firebase (Auth + Storage + Cloud Functions)** and an **AES-128 encrypted HLS** backend using a **decoupled CDN architecture** — encrypted segments are served directly from public Cloud Storage (useless without the key), while the 16-byte AES key is gated behind an auth-verified HTTP function.

---

## How it works

The core design choice is a **decoupled CDN model**. Segments are AES-128 encrypted, so they can be served **directly from Cloud Storage** (public read, no Cloud Function proxy) — saving ~100% of Cloud Function egress cost and eliminating the 33% base64 overhead. Only the 16-byte AES key is protected, served via an `onRequest` HTTP function that validates the Firebase ID token from the `Authorization` header and returns raw binary (no base64).

### Streaming flow (per track)

```
  ┌──────────┐    1. catalogue()         ┌────────────────┐
  │  Home.jsx│ ────────────────────────▶ │ Cloud Function │
  │          │ ◀──────── { tracks:[…] } │  (functions/)  │
  └────┬─────┘                           └───────┬────────┘
       │ user picks a track                       │ Admin SDK
       ▼                                          ▼
  ┌──────────┐    2. m3u8({ id })        ┌────────────────┐
  │          │ ────────────────────────▶ │  reads         │
  │ Player   │ ◀──────── { text }       │  tracks-hls/   │
  │ .jsx     │  (segment URIs rewritten │  <id>/index.m3u8│
  │          │   to absolute Storage    └────────────────┘
  │          │   URLs; key URI → /key)
  │          │    3. key (onRequest)        16 bytes raw
  │  hls.js  │ ────────────────────────▶ ┌────────────────┐
  │  custom  │ ◀── 16 bytes (raw binary)│  verifies ID   │
  │  fLoader │                           │  token, reads  │
  │          │    4. segments (direct)   │  keys/<id>.key │
  │          │ ────────────────────────▶ └────────────────┘
  │          │ ◀── raw .ts (public CDN)
  │          │    https://storage.googleapis.com/...
  │          │    + Cache Storage API for persistent cache
  └──────────┘
```

1. **`catalogue()`** — lists track ids by scanning the `tracks-hls/` Storage prefix. Returns `{ id, title }` only; no URLs.
2. **`m3u8({ id })`** — returns the `index.m3u8` as a string with segment URIs rewritten to **absolute Storage URLs** (public CDN) and the key URI pointing to the `key` onRequest endpoint.
3. **`key` (onRequest HTTP)** — validates the Firebase ID token from the `Authorization: Bearer` header, reads the 16-byte AES key from Storage, and returns it as **raw binary** (no base64 overhead).
4. **Segments** — fetched **directly from Cloud Storage** (public read, AES-128 encrypted). The client uses the **Cache Storage API** for persistent caching — replaying a track costs zero network traffic.

### Cost optimizations

| Optimization | Saving |
|---|---|
| Segments served directly from Storage (no CF proxy) | ~100% of CF egress for segments |
| Raw binary key (no base64) | 33% smaller key transfer |
| 10-second segments (`-hls_time 10`) | ~40% fewer HTTP requests vs 6s |
| Cache Storage API persistent caching | ~100% on replay (zero network) |
| Public Storage read for encrypted segments | No CF invocation cost per segment |

### Client-side playback (`Player.jsx`)

Two paths depending on browser HLS support:

- **hls.js path (Chrome/Firefox):** the m3u8 text is fed to hls.js as a **Blob URL**. The AES-128 key URI is pre-resolved to a Blob URL inside the manifest (the key is tiny ~16 B). A **custom fragment loader** (`ProxyLoader`) fetches segments **directly from Storage** with the **Cache Storage API** for persistent caching. Segments are fetched **on demand** — playback starts as soon as the first segment arrives, no pre-fetch of the whole track.
- **Safari native HLS:** the key is inlined as a `data:` URL into the m3u8, segments are left as absolute Storage URLs, then the whole Blob is fed to `<audio>`.

### Known Chrome quirk: `duration === Infinity`

hls.js + Blob-URL sources in Chrome report `audio.duration === Infinity` (an MSE bug). The player works around this by **summing every `#EXTINF` line in the manifest** (`durationFromM3u8()`) and using that finite value for seek math and time tracking.

### Time updates: rAF poll, not `timeupdate`

`timeupdate` fires unreliably for hls.js + MSE sources in Chrome, so the playhead would freeze. The player runs a **`requestAnimationFrame` poll** that reads `audio.currentTime` each frame and writes to state only when the value actually changes (avoids 60 re-renders/sec).

### Auth model

A **single shared Firebase Auth account** (`hudson@gmail.com`) is created in the Firebase Console. The username is hardcoded to `hudson` and mapped to that fixed email. There is no anonymous sign-in; the Cloud Functions reject `sign_in_provider === 'anonymous'`. Session persists via Firebase's default local storage.

---

## Folder structure

```
WEB_Audiostream/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── cors.json               ← Storage CORS (hosting origin + localhost)
├── firebase.json           ← hosting + storage + functions + emulators
├── storage.rules           ← public segments, auth-gated keys
├── functions/
│   ├── .env.example        ← GOOGLE_APPLICATION_CREDENTIALS (local dev)
│   ├── package.json
│   └── index.js            ← catalogue / m3u8 callables + key onRequest
├── hls_build/              ← generated HLS output (gitignored)
├── public/
│   └── playlists.json
├── scripts/
│   ├── encrypt_hls.sh      ← MP3 → AES-128 HLS segments + key (FFmpeg + openssl, 10s)
│   ├── upload_hls.mjs      ← push segments/keys/m3u8 to Storage (service-account JWT)
│   ├── relativize_m3u8.mjs ← rewrite m3u8 URIs to relative file names
│   ├── sign_m3u8.mjs       ← (legacy) bake signed URLs into m3u8 — not used
│   ├── seed_emulator.mjs   ← seed auth + storage for local emulator
│   └── seed_emulator.cjs
└── src/
    ├── main.jsx            ← entry point
    ├── App.jsx             ← routes (/login, /)
    ├── index.css           ← Tailwind + global styles
    ├── firebase.js         ← Firebase init (auth + storage + functions, region us-central1)
    ├── context/
    │   └── AuthContext.jsx  ← single-account email/password auth
    ├── components/
    │   ├── PrivateRoute.jsx
    │   ├── Player.jsx       ← hls.js + custom ProxyLoader + Cache Storage API + rAF time poll
    │   └── Playlist.jsx
    └── pages/
        ├── Login.jsx
        └── Home.jsx         ← catalogue via Cloud Function, track selection
```

---

## Getting started

### 1. Install dependencies

```bash
npm install
cd functions && npm install && cd ..
```

### 2. Configure Firebase

1. [Firebase Console](https://console.firebase.google.com/) → create a project.
2. **Authentication → Sign-in method → enable Email/Password.** Do **not** enable Anonymous — the Cloud Functions reject it.
3. **Storage → Get started** (bucket, any region).
4. **Project Settings → Your apps → Web app** → copy the config values.
5. Create a root `.env` (or `.env.local`) with the Vite env vars (there is no committed example — use the keys in `src/firebase.js`):

   ```env
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=...
   VITE_FIREBASE_PROJECT_ID=...
   VITE_FIREBASE_STORAGE_BUCKET=...
   VITE_FIREBASE_MESSAGING_SENDER_ID=...
   VITE_FIREBASE_APP_ID=...
   VITE_FIREBASE_MEASUREMENT_ID=...
   # Optional: point at local emulators
   # VITE_USE_EMULATOR=true
   ```

6. **Create the shared account** under Authentication → Users → Add user, email `hudson@gmail.com`, set the password you want to give the band.

### 3. Apply Storage rules + CORS

```bash
firebase deploy --only storage
gsutil cors set cors.json gs://hudson-65e88.firebasestorage.app
```

`storage.rules` denies every path by default. `/tracks-hls/**` is **public read** (segments are AES-128 encrypted — useless without the key). `/keys/**` is auth-gated. Everything else (including legacy `/tracks/**`) is hard-closed.

### 4. Deploy the Cloud Functions

```bash
cd functions && npm install && cd ..
firebase deploy --only functions
```

Deploys two callable functions + one HTTP function (`us-central1`): **`catalogue`** (onCall), **`m3u8`** (onCall), **`key`** (onRequest). The callables verify `request.auth`; the HTTP function verifies the Firebase ID token from the `Authorization` header.

### 5. Generate HLS, encrypt, upload

```bash
# 1. Drop source MP3s into a local mp3_export/ folder (gitignored, not in repo)
# 2. Encrypt + segment into hls_build/ (10-second segments, AES-128)
bash scripts/encrypt_hls.sh
# 3. Upload segments + AES keys + m3u8 to Storage
node scripts/upload_hls.mjs
```

The m3u8 Cloud Function rewrites segment URIs to absolute Storage URLs and the key URI to the `key` endpoint **on the fly**, so the on-disk m3u8 stays with relative URIs — no `relativize_m3u8.mjs` step needed with the new architecture.

`upload_hls.mjs` authenticates with the service-account JSON via a signed JWT → OAuth2 token. Place the JSON at the repo root or set `GOOGLE_APPLICATION_CREDENTIALS`. The JSON is gitignored — **never commit it.**

### 6. Run locally

```bash
npm run dev
```

Open http://localhost:5173. To test the full auth + proxy flow against emulators: set `VITE_USE_EMULATOR=true` and run `firebase emulators:start` (use `scripts/seed_emulator.mjs` to seed auth + storage).

---

## Security model

| Layer | What it stops |
|-------|---------------|
| Email/password auth (no anonymous) | Bundle-secret scraping; the password is never in the client code |
| `storage.rules` (public segments, auth-gated keys) | Segments are encrypted → useless without the key; keys require auth |
| `key` onRequest (verifies Firebase ID token) | Unauthenticated key requests return 401; raw binary, no base64 |
| AES-128 encrypted segments | Even if downloaded directly from Storage, audio is unintelligible without the 16-byte key |
| CORS locked to hosting origin (+ localhost for dev) | Hotlinking / bandwidth theft from other sites |

> Client-side measures cannot fully prevent a determined attacker who can capture decrypted audio post-DSP. For true DRM use Widevine/FairPlay/PlayReady with a license server. The current model relies on AES-128 encryption for segments (safe to serve publicly) with the key gated behind auth — appropriate for a private band repertoire.

---

## Build & deploy

```bash
npm run build          # Vite production build → dist/
firebase deploy --only hosting
```

Live URL after deploy (e.g. `https://hudson-65e88.web.app`).

---

Made for the band.