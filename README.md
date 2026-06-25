# Hudson

A private, invite-only music player for streaming a band's repertoire securely. Built with **React + Vite + Tailwind CSS + Firebase (Auth + Storage + Cloud Functions)** and an **AES-128 encrypted HLS** backend served through an **auth-gated base64 proxy** — no Storage URL is ever exposed to the client, signed or otherwise.

---

## How it works

The core design choice is a **proxy model, not signed URLs**. 2nd-gen Cloud Functions cannot mint V4 signed URLs without the `iam.serviceAccounts.signBlob` permission (not granted by default), so instead every function reads the bytes from Storage via the Admin SDK and returns them directly to the authenticated caller. The Storage bucket is never publicly addressable.

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
  │ .jsx     │                           │  <id>/index.m3u8│
  │          │                           └────────────────┘
  │          │    3. segment({ id, file })  per .ts / .key
  │  hls.js  │ ────────────────────────▶ ┌────────────────┐
  │  custom  │ ◀── { base64, contentType}│  reads bytes,  │
  │  fLoader │                           │  base64-encodes│
  └──────────┘                           └────────────────┘
```

1. **`catalogue()`** — lists track ids by scanning the `tracks-hls/` Storage prefix. Returns `{ id, title }` only; no URLs.
2. **`m3u8({ id })`** — returns the `index.m3u8` as a string. The on-disk playlist contains **relative** file names (`seg_000.ts`, `<id>.key`), never baked-in tokens.
3. **`segment({ id, file })`** — returns a single `.ts` segment or `.key` file as **base64** in JSON (callable functions can't carry raw binary). The player converts it to a Blob URL.

### Client-side playback (`Player.jsx`)

Two paths depending on browser HLS support:

- **hls.js path (Chrome/Firefox):** the m3u8 text is fed to hls.js as a **Blob URL**. The AES-128 key URI is pre-resolved to a Blob URL inside the manifest (the key is tiny ~16 B). A **custom fragment loader** (`ProxyLoader`) intercepts every segment load: it calls the `segment` callable, converts the base64 response to a Blob, and hands it to hls.js. Segments are fetched **on demand** — playback starts as soon as the first segment arrives, no pre-fetch of the whole track.
- **Safari native HLS:** every segment and key is inlined as a `data:` URL into the m3u8, then the whole Blob is fed to `<audio>`. The proxy URL never appears in DevTools.

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
├── storage.rules           ← auth-gated Storage rules
├── functions/
│   ├── .env.example        ← GOOGLE_APPLICATION_CREDENTIALS (local dev)
│   ├── package.json
│   └── index.js            ← catalogue / m3u8 / segment callables (proxy model)
├── hls_build/              ← generated HLS output (gitignored)
├── public/
│   └── playlists.json
├── scripts/
│   ├── encrypt_hls.sh      ← MP3 → AES-128 HLS segments + key (FFmpeg + openssl)
│   ├── upload_hls.mjs      ← push segments/keys/m3u8 to Storage (service-account JWT)
│   ├── relativize_m3u8.mjs ← rewrite m3u8 URIs to relative file names
│   ├── sign_m3u8.mjs       ← (legacy) bake signed URLs into m3u8 — not used by proxy model
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
    │   ├── Player.jsx       ← hls.js + custom ProxyLoader + rAF time poll
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

`storage.rules` denies every path by default. Only `/keys/**` and `/tracks-hls/**` are readable by authenticated users; everything else (including legacy `/tracks/**`) is hard-closed.

### 4. Deploy the Cloud Functions

```bash
cd functions && npm install && cd ..
firebase deploy --only functions
```

Deploys three callable functions (`us-central1`): **`catalogue`**, **`m3u8`**, **`segment`**. Each verifies `request.auth` and rejects anonymous sign-in.

### 5. Generate HLS, encrypt, upload, relativize

```bash
# 1. Drop source MP3s into a local mp3_export/ folder (gitignored, not in repo)
# 2. Encrypt + segment into hls_build/
bash scripts/encrypt_hls.sh
# 3. Upload segments + AES keys + m3u8 to Storage
node scripts/upload_hls.mjs
# 4. Rewrite every m3u8 to relative URIs (no baked tokens)
node scripts/relativize_m3u8.mjs
# 5. Re-upload the relativized m3u8s
node scripts/upload_hls.mjs
```

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
| `storage.rules` (default deny, `request.auth != null` on `/keys/**` + `/tracks-hls/**`) | Unauthenticated reads return 403 — no public access anywhere |
| Cloud Function base64 proxy | Verifies Firebase ID token on every `catalogue` / `m3u8` / `segment` call; reads bytes server-side, returns them as base64 — **no Storage URL ever reaches the client** |
| Relative m3u8 URIs | No long-lived tokens baked into playlists; segments resolved per-request through the proxy |
| CORS locked to hosting origin (+ localhost for dev) | Hotlinking / bandwidth theft from other sites |

> Client-side measures cannot fully prevent a determined attacker who can capture decrypted audio post-DSP. For true DRM use Widevine/FairPlay/PlayReady with a license server. The current model raises the bar from "one `curl | ffmpeg`" to "authenticated session + server-side proxy + no exposed Storage URLs," appropriate for a private band repertoire.

---

## Build & deploy

```bash
npm run build          # Vite production build → dist/
firebase deploy --only hosting
```

Live URL after deploy (e.g. `https://hudson-65e88.web.app`).

---

Made for the band.