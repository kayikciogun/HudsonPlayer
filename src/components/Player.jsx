// ──────────────────────────────────────────────
// src/components/Player.jsx
// Sticky-bottom audio HUD for AES-128 encrypted HLS.
//
// Streaming model (ultra-efficient, decoupled CDN):
//   1. When a track is selected, call the `m3u8` Cloud
//      Function with the track id. It returns the playlist
//      with segment URIs rewritten to absolute Storage URLs
//      (public, no auth) and the key URI pointing to the
//      onRequest /api/key endpoint.
//   2. Feed that text to hls.js as a Blob URL.
//   3. hls.js loads each segment DIRECTLY from Storage
//      (no Cloud Function proxy, no base64 overhead).
//      Cache Storage API caches segments persistently so
//      replaying a track costs zero network.
//   4. The AES-128 key (16 bytes) is fetched once from
//      /api/key with the Firebase ID token. Raw binary,
//      no base64.
//   5. No Storage URL is ever exposed to the client for
//      keys; segments are public but AES-128 encrypted.
// ──────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { httpsCallable } from 'firebase/functions'
import { functions, auth } from '../firebase'

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

async function getAuthToken() {
  const user = auth.currentUser
  if (!user) return null
  try {
    return await user.getIdToken()
  } catch {
    return null
  }
}

// Fetch the AES-128 key from the onRequest key endpoint
// and return a Blob URL. The key is 16 bytes — negligible cost.
async function fetchKeyBlobUrl(trackId) {
  const token = await getAuthToken()
  if (!token) throw new Error('Not authenticated')
  const keyUrl = `https://us-central1-hudson-65e88.cloudfunctions.net/key?id=${encodeURIComponent(trackId)}`
  const res = await fetch(keyUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Key fetch failed: ${res.status}`)
  const buf = await res.arrayBuffer()
  // AES-128 key must be exactly 16 bytes. If we get something else,
  // the endpoint likely returned HTML (SPA fallback) instead of
  // routing to the Cloud Function.
  if (buf.byteLength !== 16) {
    throw new Error(`Bad key size: ${buf.byteLength} (expected 16)`)
  }
  return URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }))
}

// Rewrite only the AES-128 key URI in an m3u8 to a Blob URL.
// The key is fetched once per track from the onRequest endpoint.
async function inlineKeyOnly(text, trackId) {
  const keyMatch = text.match(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/)
  if (!keyMatch) return text
  try {
    const blobUrl = await fetchKeyBlobUrl(trackId)
    return text.replace(
      /#EXT-X-KEY:METHOD=AES-128,URI="[^"]+"/,
      `#EXT-X-KEY:METHOD=AES-128,URI="${blobUrl}"`,
    )
  } catch (err) {
    console.warn('[player] key fetch failed', err?.message)
    return text
  }
}

// Rewrite an m3u8 so every segment/key URI is replaced with a
// data: URL. Used for the Safari native-HLS path.
async function inlineDataUrls(text, trackId) {
  const token = await getAuthToken()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const keyMatch = lines[i].match(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/)
    if (keyMatch) {
      if (token) {
        try {
          const keyUrl = `https://us-central1-hudson-65e88.cloudfunctions.net/key?id=${encodeURIComponent(trackId)}`
          const res = await fetch(keyUrl, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (res.ok) {
            const blob = await res.blob()
            const dataUrl = await new Promise((resolve) => {
              const reader = new FileReader()
              reader.onloadend = () => resolve(reader.result)
              reader.readAsDataURL(blob)
            })
            lines[i] = lines[i].replace(/URI="[^"]+"/, `URI="${dataUrl}"`)
          }
        } catch {
          /* leave as-is */
        }
      }
      continue
    }
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('https://storage.googleapis.com/')) {
      try {
        const res = await fetch(trimmed)
        if (res.ok) {
          const blob = await res.blob()
          const dataUrl = await new Promise((resolve) => {
            const reader = new FileReader()
            reader.onloadend = () => resolve(reader.result)
            reader.readAsDataURL(blob)
          })
          lines[i] = dataUrl
        }
      } catch {
        /* leave as-is */
      }
    }
  }
  return lines.join('\n')
}

// Sum every #EXTINF:<seconds> line in an m3u8 manifest to get the
// real total duration.
function durationFromM3u8(text) {
  if (!text) return 0
  let total = 0
  const re = /^#EXTINF:([0-9]+(?:\.[0-9]+)?)/gm
  let m
  while ((m = re.exec(text))) {
    total += parseFloat(m[1])
  }
  return total
}

function Equalizer({ playing }) {
  return (
    <div className="flex h-3.5 items-end gap-[3px]" aria-hidden>
      <span
        className={`w-[3px] origin-bottom rounded-full bg-ink-900 ${playing ? 'animate-eq-1' : 'h-1 opacity-50'}`}
        style={{ height: playing ? '100%' : undefined }}
      />
      <span
        className={`w-[3px] origin-bottom rounded-full bg-ink-900 ${playing ? 'animate-eq-2' : 'h-1 opacity-50'}`}
        style={{ height: playing ? '100%' : undefined }}
      />
      <span
        className={`w-[3px] origin-bottom rounded-full bg-ink-900 ${playing ? 'animate-eq-3' : 'h-1 opacity-50'}`}
        style={{ height: playing ? '100%' : undefined }}
      />
      <span
        className={`w-[3px] origin-bottom rounded-full bg-ink-900 ${playing ? 'animate-eq-2' : 'h-1 opacity-50'}`}
        style={{ height: playing ? '100%' : undefined }}
      />
    </div>
  )
}

export default function Player({ track, onNext, onPrev }) {
  const audioRef = useRef(null)
  const hlsRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [seeking, setSeeking] = useState(false)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [buffered, setBuffered] = useState({ start: 0, end: 0 })
  const [hoverTime, setHoverTime] = useState(null)

  useEffect(() => {
    if (!track?.id || !audioRef.current) return
    const audio = audioRef.current
    let cancelled = false

    if (hlsRef.current) {
      hlsRef.current.stopLoad()
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    const m3u8Fn = httpsCallable(functions, 'm3u8')

    ;(async () => {
      try {
        const { data } = await m3u8Fn({ id: track.id })
        if (cancelled) return
        const text = data.text

        const manifestDuration = durationFromM3u8(text)
        if (manifestDuration > 0) setDuration(manifestDuration)

        if (Hls.isSupported()) {
          const keyedText = await inlineKeyOnly(text, track.id)
          if (cancelled) return
          const blobUrl = URL.createObjectURL(
            new Blob([keyedText], { type: 'application/vnd.apple.mpegurl' }),
          )

          // Custom fragment loader: fetches segments DIRECTLY from
          // Storage (public, no auth) with Cache Storage API for
          // persistent caching. No Cloud Function proxy, no base64.
          class ProxyLoader {
            constructor(config) {
              this.config = config
              this.stats = this.createStats()
            }
            createStats() {
              return {
                aborted: false,
                loaded: 0,
                retry: 0,
                total: 0,
                chunkCount: 1,
                bwEstimate: 0,
                loading: { start: 0, first: 0, end: 0 },
                parsing: { start: 0, end: 0 },
                buffering: { start: 0, first: 0, end: 0 },
              }
            }
            abort() {
              if (this.controller) {
                this.controller.abort()
              }
            }
            destroy() {
              this.abort()
            }
            async load(context, config, callbacks) {
              const url = context.url || ''
              const file = url.split('/').pop().split('?')[0]

              const stats = this.createStats()
              stats.loading.start = performance.now()

              if (context.frag) {
                context.frag.stats = stats
              }
              this.stats = stats

              this.controller = new AbortController()

              try {
                let response
                let fromCache = false

                if (typeof caches !== 'undefined') {
                  const cache = await caches.open('hls-segments')
                  response = await cache.match(url)
                  if (response) {
                    fromCache = true
                  } else {
                    response = await fetch(url, { signal: this.controller.signal })
                  }
                } else {
                  response = await fetch(url, { signal: this.controller.signal })
                }

                if (!response.ok) throw new Error(`fetch ${file} failed: ${response.status}`)

                // Read body into a detached buffer BEFORE doing anything
                // with cache.put(). If we cache the live response stream,
                // abort() (called by hls.js on the next fragment) will abort
                // the underlying fetch and kill the in-flight cache.put().
                let responseData
                if (context.responseType === 'text') {
                  responseData = await response.text()
                } else {
                  responseData = await response.arrayBuffer()
                }

                // Cache a FRESH Response built from the detached buffer.
                // This is immune to abort() since it no longer references
                // the original fetch's stream.
                if (!fromCache && typeof caches !== 'undefined' && response.ok) {
                  try {
                    const cache = await caches.open('hls-segments')
                    const cached = new Response(responseData, {
                      status: response.status,
                      statusText: response.statusText,
                      headers: response.headers,
                    })
                    cache.put(url, cached)
                  } catch {
                    /* cache write failed — non-fatal */
                  }
                }

                const now = performance.now()
                stats.loaded = responseData.byteLength || responseData.length
                stats.total = stats.loaded
                stats.loading.first = now
                stats.loading.end = now
                stats.parsing.end = now
                stats.buffering.end = now

                callbacks.onSuccess(
                  { url, data: responseData },
                  stats,
                  context,
                  null,
                )
              } catch (err) {
                if (err.name === 'AbortError' || this.controller.signal.aborted) {
                  stats.aborted = true
                  callbacks.onAbort?.(stats, context, null)
                  return
                }
                callbacks.onError(
                  { code: 0, text: err?.message || 'proxy fetch failed' },
                  context,
                  null,
                )
              }
            }
          }

          const hls = new Hls({
            enableWorker: false,
            lowLatencyMode: false,
            fLoader: ProxyLoader,
          })

          hls.loadSource(blobUrl)
          hls.attachMedia(audio)
          hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => {
            console.log('[hls] MANIFEST_PARSED levels=', d.levels.length)
          })
          hls.on(Hls.Events.FRAG_LOADED, (_e, d) => {
            console.log('[hls] FRAG_LOADED', d.frag?.url, 'sn=', d.frag?.sn)
          })
          hls.on(Hls.Events.FRAG_PARSING_ERROR, (_e, d) => {
            console.warn('[hls] FRAG_PARSING_ERROR', d.details, d.reason)
          })
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR && audio.currentTime < 0.5) {
              return
            }
            console.warn('[hls] error', data.type, data.details, data.fatal ? 'FATAL' : '')
            if (data.fatal) console.warn('[hls] fatal', data.type, data.details)
          })

          const tryPlay = () => {
            if (cancelled) return
            setPlaying(true)
            audio.play().then(() => {
              try {
                if (audio.buffered.length > 0) {
                  const start = audio.buffered.start(0)
                  if (audio.currentTime < start + 0.05) {
                    audio.currentTime = start + 0.05
                  }
                }
              } catch {
                /* ignore */
              }
            }).catch((err) => {
              console.warn('[player] play rejected', err?.name, err?.message)
              setPlaying(false)
            })
          }
          hls.once(Hls.Events.MEDIA_ATTACHED, () => {
            hls.once(Hls.Events.FRAG_BUFFERED, () => {
              tryPlay()
            })
          })

          if (!cancelled) hlsRef.current = hls
        } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
          const inlined = await inlineDataUrls(text, track.id)
          if (cancelled) return
          audio.src = URL.createObjectURL(
            new Blob([inlined], { type: 'application/vnd.apple.mpegurl' }),
          )

          setPlaying(true)
          audio.play().catch(() => {
            setPlaying(false)
            if (audio.readyState < 1) {
              const onReady = () => {
                audio.removeEventListener('loadedmetadata', onReady)
                setPlaying(true)
                audio.play().catch(() => setPlaying(false))
              }
              audio.addEventListener('loadedmetadata', onReady)
            }
          })
        }
      } catch (err) {
        console.warn('[player] stream setup failed', err)
      }
    })()

    setCurrent(0)
    setBuffered({ start: 0, end: 0 })
    setHoverTime(null)

    return () => {
      cancelled = true
      if (hlsRef.current) {
        hlsRef.current.stopLoad()
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [track])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume
    audio.muted = muted
  }, [volume, muted])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onMeta = () => {
      const d = audio.duration
      if (Number.isFinite(d) && d > 0) setDuration(d)
    }
    const onProgress = () => {
      try {
        const ranges = audio.buffered
        if (!ranges || ranges.length === 0) return
        const end = ranges.end(ranges.length - 1)
        let start = 0
        for (let i = 0; i < ranges.length; i++) {
          if (ranges.start(i) <= audio.currentTime) {
            start = ranges.start(i)
          }
        }
        setBuffered({ start, end })
      } catch {
        /* ignore */
      }
    }
    const onVol = () => {
      setVolume(audio.volume)
      setMuted(audio.muted)
    }
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('progress', onProgress)
    audio.addEventListener('volumechange', onVol)

    let rafId = 0
    let lastT = -1
    const tick = () => {
      const t = audio.currentTime
      if (t !== lastT) {
        lastT = t
        if (!seekingRef.current) setCurrent(t)
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('progress', onProgress)
      audio.removeEventListener('volumechange', onVol)
    }
  }, [])

  const seekingRef = useRef(false)
  useEffect(() => {
    seekingRef.current = seeking
  }, [seeking])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused || audio.ended) {
      setPlaying(true)
      audio.play().catch(() => setPlaying(false))
    } else {
      setPlaying(false)
      audio.pause()
    }
  }, [])

  const seekTo = useCallback(
    (clientX, rect) => {
      const audio = audioRef.current
      if (!audio || !duration || !rect) return null
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const t = ratio * duration
      audio.currentTime = t
      setCurrent(t)
      return t
    },
    [duration],
  )

  const scrubberRef = useRef(null)
  const wasPausedRef = useRef(true)

  const ratioToTime = useCallback(
    (clientX) => {
      const rect = scrubberRef.current?.getBoundingClientRect()
      if (!rect || !duration) return null
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      return ratio * duration
    },
    [duration],
  )

  const startScrub = useCallback(
    (clientX) => {
      const audio = audioRef.current
      if (!audio || !duration) return
      const wasPaused = audio.paused
      setSeeking(true)
      const t = seekTo(clientX, scrubberRef.current?.getBoundingClientRect())
      if (t != null) setCurrent(t)
      if (!wasPaused) audio.pause()
      wasPausedRef.current = wasPaused
    },
    [duration, seekTo],
  )

  const moveScrub = useCallback(
    (clientX) => {
      if (!seeking) {
        setHoverTime(ratioToTime(clientX))
        return
      }
      const t = seekTo(clientX, scrubberRef.current?.getBoundingClientRect())
      if (t != null) setCurrent(t)
    },
    [seeking, ratioToTime, seekTo],
  )

  const endScrub = useCallback(() => {
    if (!seeking) return
    setSeeking(false)
    const audio = audioRef.current
    if (audio && !wasPausedRef.current) {
      audio.play().catch(() => setPlaying(false))
    }
  }, [seeking])

  useEffect(() => {
    if (!seeking) return
    const onMove = (e) => {
      e.preventDefault()
      moveScrub(e.clientX)
    }
    const onUp = () => endScrub()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [seeking, moveScrub, endScrub])

  const onScrubberKey = useCallback(
    (e) => {
      const audio = audioRef.current
      if (!audio || !duration) return
      const big = e.shiftKey ? 15 : 5
      let next = audio.currentTime
      switch (e.key) {
        case 'ArrowLeft':
          next = Math.max(0, audio.currentTime - big)
          break
        case 'ArrowRight':
          next = Math.min(duration, audio.currentTime + big)
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = duration
          break
        case ' ':
          e.preventDefault()
          togglePlay()
          return
        default:
          return
      }
      e.preventDefault()
      audio.currentTime = next
      setCurrent(next)
    },
    [duration, togglePlay],
  )

  const onSeek = useCallback(
    (e) => startScrub(e.clientX),
    [startScrub],
  )
  const onSeekTouch = useCallback(
    (e) => {
      const t = e.touches[0]
      if (t) startScrub(t.clientX)
    },
    [startScrub],
  )
  const onSeekTouchMove = useCallback(
    (e) => {
      const t = e.touches[0]
      if (t) moveScrub(t.clientX)
    },
    [moveScrub],
  )
  const onSeekTouchEnd = useCallback(() => endScrub(), [endScrub])

  const onVolume = useCallback((e) => {
    const audio = audioRef.current
    if (!audio) return
    const v = parseFloat(e.target.value)
    audio.volume = v
    audio.muted = v === 0
    setVolume(v)
  }, [])

  const toggleMute = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.muted = !audio.muted
    setMuted(audio.muted)
  }, [])

  const progress = duration ? Math.min(100, (current / duration) * 100) : 0
  const bufferStartPct = duration
    ? Math.min(100, (buffered.start / duration) * 100)
    : 0
  const bufferEndPct = duration
    ? Math.min(100, (buffered.end / duration) * 100)
    : 0
  const hoverPct = hoverTime != null && duration
    ? Math.min(100, (hoverTime / duration) * 100)
    : null

  return (
    <div
      className={`glass border-t border-ink-700/40 ${track ? 'shadow-player' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <audio ref={audioRef} preload="metadata" onEnded={onNext} className="hidden" />

      {!track ? (
        <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-4 py-3 text-sm text-gray-500">
          <Equalizer playing={false} />
          <span>Select a track to start listening</span>
        </div>
      ) : (
        <>
          <div
            ref={scrubberRef}
            className="group relative h-2.5 w-full cursor-pointer touch-none bg-ink-700/40"
            onMouseDown={onSeek}
            onMouseMove={(e) => {
              if (!seeking) setHoverTime(ratioToTime(e.clientX))
            }}
            onMouseLeave={() => {
              if (!seeking) setHoverTime(null)
            }}
            onTouchStart={onSeekTouch}
            onTouchMove={onSeekTouchMove}
            onTouchEnd={onSeekTouchEnd}
            onTouchCancel={onSeekTouchEnd}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration) || 0}
            aria-valuenow={Math.floor(current)}
            aria-valuetext={`${fmt(current)} of ${fmt(duration)}`}
            tabIndex={0}
            onKeyDown={onScrubberKey}
          >
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink-700/60 transition-[height] duration-150 group-hover:h-1.5" />

            {bufferEndPct > bufferStartPct && (
              <div
                className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink-500/60 transition-[height] duration-150 group-hover:h-1.5"
                style={{
                  left: `${bufferStartPct}%`,
                  width: `${Math.max(0, bufferEndPct - bufferStartPct)}%`,
                }}
              />
            )}

            {hoverPct != null && (
              <>
                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-white/40"
                  style={{ left: `${hoverPct}%` }}
                />
                <div
                  className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-ink-800/95 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-gray-100 shadow"
                  style={{ left: `${hoverPct}%` }}
                >
                  {fmt(hoverTime)}
                </div>
              </>
            )}

            <div
              className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-accent via-accent-glow to-accent transition-[height] duration-150 group-hover:h-1.5"
              style={{ width: `${progress}%` }}
            />

            <div
              className={`pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-glow-sm ring-2 ring-accent/40 transition duration-150 ${
                playing || seeking || hoverPct != null
                  ? 'opacity-100 scale-100'
                  : 'opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100'
              }`}
              style={{ left: `${progress}%` }}
            />
          </div>

          <div className="mx-auto flex max-w-5xl items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-glow text-ink-900 shadow-glow-sm transition-shadow duration-300 ease-smooth ${
                playing ? 'shadow-glow' : ''
              }`}
              aria-hidden
            >
              {playing ? (
                <Equalizer playing />
              ) : (
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              )}
            </div>

            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-sm font-semibold text-gray-100">
                {track.title}
              </p>
              <div className="flex items-center gap-1 text-[11px] tabular-nums text-gray-500 sm:text-xs">
                <span className="font-medium text-accent">{fmt(current)}</span>
                <span className="opacity-50">/</span>
                <span className="tabular-nums">{fmt(duration)}</span>
                <span className="hidden opacity-50 sm:inline">·</span>
                <span className="hidden truncate sm:inline">{track.artist}</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              <button
                onClick={onPrev}
                aria-label="Previous track"
                className="flex h-11 w-11 min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full text-gray-400 transition-all duration-200 ease-smooth hover:scale-105 hover:bg-ink-700/60 hover:text-gray-100 active:scale-95"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                </svg>
              </button>

              <button
                onClick={togglePlay}
                aria-label={playing ? 'Pause' : 'Play'}
                className="flex h-11 w-11 min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-glow text-ink-900 shadow-glow transition-all duration-200 ease-smooth hover:scale-105 hover:shadow-glow-lg active:scale-95"
              >
                {playing ? (
                  <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                    <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" style={{ marginLeft: 2 }}>
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              <button
                onClick={onNext}
                aria-label="Next track"
                className="flex h-11 w-11 min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full text-gray-400 transition-all duration-200 ease-smooth hover:scale-105 hover:bg-ink-700/60 hover:text-gray-100 active:scale-95"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" />
                </svg>
              </button>
            </div>

            <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
              <button
                onClick={toggleMute}
                aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-gray-400 transition-all duration-200 ease-smooth hover:bg-ink-700/60 hover:text-gray-100 active:scale-95"
              >
                {muted || volume === 0 ? (
                  <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" />
                  </svg>
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={onVolume}
                aria-label="Volume"
                className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-ink-700 accent-accent lg:w-24"
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
