const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { readTelemetry } = require('./telemetry')
const { probeDuration, probeKeyframes } = require('./mp4')

const CLIP_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-([a-z_]+)\.mp4$/i
const CAMERA_ORDER = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar']

let win
let currentJob = null

function ffmpegPath() {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg.exe')
    : path.join(__dirname, '..', 'bin', 'ffmpeg.exe')
  return fs.existsSync(p) ? p : 'ffmpeg'
}

// Font for the watermark; ffmpeg needs an explicit file on Windows.
const FONT = ['C:/Windows/Fonts/consola.ttf', 'C:/Windows/Fonts/arial.ttf'].find(f => fs.existsSync(f))

// Segments closer than this (start to start) belong to the same continuous recording.
const MAX_SEGMENT_GAP = 90

function readEvent(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'event.json'), 'utf8'))
  } catch {
    return null
  }
}

function rank(cam) {
  const i = CAMERA_ORDER.indexOf(cam)
  return i < 0 ? 99 : i
}

// Collect segment files per directory: Map<dir, Map<startEpoch, { cam: file }>>.
function collect(root, depth = 0, dirs = new Map()) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return dirs
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      if (depth < 4 && e.name !== 'System Volume Information') collect(full, depth + 1, dirs)
      continue
    }
    const m = e.name.match(CLIP_RE)
    if (!m) continue
    const [, y, mo, d, h, mi, s, camera] = m
    // Wall-clock time of the first frame, encoded as a UTC epoch so it is
    // independent of the machine's timezone (formatted with UTC getters / gmtime).
    const epoch = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000
    if (!dirs.has(root)) dirs.set(root, new Map())
    const segs = dirs.get(root)
    if (!segs.has(epoch)) segs.set(epoch, {})
    segs.get(epoch)[camera.toLowerCase()] = { path: full, url: pathToFileURL(full).href }
  }
  return dirs
}

function kindOf(dir, event) {
  const parts = dir.split(/[\\/]/)
  if (parts.includes('SentryClips')) return 'sentry'
  if (parts.includes('SavedClips')) return 'saved'
  if (parts.includes('RecentClips')) return 'recent'
  if (event) return String(event.reason).startsWith('sentry') ? 'sentry' : 'saved'
  return 'recent'
}

function makeEvent(dir, kind, event, segs) {
  const cameras = [...new Set(segs.flatMap(s => Object.keys(s.files)))].sort((a, b) => rank(a) - rank(b))
  const thumb = path.join(dir, 'thumb.png')
  const evTime = event?.timestamp ? Date.parse(`${event.timestamp}Z`) / 1000 : NaN
  return {
    id: `${dir}|${segs[0].startEpoch}`,
    kind,
    dir,
    event,
    eventEpoch: Number.isFinite(evTime) ? evTime : null,
    thumb: kind !== 'recent' && fs.existsSync(thumb) ? pathToFileURL(thumb).href : null,
    startEpoch: segs[0].startEpoch,
    segments: segs,
    cameras,
  }
}

// An event directory (Saved/Sentry) is one recording; loose segments (RecentClips or
// copied folders without event.json) are split into continuous drives.
function scanEvents(root) {
  // A dropped file opens its containing folder.
  if (fs.statSync(root, { throwIfNoEntry: false })?.isFile()) root = path.dirname(root)
  const events = []
  for (const [dir, map] of collect(root)) {
    const segs = [...map].sort((a, b) => a[0] - b[0]).map(([startEpoch, files]) => ({ startEpoch, files }))
    const event = readEvent(dir)
    const kind = kindOf(dir, event)
    if (kind !== 'recent') {
      events.push(makeEvent(dir, kind, event, segs))
      continue
    }
    let run = [segs[0]]
    for (const seg of segs.slice(1)) {
      if (seg.startEpoch - run[run.length - 1].startEpoch > MAX_SEGMENT_GAP) {
        events.push(makeEvent(dir, kind, event, run))
        run = []
      }
      run.push(seg)
    }
    events.push(makeEvent(dir, kind, event, run))
  }
  return events.sort((a, b) => b.startEpoch - a.startEpoch)
}

// First drive letter that has a TeslaCam folder (the car's USB drive).
function detectTeslaCam() {
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const p = `${letter}:\\TeslaCam`
    if (fs.existsSync(p)) return p
  }
  return null
}

function uniquePath(dir, base) {
  let p = path.join(dir, `${base}.mp4`)
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i}).mp4`)
  return p
}

function drawtext(offset) {
  return [
    'drawtext=',
    FONT ? `fontfile='${FONT.replace(/:/g, '\\:')}':` : '',
    'fontsize=h/24:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=10:x=h/48:y=h/48:',
    `text='%{pts\\:gmtime\\:${offset}}'`,
  ].join('')
}

const pad = n => String(n).padStart(2, '0')

// Wall-clock epoch (UTC-encoded) -> "YYYY-MM-DD_HH-MM-SS".
function fileClock(epoch) {
  const d = new Date(Math.floor(epoch) * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`
}

// Stream copy can only start on a keyframe: move each piece's start back to the
// nearest keyframe at or before it (Tesla writes one every ~0.5 s).
async function snapToKeyframes(pieces) {
  return Promise.all(pieces.map(async (p) => {
    const keys = await probeKeyframes(p.file)
    const k = keys.filter(t => t <= p.start + 1e-6).pop() ?? 0
    return { ...p, start: k }
  }))
}

// Watermark mode: each piece is trimmed by input seeking (pts restarts at 0), stamped
// with its own offset, concatenated and re-encoded at high quality.
function encodeArgs(pieces, outPath) {
  const inputs = pieces.flatMap(p => ['-ss', p.start.toFixed(4), '-t', (p.end - p.start).toFixed(4), '-i', p.file])
  const chains = pieces.map((p, i) => `[${i}:v:0]${drawtext((p.epoch + p.start).toFixed(4))}[v${i}]`)
  const graph = pieces.length > 1
    ? `${chains.join(';')};${pieces.map((_, i) => `[v${i}]`).join('')}concat=n=${pieces.length}:v=1:a=0[out]`
    : chains[0].replace('[v0]', '[out]')
  return [
    ...inputs,
    '-filter_complex', graph, '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
    // Keep the original variable-rate frame timestamps untouched.
    '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux',
    '-movflags', '+faststart',
    outPath,
  ]
}

// Original mode: the camera's H.264 packets are copied untouched (bit-identical frames).
function copyArgs(pieces, outPath, listFile) {
  const quote = f => `'${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
  const list = ['ffconcat version 1.0', ...pieces.flatMap(p => [
    `file ${quote(p.file)}`, `inpoint ${p.start.toFixed(6)}`, `outpoint ${p.end.toFixed(6)}`,
  ])]
  fs.writeFileSync(listFile, `${list.join('\n')}\n`)
  // auto_convert off: otherwise parameter sets get injected into the first keyframe.
  return ['-f', 'concat', '-safe', '0', '-auto_convert', '0', '-i', listFile, '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', outPath]
}

// pieces: [{ file, start, end, epoch }] — one per segment file, in order; `epoch` is the
// wall-clock time of that file's first frame. mode: 'watermark' | 'copy'.
async function exportClip({ pieces, outDir, camera, mode }) {
  if (mode === 'copy') pieces = await snapToKeyframes(pieces)
  const duration = pieces.reduce((sum, p) => sum + p.end - p.start, 0)
  const startEpoch = pieces[0].epoch + pieces[0].start
  const outPath = uniquePath(outDir, `${fileClock(startEpoch)}_${camera}${mode === 'copy' ? '_原画' : ''}`)
  const listFile = path.join(os.tmpdir(), `teslavideo-${process.pid}-${Date.now()}.txt`)
  const args = [
    '-y', '-hide_banner', '-nostats', '-progress', 'pipe:1',
    ...(mode === 'copy' ? copyArgs(pieces, outPath, listFile) : encodeArgs(pieces, outPath)),
  ]
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), args, { windowsHide: true })
    currentJob = { proc, outPath, cancelled: false }
    const job = currentJob
    let stderr = ''
    proc.stdout.on('data', (buf) => {
      const m = String(buf).match(/out_time_us=(\d+)/g)
      if (!m) return
      const us = +m[m.length - 1].split('=')[1]
      win?.webContents.send('export-progress', Math.min(1, us / 1e6 / duration))
    })
    proc.stderr.on('data', (buf) => { stderr = (stderr + buf).slice(-4000) })
    const finish = (result) => {
      currentJob = null
      fs.rm(listFile, { force: true }, () => {})
      if (!result.ok) fs.rm(outPath, { force: true }, () => {})
      resolve(result)
    }
    proc.on('error', err => finish({ ok: false, error: `无法启动 ffmpeg：${err.message}` }))
    proc.on('close', (code) => {
      if (job.cancelled) finish({ ok: false, cancelled: true })
      else if (code === 0) finish({ ok: true, outPath, startEpoch })
      else finish({ ok: false, error: stderr.trim().split('\n').slice(-5).join('\n') })
    })
  })
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择特斯拉视频目录', properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('pick-out-dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择导出目录', properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('scan', (_, root) => scanEvents(root))
ipcMain.handle('detect', () => detectTeslaCam())
ipcMain.handle('probe', (_, files) => Promise.all(files.map(probeDuration)))
ipcMain.handle('export', (_, opts) => exportClip(opts))
ipcMain.handle('telemetry', (_, file) => readTelemetry(file))
ipcMain.handle('cancel-export', () => {
  if (currentJob) {
    currentJob.cancelled = true
    currentJob.proc.kill()
  }
})
ipcMain.handle('show-item', (_, p) => shell.showItemInFolder(p))

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1012',
    autoHideMenuBar: true,
    title: 'TeslaVideo',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
})

app.on('window-all-closed', () => {
  currentJob?.proc.kill()
  app.quit()
})
