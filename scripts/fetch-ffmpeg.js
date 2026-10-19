// Downloads a static Windows ffmpeg build (GPL: libx264 + freetype) into bin/ffmpeg.exe.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip'
const binDir = path.join(__dirname, '..', 'bin')
const target = path.join(binDir, 'ffmpeg.exe')

async function main() {
  if (fs.existsSync(target)) return console.log('bin/ffmpeg.exe 已存在，跳过下载')
  fs.mkdirSync(binDir, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ffmpeg-'))
  const zip = path.join(tmp, 'ffmpeg.zip')
  console.log(`下载 ${URL}`)
  const res = await fetch(URL)
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`)
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
  // Windows 10+ ships bsdtar, which can extract zip files.
  execFileSync('tar', ['-xf', zip, '-C', tmp])
  const dir = fs.readdirSync(tmp).find(d => d.startsWith('ffmpeg-'))
  fs.copyFileSync(path.join(tmp, dir, 'bin', 'ffmpeg.exe'), target)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('已保存到 bin/ffmpeg.exe')
}

main().catch((e) => { console.error(e); process.exit(1) })
