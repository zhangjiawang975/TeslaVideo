'use strict'

const CAMERA_NAMES = {
  front: '前',
  back: '后',
  left_repeater: '左',
  right_repeater: '右',
  left_pillar: '左B柱',
  right_pillar: '右B柱',
}
const KIND_NAMES = { sentry: '哨兵', saved: '保存', recent: '行车' }
const WEEKDAYS = '日一二三四五六'
const MIN_RANGE = 0.5
const FRAME = 1 / 36
const DRIFT = 0.15
// Playback starts this many seconds before the recorded event moment.
const EVENT_LEAD = 10

function reasonName(reason = '') {
  if (reason.startsWith('sentry_aware_object')) return '物体靠近'
  if (reason.startsWith('sentry_aware_accel')) return '车身震动'
  if (reason.startsWith('sentry')) return '哨兵'
  if (reason === 'user_interaction_honk') return '鸣笛保存'
  if (reason === 'user_interaction_voice') return '语音保存'
  if (reason.startsWith('user_interaction')) return '手动保存'
  if (reason.includes('emergency_braking')) return '紧急制动'
  return reason
}

const $ = id => document.getElementById(id)
const el = {
  openBtn: $('openBtn'), rootPath: $('rootPath'), tabs: [...document.querySelectorAll('#tabs button')],
  eventList: $('eventList'), emptyHint: $('emptyHint'),
  videos: $('videos'), topbar: $('topbar'), overlay: $('overlay'), overlayCam: $('overlayCam'), overlayTime: $('overlayTime'),
  placeholder: $('placeholder'), playBtn: $('playBtn'), timeText: $('timeText'), clockText: $('clockText'),
  rateSel: $('rateSel'), track: $('track'), scroller: $('scroller'), thumb: $('thumb'), ticks: $('ticks'), dimL: $('dimL'), dimR: $('dimR'), range: $('range'),
  handleL: $('handleL'), handleR: $('handleR'), playhead: $('playhead'), eventMark: $('eventMark'),
  setInBtn: $('setInBtn'), setOutBtn: $('setOutBtn'), resetBtn: $('resetBtn'),
  inText: $('inText'), outText: $('outText'), durText: $('durText'),
  modeSel: $('modeSel'), outDirBtn: $('outDirBtn'), exportBtn: $('exportBtn'),
  zoomBadge: $('zoomBadge'),
  toast: $('toast'), toastText: $('toastText'), toastAction: $('toastAction'), toastClose: $('toastClose'),
  hud: $('hud'), hudChk: $('hudChk'), hudSpeed: $('hudSpeed'), hudLeft: $('hudLeft'), hudRight: $('hudRight'),
  hudBrake: $('hudBrake'), hudPedal: $('hudPedal'), hudPedalBar: $('hudPedalBar'),
  gears: [...document.querySelectorAll('[data-gear]')],
}

const store = {
  get: k => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
}

const state = {
  events: [],
  tab: store.get('tab') || 'all',
  ev: null,
  // Segments on the event timeline: offset = seconds from event start (wall clock, so the
  // ~1 s gaps Tesla leaves between files are preserved and timestamps stay exact).
  segs: [], // { startEpoch, files, offset, dur }
  segIdx: -1,
  cells: [], // { camera, video, node }
  mainIdx: 0,
  preferredCamera: store.get('camera') || 'front',
  playing: false,
  in: 0,
  out: 0,
  outAtEnd: true,
  outDir: store.get('outDir') || '',
  exporting: false,
  telemetry: null, // current segment: { t: [], frames: [{ speed, gear, pedal, blinkL, blinkR, brake }] }
  telCache: new Map(),
  view: null, // zoomed timeline window { a, b } in seconds; null = whole event
}

// ---------- formatting ----------
const pad = n => String(n).padStart(2, '0')

function fmtRel(t, cs = false) {
  t = Math.max(0, t)
  const s = Math.floor(t)
  const base = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
  return cs ? `${base}.${pad(Math.floor((t - s) * 100))}` : base
}

// Wall-clock seconds are stored as UTC epochs, so always use UTC getters
// (same as ffmpeg's pts:gmtime in the export).
const utc = epochSec => new Date(Math.floor(epochSec) * 1000)
const fmtTime = (e) => { const d = utc(e); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` }
const fmtDate = (e) => { const d = utc(e); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` }
const fmtClock = e => `${fmtDate(e)} ${fmtTime(e)}`
const fmtDay = (e) => { const d = utc(e); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 周${WEEKDAYS[d.getUTCDay()]}` }

// ---------- event list ----------
async function openFolder(root, restoring = false) {
  if (!root) return false
  const events = await window.api.scan(root)
  if (!events.length) {
    if (!restoring) showHint('该目录下没有找到特斯拉视频')
    return false
  }
  store.set('lastFolder', root)
  state.events = events
  el.rootPath.textContent = root
  el.rootPath.title = root
  renderList()
  loadEvent(visibleEvents()[0] || events[0])
  return true
}

function showHint(text) {
  el.emptyHint.textContent = text
  el.emptyHint.hidden = false
}

const visibleEvents = () => state.events.filter(e => state.tab === 'all' || e.kind === state.tab)

const lazyVideos = new IntersectionObserver((entries) => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting) continue
    target.src = target.dataset.src
    lazyVideos.unobserve(target)
  }
}, { root: el.eventList })

function eventCard(ev) {
  const card = document.createElement('div')
  card.className = 'card'
  const thumb = document.createElement('div')
  thumb.className = 'thumb'
  if (ev.thumb) {
    const img = document.createElement('img')
    img.loading = 'lazy'
    img.src = ev.thumb
    thumb.append(img)
  } else {
    // No thumb.png (RecentClips): show an early frame of the front camera.
    const first = ev.segments[0].files
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'
    video.dataset.src = `${(first.front || Object.values(first)[0]).url}#t=1`
    lazyVideos.observe(video)
    thumb.append(video)
  }
  const len = document.createElement('span')
  len.className = 'len'
  const last = ev.segments[ev.segments.length - 1]
  len.textContent = `${Math.max(1, Math.round((last.startEpoch - ev.startEpoch + 60) / 60))} 分钟`
  thumb.append(len)

  const info = document.createElement('div')
  info.className = 'info'
  const l1 = document.createElement('div')
  l1.className = 'l1'
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = fmtTime(ev.startEpoch).slice(0, 5)
  const badge = document.createElement('span')
  badge.className = `badge ${ev.kind}`
  badge.textContent = ev.event?.reason ? reasonName(ev.event.reason) : KIND_NAMES[ev.kind]
  l1.append(time, badge)
  const l2 = document.createElement('div')
  l2.className = 'l2'
  l2.textContent = ev.event
    ? [ev.event.city, ev.event.street].filter(Boolean).join(' · ') || '未知地点'
    : `${fmtTime(ev.startEpoch).slice(0, 5)} – ${fmtTime(last.startEpoch + 60).slice(0, 5)}`
  const l3 = document.createElement('div')
  l3.className = 'l3'
  l3.textContent = `${ev.segments.length} 段 · ${ev.cameras.length} 个视角`
  info.append(l1, l2, l3)

  card.append(thumb, info)
  card.onclick = () => loadEvent(ev)
  return card
}

function renderList() {
  for (const b of el.tabs) {
    const kind = b.dataset.kind
    b.classList.toggle('on', kind === state.tab)
    b.querySelector('span').textContent = state.events.filter(e => kind === 'all' || e.kind === kind).length || ''
  }
  const list = visibleEvents()
  const nodes = []
  let day = ''
  for (const ev of list) {
    const d = fmtDay(ev.startEpoch)
    if (d !== day) {
      day = d
      const h = document.createElement('div')
      h.className = 'day'
      h.textContent = d
      nodes.push(h)
    }
    // Cards are built once per scan, so switching tabs doesn't reload thumbnails.
    ev.card ||= eventCard(ev)
    nodes.push(ev.card)
    ev.card.classList.toggle('active', ev === state.ev)
  }
  el.eventList.replaceChildren(...nodes)
  el.emptyHint.hidden = list.length > 0
  if (!list.length) el.emptyHint.textContent = state.events.length ? '该分类下没有视频' : ''
}

for (const b of el.tabs) {
  b.onclick = () => {
    state.tab = b.dataset.kind
    store.set('tab', state.tab)
    renderList()
  }
}

// ---------- event / segment playback ----------
const total = () => {
  const last = state.segs[state.segs.length - 1]
  return last ? last.offset + last.dur : 0
}
const curSeg = () => state.segs[state.segIdx]

// The video that drives the clock: the main view, or any camera present in this segment.
function clockVideo() {
  const seg = curSeg()
  if (!seg) return null
  const main = state.cells[state.mainIdx]
  if (main && seg.files[main.camera]) return main.video
  return state.cells.find(c => seg.files[c.camera])?.video || null
}

function now() {
  const v = clockVideo()
  return v ? curSeg().offset + v.currentTime : 0
}

function loadEvent(ev) {
  if (!ev) return
  for (const e of state.events) e.card?.classList.toggle('active', e === ev)
  for (const c of state.cells) {
    c.video.removeAttribute('src')
    c.video.load()
  }
  state.ev = ev
  state.segs = ev.segments.map((s, i, arr) => {
    const offset = s.startEpoch - ev.startEpoch
    // Provisional length until the real duration is probed.
    const next = arr[i + 1]
    return { ...s, offset, dur: next ? next.startEpoch - s.startEpoch - 1 : 59 }
  })
  state.segIdx = -1
  state.telemetry = null
  // Only keep the open event's vehicle data (a 10-minute event is a few MB).
  state.telCache.clear()
  state.view = null
  state.cells = ev.cameras.map((camera, i) => {
    const node = document.createElement('div')
    node.className = 'cell'
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    const label = document.createElement('span')
    label.className = 'cam'
    label.textContent = `${i + 1} · ${CAMERA_NAMES[camera] || camera}`
    node.append(video, label)
    node.onclick = () => setMain(i)
    video.onended = onEnded
    return { camera, video, node }
  })
  el.videos.replaceChildren(...state.cells.map(c => c.node))
  el.placeholder.hidden = true
  el.overlay.hidden = false
  const pref = state.cells.findIndex(c => c.camera === state.preferredCamera)
  state.mainIdx = pref >= 0 ? pref : 0
  layout()
  state.in = 0
  state.outAtEnd = true
  setPlaying(false)
  clampRange()
  const evT = ev.eventEpoch != null ? ev.eventEpoch - ev.startEpoch : null
  gotoTime(evT != null ? Math.max(0, evT - EVENT_LEAD) : 0, false)
  renderTicks()
  renderAll()
  el.exportBtn.disabled = false

  // Replace provisional lengths with real ones.
  const files = state.segs.map(s => (s.files.front || Object.values(s.files)[0]).path)
  window.api.probe(files).then((durs) => {
    if (state.ev !== ev) return
    durs.forEach((d, i) => { if (d) state.segs[i].dur = d })
    if (state.view && state.view.b > total()) state.view = null
    clampRange()
    renderTicks()
    renderAll()
  })
}

function loadSegment(i, local, play) {
  const seg = state.segs[i]
  state.segIdx = i
  const rate = +el.rateSel.value
  for (const c of state.cells) {
    const f = seg.files[c.camera]
    c.node.classList.toggle('missing', !f)
    if (!f) {
      c.video.dataset.url = ''
      c.video.removeAttribute('src')
      c.video.load()
      continue
    }
    if (c.video.dataset.url !== f.url) {
      c.video.dataset.url = f.url
      c.video.src = f.url
    }
    c.video.defaultPlaybackRate = rate
    c.video.playbackRate = rate
    // Before metadata loads this becomes the default start position.
    c.video.currentTime = local
    if (play) c.video.play().catch(() => {})
    else c.video.pause()
  }
  loadTelemetry(seg)
}

function segmentAt(t) {
  let i = 0
  while (i + 1 < state.segs.length && state.segs[i + 1].offset <= t) i++
  const seg = state.segs[i]
  const local = t - seg.offset
  // Inside the small gap after a segment: jump to the next one.
  if (local >= seg.dur && i + 1 < state.segs.length) return { i: i + 1, local: 0 }
  return { i, local: Math.min(Math.max(0, local), seg.dur) }
}

function gotoTime(t, play = state.playing) {
  if (!state.segs.length) return
  const { i, local } = segmentAt(Math.min(Math.max(0, t), total()))
  if (i !== state.segIdx) {
    loadSegment(i, local, play)
    return
  }
  for (const c of state.cells) {
    if (!c.video.dataset.url) continue
    c.video.currentTime = Math.min(local, c.video.duration || local)
    if (play) c.video.play().catch(() => {})
    else c.video.pause()
  }
}

function onEnded(e) {
  if (e.target !== clockVideo() || !state.playing) return
  if (state.segIdx + 1 < state.segs.length) loadSegment(state.segIdx + 1, 0, true)
  else setPlaying(false)
}

function layout() {
  const thumbs = state.cells.length - 1
  el.videos.classList.toggle('single', thumbs === 0)
  el.videos.style.gridTemplateRows = `repeat(${Math.max(thumbs, 1)}, minmax(0, 1fr))`
  state.cells.forEach((c, i) => {
    const isMain = i === state.mainIdx
    c.node.classList.toggle('main', isMain)
    c.node.style.gridRow = isMain ? `1 / span ${Math.max(thumbs, 1)}` : ''
  })
  el.overlayCam.textContent = CAMERA_NAMES[state.cells[state.mainIdx]?.camera] || ''
  state.cells[state.mainIdx]?.node.append(el.topbar, el.zoomBadge)
  resetPictureZoom()
}

// ---------- picture zoom: wheel on the main video zooms, drag pans, double-click resets ----------
const pz = { s: 1, x: 0, y: 0 } // scale and translation (px) of the main video element

// Keep the (letterboxed) picture covering the cell, or centred when it is smaller than the cell.
function clampPictureZoom(v) {
  const w = v.clientWidth
  const h = v.clientHeight
  const ar = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : w / h
  const cw = Math.min(w, h * ar)
  const ch = Math.min(h, w / ar)
  const fit = (t, size, content) => {
    const off = (size - content) / 2
    if (pz.s * content <= size) return (size - pz.s * content) / 2 - pz.s * off
    return Math.min(-pz.s * off, Math.max(size - pz.s * (off + content), t))
  }
  pz.x = fit(pz.x, w, cw)
  pz.y = fit(pz.y, h, ch)
}

function applyPictureZoom() {
  const main = state.cells[state.mainIdx]
  for (const c of state.cells) {
    if (c !== main) c.video.style.transform = ''
  }
  if (!main) return
  if (pz.s > 1) clampPictureZoom(main.video)
  main.video.style.transform = pz.s > 1 ? `translate(${pz.x}px, ${pz.y}px) scale(${pz.s})` : ''
  main.node.classList.toggle('zoomed', pz.s > 1)
  el.zoomBadge.hidden = pz.s <= 1
  el.zoomBadge.textContent = `${Math.round(pz.s * 100)}%  ·  双击还原`
}

function resetPictureZoom() {
  pz.s = 1
  pz.x = 0
  pz.y = 0
  for (const c of state.cells) c.node.classList.remove('zoomed')
  applyPictureZoom()
}

const mainCellOf = target => state.cells[state.mainIdx]?.node.contains(target) && !el.topbar.contains(target)

el.videos.addEventListener('wheel', (e) => {
  if (!mainCellOf(e.target)) return
  e.preventDefault()
  const r = state.cells[state.mainIdx].video.getBoundingClientRect()
  const ns = Math.min(8, Math.max(1, pz.s * (e.deltaY > 0 ? 1 / 1.2 : 1.2)))
  // Zoom around the cursor: the point under it stays put.
  const px = e.clientX - r.left + pz.x
  const py = e.clientY - r.top + pz.y
  pz.x = px - (px - pz.x) * (ns / pz.s)
  pz.y = py - (py - pz.y) * (ns / pz.s)
  pz.s = ns
  if (ns === 1) pz.x = pz.y = 0
  applyPictureZoom()
}, { passive: false })

el.videos.addEventListener('pointerdown', (e) => {
  if (pz.s <= 1 || e.button !== 0 || !mainCellOf(e.target)) return
  const node = state.cells[state.mainIdx].node
  node.setPointerCapture(e.pointerId)
  node.classList.add('panning')
  const start = { cx: e.clientX, cy: e.clientY, x: pz.x, y: pz.y }
  const move = (ev) => {
    pz.x = start.x + ev.clientX - start.cx
    pz.y = start.y + ev.clientY - start.cy
    applyPictureZoom()
  }
  const up = () => {
    node.classList.remove('panning')
    node.removeEventListener('pointermove', move)
    node.removeEventListener('pointerup', up)
    node.removeEventListener('pointercancel', up)
  }
  node.addEventListener('pointermove', move)
  node.addEventListener('pointerup', up)
  node.addEventListener('pointercancel', up)
})

el.videos.addEventListener('dblclick', (e) => { if (mainCellOf(e.target)) resetPictureZoom() })
window.addEventListener('resize', applyPictureZoom)

function setMain(i) {
  if (i === state.mainIdx || !state.cells[i]) return
  const t = now()
  state.mainIdx = i
  state.preferredCamera = state.cells[i].camera
  store.set('camera', state.preferredCamera)
  layout()
  gotoTime(t)
  renderAll()
}

function setPlaying(play) {
  state.playing = play
  el.playBtn.classList.toggle('playing', play)
  if (!state.segs.length) return
  if (play && now() >= total() - 0.05) gotoTime(state.in, true)
  for (const c of state.cells) {
    if (!c.video.dataset.url) continue
    if (play) c.video.play().catch(() => {})
    else c.video.pause()
  }
}

function clampRange() {
  const d = total()
  if (!d) return
  if (state.outAtEnd || state.out > d) state.out = d
  state.in = Math.min(state.in, Math.max(0, state.out - MIN_RANGE))
}

function setIn(t) {
  state.in = Math.min(Math.max(0, t), state.out - MIN_RANGE)
  renderRange()
}

function setOut(t) {
  const d = total()
  state.out = Math.max(Math.min(d, t), state.in + MIN_RANGE)
  state.outAtEnd = state.out >= d
  renderRange()
}

// Vehicle data is the same in every camera file; read it from the front camera when present.
async function loadTelemetry(seg) {
  const file = (seg.files.front || Object.values(seg.files)[0]).path
  state.telemetry = null
  if (!state.telCache.has(file)) state.telCache.set(file, window.api.telemetry(file))
  const data = await state.telCache.get(file)
  if (curSeg() === seg) state.telemetry = data
}

// ---------- rendering ----------
const viewA = () => state.view?.a ?? 0
const viewB = () => state.view?.b ?? total()
const inView = t => t >= viewA() - 1e-6 && t <= viewB() + 1e-6

// Position on the (possibly zoomed) timeline, 0..1.
function frac(t) {
  const span = viewB() - viewA()
  return span > 0 ? Math.min(Math.max((t - viewA()) / span, 0), 1) : 0
}
const pct = t => `${frac(t) * 100}%`

function renderTicks() {
  el.ticks.replaceChildren(...state.segs.slice(1).filter(s => inView(s.offset)).map((s) => {
    const tick = document.createElement('div')
    tick.className = 'tick'
    tick.style.left = pct(s.offset)
    return tick
  }))
}

// Zoom around time `t`; factor < 1 zooms in. Minimum window 10 s.
function zoom(t, factor) {
  const d = total()
  if (!d) return
  const a = viewA()
  const span = Math.min(d, Math.max(10, (viewB() - a) * factor))
  if (span >= d) {
    state.view = null
  } else {
    const na = Math.min(Math.max(0, t - (t - a) * (span / (viewB() - a))), d - span)
    state.view = { a: na, b: na + span }
  }
  renderTicks()
  renderAll()
}

// Slide a zoomed window so it starts at `a`, keeping its span.
function pan(a) {
  if (!state.view) return
  const span = state.view.b - state.view.a
  const na = Math.min(Math.max(0, a), total() - span)
  state.view = { a: na, b: na + span }
  renderTicks()
  renderAll()
}

function renderScroller() {
  const d = total()
  const show = !!state.view && !!d
  el.scroller.style.visibility = show ? 'visible' : 'hidden'
  if (!show) return
  el.thumb.style.left = `${(state.view.a / d) * 100}%`
  el.thumb.style.width = `${((state.view.b - state.view.a) / d) * 100}%`
}

function renderRange() {
  renderScroller()
  const d = total()
  const start = state.ev?.startEpoch ?? 0
  el.handleL.style.left = pct(state.in)
  el.handleR.style.left = pct(state.out)
  el.handleL.style.visibility = inView(state.in) ? '' : 'hidden'
  el.handleR.style.visibility = inView(state.out) ? '' : 'hidden'
  el.dimL.style.width = pct(state.in)
  el.dimR.style.width = `${(1 - frac(state.out)) * 100}%`
  el.range.style.left = pct(state.in)
  el.range.style.width = `${(frac(state.out) - frac(state.in)) * 100}%`
  el.inText.textContent = d ? fmtTime(start + state.in) : '--'
  el.outText.textContent = d ? fmtTime(start + state.out) : '--'
  el.inText.title = d ? `事件内 ${fmtRel(state.in, true)}` : ''
  el.outText.title = d ? `事件内 ${fmtRel(state.out, true)}` : ''
  el.durText.textContent = d ? fmtRel(state.out - state.in, true) : '--'

  const ev = state.ev
  const evT = ev?.eventEpoch != null ? ev.eventEpoch - ev.startEpoch : NaN
  el.eventMark.hidden = !(d && evT >= 0 && evT <= d && inView(evT))
  if (!el.eventMark.hidden) el.eventMark.style.left = pct(evT)
}

function renderTime() {
  if (!state.ev) return
  const t = now()
  const clock = fmtClock(state.ev.startEpoch + t)
  // While playing, keep the playhead inside a zoomed window.
  if (state.view && state.playing && t > state.view.b) {
    const span = state.view.b - state.view.a
    const a = Math.min(t - span * 0.1, total() - span)
    state.view = { a, b: a + span }
    renderTicks()
    renderRange()
  }
  el.playhead.style.left = pct(t)
  el.playhead.style.visibility = inView(t) ? '' : 'hidden'
  el.timeText.textContent = `${fmtRel(t)} / ${fmtRel(total())}${state.view ? '  ·  已放大，拖动下方滚动条查看其他位置，双击时间轴还原' : ''}`
  el.clockText.textContent = clock
  el.overlayTime.textContent = clock
  const v = clockVideo()
  renderHud(v ? v.currentTime : 0)
}

function renderHud(local) {
  const tel = state.telemetry
  el.hud.hidden = !tel || !el.hudChk.checked
  if (el.hud.hidden) return
  // Last frame at or before the segment-local time.
  let lo = 0
  let hi = tel.t.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tel.t[mid] <= local + 0.001) lo = mid
    else hi = mid - 1
  }
  const f = tel.frames[lo]
  el.hudSpeed.textContent = Math.round(f.speed * 3.6)
  el.hudLeft.classList.toggle('on', f.blinkL)
  el.hudRight.classList.toggle('on', f.blinkR)
  el.hudBrake.classList.toggle('on', f.brake)
  const pedal = Math.min(100, Math.max(0, Math.floor(f.pedal)))
  el.hudPedal.textContent = `${pedal}%`
  el.hudPedalBar.style.width = `${pedal}%`
  for (const g of el.gears) g.classList.toggle('on', +g.dataset.gear === f.gear)
}

function renderAll() {
  renderRange()
  renderTime()
}

// Keep thumbnails in step with the clock video.
function tick() {
  const v = clockVideo()
  if (v) {
    renderTime()
    if (state.playing) {
      for (const c of state.cells) {
        if (c.video === v || !c.video.dataset.url || c.video.ended) continue
        if (Math.abs(c.video.currentTime - v.currentTime) > DRIFT) c.video.currentTime = v.currentTime
        if (c.video.paused && v.currentTime < (c.video.duration || 0)) c.video.play().catch(() => {})
      }
    }
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

// ---------- timeline interaction ----------
function timeAt(clientX) {
  const r = el.track.getBoundingClientRect()
  return viewA() + Math.min(Math.max(0, (clientX - r.left) / r.width), 1) * (viewB() - viewA())
}

// Wheel zooms; Shift+wheel or a horizontal swipe pans a zoomed timeline.
function onWheel(e) {
  e.preventDefault()
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
  if (state.view && (e.shiftKey || horizontal || e.currentTarget === el.scroller)) {
    const delta = horizontal ? e.deltaX : e.deltaY
    pan(state.view.a + Math.sign(delta) * (state.view.b - state.view.a) * 0.2)
  } else if (!horizontal) {
    zoom(timeAt(e.clientX), e.deltaY > 0 ? 1.25 : 0.8)
  }
}
el.track.addEventListener('wheel', onWheel, { passive: false })
el.scroller.addEventListener('wheel', onWheel, { passive: false })

// Drag the thumb to pan; pressing elsewhere on the bar centres the window there first.
el.scroller.addEventListener('pointerdown', (e) => {
  if (!state.view) return
  const r = el.scroller.getBoundingClientRect()
  const timeAtX = x => ((x - r.left) / r.width) * total()
  const span = state.view.b - state.view.a
  if (e.target !== el.thumb) pan(timeAtX(e.clientX) - span / 2)
  const grab = timeAtX(e.clientX) - state.view.a
  el.scroller.setPointerCapture(e.pointerId)
  el.scroller.classList.add('dragging')
  const move = ev => pan(timeAtX(ev.clientX) - grab)
  const up = () => {
    el.scroller.classList.remove('dragging')
    el.scroller.removeEventListener('pointermove', move)
    el.scroller.removeEventListener('pointerup', up)
    el.scroller.removeEventListener('pointercancel', up)
  }
  el.scroller.addEventListener('pointermove', move)
  el.scroller.addEventListener('pointerup', up)
  el.scroller.addEventListener('pointercancel', up)
})
el.track.addEventListener('dblclick', () => {
  state.view = null
  renderTicks()
  renderAll()
})

function drag(target, onMove) {
  target.addEventListener('pointerdown', (e) => {
    if (!total()) return
    e.stopPropagation()
    target.setPointerCapture(e.pointerId)
    const wasPlaying = state.playing
    setPlaying(false)
    onMove(timeAt(e.clientX))
    const move = ev => onMove(timeAt(ev.clientX))
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      if (wasPlaying && target === el.track) setPlaying(true)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  })
}

// Dragging a handle also seeks so the frame at the cut point is visible.
drag(el.handleL, (t) => { setIn(t); gotoTime(state.in, false) })
drag(el.handleR, (t) => { setOut(t); gotoTime(state.out, false) })
drag(el.track, t => gotoTime(t, false))

// ---------- controls ----------
el.openBtn.onclick = async () => openFolder(await window.api.pickFolder())
el.playBtn.onclick = () => setPlaying(!state.playing)
el.hudChk.checked = store.get('hud') !== '0'
el.hudChk.onchange = () => store.set('hud', el.hudChk.checked ? '1' : '0')
el.rateSel.onchange = () => {
  for (const c of state.cells) {
    c.video.defaultPlaybackRate = +el.rateSel.value
    c.video.playbackRate = +el.rateSel.value
  }
}
el.setInBtn.onclick = () => state.ev && setIn(now())
el.setOutBtn.onclick = () => state.ev && setOut(now())
el.resetBtn.onclick = () => {
  state.in = 0
  state.outAtEnd = true
  clampRange()
  renderRange()
}

function step(dt) {
  if (!state.ev) return
  setPlaying(false)
  gotoTime(now() + dt, false)
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select') || !state.cells.length) return
  if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur()
  const k = e.key
  if (k === ' ') setPlaying(!state.playing)
  else if (k === 'ArrowLeft') step(e.shiftKey ? -5 : -1)
  else if (k === 'ArrowRight') step(e.shiftKey ? 5 : 1)
  else if (k === ',') step(-FRAME)
  else if (k === '.') step(FRAME)
  else if (k === 'i' || k === 'I') el.setInBtn.onclick()
  else if (k === 'o' || k === 'O') el.setOutBtn.onclick()
  else if (k >= '1' && k <= '9') setMain(+k - 1)
  else return
  e.preventDefault()
})

// Drag & drop a folder (or any file inside it) onto the window.
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover') })
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragover') })
document.addEventListener('drop', (e) => {
  e.preventDefault()
  document.body.classList.remove('dragover')
  const file = e.dataTransfer.files[0]
  if (file) openFolder(window.api.pathForFile(file))
})

// ---------- export ----------
function renderOutDir() {
  el.outDirBtn.textContent = state.outDir ? `导出到 ${state.outDir.split(/[\\/]/).filter(Boolean).pop()}` : '未设置导出目录'
  el.outDirBtn.title = state.outDir || '点击选择导出目录'
}
renderOutDir()

async function chooseOutDir() {
  const dir = await window.api.pickOutDir()
  if (dir) {
    state.outDir = dir
    store.set('outDir', dir)
    renderOutDir()
  }
  return dir
}
el.outDirBtn.onclick = chooseOutDir

el.modeSel.value = store.get('exportMode') === 'copy' ? 'copy' : 'watermark'
el.modeSel.onchange = () => store.set('exportMode', el.modeSel.value)

let toastTimer = 0
function toast(text, { cls = '', action = '', onAction = null, title = '', persist = false } = {}) {
  clearTimeout(toastTimer)
  el.toast.className = cls
  el.toastText.textContent = text
  el.toastText.title = title || text
  el.toastAction.hidden = !action
  el.toastAction.textContent = action
  el.toastAction.onclick = () => { hideToast(); onAction() }
  el.toast.hidden = false
  if (!persist) toastTimer = setTimeout(hideToast, cls === 'error' ? 12000 : 8000)
}
function hideToast() {
  clearTimeout(toastTimer)
  el.toast.hidden = true
}
el.toastClose.onclick = hideToast

const exportLabel = el.exportBtn.firstElementChild
function setExportProgress(p) {
  el.exportBtn.style.setProperty('--p', `${(p * 100).toFixed(1)}%`)
  exportLabel.dataset.text = `导出中 ${Math.floor(p * 100)}%`
  if (!el.exportBtn.matches(':hover')) exportLabel.textContent = exportLabel.dataset.text
}
window.api.onExportProgress(setExportProgress)
// While exporting, the button shows progress and cancels on click.
el.exportBtn.onmouseenter = () => { if (state.exporting) exportLabel.textContent = '取消导出' }
el.exportBtn.onmouseleave = () => { if (state.exporting) exportLabel.textContent = exportLabel.dataset.text }

// The selection may span several segment files; cut the main camera's part of each.
function exportPieces(camera) {
  const pieces = []
  for (const seg of state.segs) {
    const start = Math.max(state.in, seg.offset) - seg.offset
    const end = Math.min(state.out, seg.offset + seg.dur) - seg.offset
    const f = seg.files[camera]
    if (f && end - start > 0.01) pieces.push({ file: f.path, start, end, epoch: seg.startEpoch })
  }
  return pieces
}

el.exportBtn.onclick = async () => {
  if (state.exporting) return window.api.cancelExport()
  const cell = state.cells[state.mainIdx]
  if (!cell) return
  const pieces = exportPieces(cell.camera)
  if (!pieces.length) return toast('当前视角在选区内没有画面', { cls: 'error' })
  if (!state.outDir && !(await chooseOutDir())) return
  const mode = el.modeSel.value
  state.exporting = true
  hideToast()
  el.exportBtn.classList.add('busy')
  el.exportBtn.title = '点击取消导出'
  setExportProgress(0)
  const r = await window.api.exportClip({ pieces, outDir: state.outDir, camera: cell.camera, mode })
  state.exporting = false
  el.exportBtn.classList.remove('busy')
  el.exportBtn.title = ''
  exportLabel.textContent = '导出 MP4'
  if (r.ok) {
    const name = r.outPath.split(/[\\/]/).pop()
    const snapped = mode === 'copy' && Math.abs(r.startEpoch - (pieces[0].epoch + pieces[0].start)) > 0.01
      ? `（起点已对齐关键帧 ${fmtTime(r.startEpoch)}）` : ''
    toast(`已导出 ${name}${snapped}`, { action: '打开文件夹', onAction: () => window.api.showItem(r.outPath) })
  } else if (r.cancelled) toast('已取消导出')
  else toast('导出失败（悬停查看原因）', { cls: 'error', title: r.error || '' })
}

// ---------- startup: last folder, else the car's USB drive ----------
;(async () => {
  const last = store.get('lastFolder')
  if (await openFolder(last, true)) return
  const detected = await window.api.detect()
  if (detected && await openFolder(detected, true)) return
  showHint(last ? '上次打开的目录已不可用，请重新选择' : '插入特斯拉 U 盘，或点击上方的文件夹按钮')
})()

// ---------- self-update from GitHub releases ----------
async function installUpdate(info) {
  const label = `正在下载 v${info.version}`
  toast(`${label}…`, { persist: true })
  window.api.onUpdateProgress(p => toast(p < 1 ? `${label} ${Math.floor(p * 100)}%` : '下载完成，即将重启…', { persist: true }))
  const r = await window.api.installUpdate(info)
  if (!r.ok) toast('更新失败（悬停查看原因）', { cls: 'error', title: r.error || '' })
}
window.api.checkUpdate().then((info) => {
  if (info) toast(`发现新版本 v${info.version}`, { action: '立即更新', onAction: () => installUpdate(info), title: info.notes, persist: true })
})
