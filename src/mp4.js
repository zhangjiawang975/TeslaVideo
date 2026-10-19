// Minimal MP4 reader: locates the moov box with positional reads (Tesla writes it at the
// end of the file) so durations and sample tables can be read without loading the video.
const fs = require('node:fs/promises')

// Iterate boxes inside [start, end) of a buffer.
function* boxes(buf, start, end) {
  while (start + 8 <= end) {
    let size = buf.readUInt32BE(start)
    const type = buf.toString('latin1', start + 4, start + 8)
    let header = 8
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(start + 8))
      header = 16
    } else if (size === 0) {
      size = end - start
    }
    if (size < header) return
    yield { type, start: start + header, end: start + size }
    start += size
  }
}

function child(buf, box, ...path) {
  for (const type of path) {
    box = [...boxes(buf, box.start, box.end)].find(b => b.type === type)
    if (!box) return null
  }
  return box
}

// Returns the moov box (header included) of an open file handle.
async function readMoov(fh) {
  const { size } = await fh.stat()
  const head = Buffer.alloc(16)
  for (let pos = 0; pos + 8 <= size;) {
    await fh.read(head, 0, 16, pos)
    let boxSize = head.readUInt32BE(0)
    const type = head.toString('latin1', 4, 8)
    if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8))
    else if (boxSize === 0) boxSize = size - pos
    if (boxSize < 8) break
    if (type === 'moov') {
      const buf = Buffer.alloc(boxSize)
      await fh.read(buf, 0, boxSize, pos)
      return buf
    }
    pos += boxSize
  }
  return null
}

function videoTrack(moov) {
  const root = child(moov, { start: 0, end: moov.length }, 'moov')
  if (!root) return null
  for (const trak of boxes(moov, root.start, root.end)) {
    if (trak.type !== 'trak') continue
    const hdlr = child(moov, trak, 'mdia', 'hdlr')
    if (hdlr && moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) === 'vide') return trak
  }
  return null
}

function mediaHeader(moov, trak) {
  const mdhd = child(moov, trak, 'mdia', 'mdhd')
  const v1 = moov[mdhd.start] === 1
  const timescale = moov.readUInt32BE(mdhd.start + (v1 ? 20 : 12))
  const duration = v1 ? Number(moov.readBigUInt64BE(mdhd.start + 24)) : moov.readUInt32BE(mdhd.start + 16)
  return { timescale, duration: duration / timescale }
}

// Returns [{ offset, size, time }] for every video sample (no B-frames, so dts == pts).
function samples(moov) {
  const trak = videoTrack(moov)
  if (!trak) return []
  const { timescale } = mediaHeader(moov, trak)
  const stbl = child(moov, trak, 'mdia', 'minf', 'stbl')
  const stts = child(moov, stbl, 'stts')
  const stsz = child(moov, stbl, 'stsz')
  const stsc = child(moov, stbl, 'stsc')
  const stco = child(moov, stbl, 'stco')
  const co64 = child(moov, stbl, 'co64')

  const fixedSize = moov.readUInt32BE(stsz.start + 4)
  const count = moov.readUInt32BE(stsz.start + 8)
  const sizes = Array.from({ length: count }, (_, i) => fixedSize || moov.readUInt32BE(stsz.start + 12 + i * 4))

  const times = []
  let dts = 0
  for (let e = 0, n = moov.readUInt32BE(stts.start + 4); e < n; e++) {
    const p = stts.start + 8 + e * 8
    const [cnt, delta] = [moov.readUInt32BE(p), moov.readUInt32BE(p + 4)]
    for (let k = 0; k < cnt; k++, dts += delta) times.push(dts / timescale)
  }

  const chunkOffsets = []
  if (stco) {
    for (let i = 0, n = moov.readUInt32BE(stco.start + 4); i < n; i++) chunkOffsets.push(moov.readUInt32BE(stco.start + 8 + i * 4))
  } else {
    for (let i = 0, n = moov.readUInt32BE(co64.start + 4); i < n; i++) chunkOffsets.push(Number(moov.readBigUInt64BE(co64.start + 8 + i * 8)))
  }

  const stscEntries = Array.from({ length: moov.readUInt32BE(stsc.start + 4) }, (_, i) => ({
    first: moov.readUInt32BE(stsc.start + 8 + i * 12),
    perChunk: moov.readUInt32BE(stsc.start + 12 + i * 12),
  }))
  const out = []
  for (let c = 0, e = 0; c < chunkOffsets.length && out.length < count; c++) {
    while (e + 1 < stscEntries.length && stscEntries[e + 1].first <= c + 1) e++
    let offset = chunkOffsets[c]
    for (let k = 0; k < stscEntries[e].perChunk && out.length < count; k++) {
      const i = out.length
      out.push({ offset, size: sizes[i], time: times[i] })
      offset += sizes[i]
    }
  }
  return out
}

// Times (seconds) of the sync samples (keyframes) of the video track.
function keyframeTimes(moov) {
  const trak = videoTrack(moov)
  if (!trak) return []
  const all = samples(moov)
  const stss = child(moov, child(moov, trak, 'mdia', 'minf', 'stbl'), 'stss')
  if (!stss) return all.map(s => s.time) // every sample is a keyframe
  const n = moov.readUInt32BE(stss.start + 4)
  return Array.from({ length: n }, (_, i) => all[moov.readUInt32BE(stss.start + 8 + i * 4) - 1]?.time).filter(t => t != null)
}

async function withFile(file, fn) {
  const fh = await fs.open(file, 'r')
  try {
    return await fn(fh)
  } finally {
    await fh.close()
  }
}

// Video track duration in seconds, or null if unreadable.
function probeDuration(file) {
  return withFile(file, async (fh) => {
    const moov = await readMoov(fh)
    const trak = moov && videoTrack(moov)
    return trak ? mediaHeader(moov, trak).duration : null
  }).catch(() => null)
}

function probeKeyframes(file) {
  return withFile(file, async (fh) => {
    const moov = await readMoov(fh)
    return moov ? keyframeTimes(moov) : []
  }).catch(() => [])
}

module.exports = { readMoov, samples, withFile, probeDuration, probeKeyframes }
