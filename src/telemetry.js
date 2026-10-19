// Per-frame vehicle data that Tesla firmware 2025.44.25+ embeds in each video frame
// as an H.264 SEI message (protobuf, spec: github.com/teslamotors/dashcam dashcam.proto).
const { readMoov, samples, withFile } = require('./mp4')

// The SEI NAL sits at the start of each sample, so only this many bytes are read per frame.
const HEAD_BYTES = 160

function unescapeRbsp(b) {
  const out = []
  for (let i = 0, zeros = 0; i < b.length; i++) {
    if (zeros >= 2 && b[i] === 3) { zeros = 0; continue }
    out.push(b[i])
    zeros = b[i] === 0 ? zeros + 1 : 0
  }
  return Buffer.from(out)
}

// Decode only the fields we display.
function decodeMeta(b) {
  const m = { speed: 0, gear: 0, pedal: 0, blinkL: false, blinkR: false, brake: false }
  let i = 0
  const varint = () => {
    let r = 0
    let s = 0
    while (i < b.length) {
      const c = b[i++]
      r += (c & 0x7f) * 2 ** s
      s += 7
      if (c < 0x80) break
    }
    return r
  }
  while (i < b.length) {
    const key = varint()
    const field = Math.floor(key / 8)
    const wire = key & 7
    let v
    if (wire === 0) v = varint()
    else if (wire === 1) { v = b.readDoubleLE(i); i += 8 }
    else if (wire === 5) { v = b.readFloatLE(i); i += 4 }
    else return null
    if (field === 2) m.gear = v
    else if (field === 4) m.speed = v
    else if (field === 5) m.pedal = v
    else if (field === 7) m.blinkL = !!v
    else if (field === 8) m.blinkR = !!v
    else if (field === 9) m.brake = !!v
  }
  return m
}

// SEI user_data_unregistered NAL: 0x06 0x05 <size> 0x42.. 0x69 <protobuf> 0x80
function seiPayload(nal) {
  if (nal.length < 6 || (nal[0] & 0x1f) !== 6 || nal[1] !== 5) return null
  let i = 2
  while (nal[i] === 0xff) i++
  i++
  const magic = i
  while (nal[i] === 0x42) i++
  if (i === magic || nal[i] !== 0x69) return null
  return unescapeRbsp(nal.subarray(i + 1, nal.length - 1))
}

function readTelemetry(file) {
  return withFile(file, async (fh) => {
    const moov = await readMoov(fh)
    if (!moov) return null
    const t = []
    const frames = []
    const head = Buffer.alloc(HEAD_BYTES)
    for (const s of samples(moov)) {
      const n = Math.min(HEAD_BYTES, s.size)
      await fh.read(head, 0, n, s.offset)
      // Samples are length-prefixed NAL units (4-byte lengths); SEI precedes the slice.
      for (let p = 0; p + 4 < n;) {
        const len = head.readUInt32BE(p)
        if (p + 4 + len > n) break
        const payload = seiPayload(head.subarray(p + 4, p + 4 + len))
        p += 4 + len
        const meta = payload && decodeMeta(payload)
        if (meta) {
          t.push(s.time)
          frames.push(meta)
          break
        }
      }
    }
    return frames.length ? { t, frames } : null
  }).catch(() => null)
}

module.exports = { readTelemetry }
