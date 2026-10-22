// Self-update for the portable (unzip-and-run) build: check the latest GitHub release,
// download its zip, then a detached PowerShell script waits for the app to exit, copies
// the new files over the install folder and restarts it.
const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { execFile } = require('node:child_process')

const REPO = 'zhangjiawang975/TeslaVideo'
const ASSET_RE = /-win-x64\.zip$/i
const HEADERS = { 'User-Agent': 'TeslaVideo', Accept: 'application/vnd.github+json' }

function newer(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

// -> { version, notes, url, size } when a newer release exists, otherwise null.
async function checkForUpdate() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const rel = await res.json()
  const version = String(rel.tag_name || '').replace(/^v/i, '')
  const asset = rel.assets?.find(a => ASSET_RE.test(a.name))
  if (!asset || !/^\d+\.\d+\.\d+$/.test(version) || !newer(version, app.getVersion())) return null
  return { version, notes: rel.body || '', url: asset.browser_download_url, size: asset.size }
}

async function download(url, file, size, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  const total = +res.headers.get('content-length') || size || 0
  const out = fs.createWriteStream(file)
  let got = 0
  for await (const chunk of res.body) {
    got += chunk.length
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r))
    if (total) onProgress(Math.min(1, got / total))
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())))
}

// Windows 10+ ships bsdtar, which can extract zip files.
function extract(zip, dir) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true }, err => (err ? reject(new Error(`解压失败：${err.message}`)) : resolve()))
  })
}

// The zip holds a single TeslaVideo-<version>/ folder; accept files at the root too.
function findAppDir(dir, exeName) {
  if (fs.existsSync(path.join(dir, exeName))) return dir
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, exeName))) return path.join(dir, e.name)
  }
  throw new Error('更新包中没有找到程序文件')
}

const SCRIPT = `param($ProcId, $Src, $Dst, $Exe, $Tmp)
Wait-Process -Id $ProcId -Timeout 60 -ErrorAction SilentlyContinue
# Renderer/GPU child processes can outlive the main process briefly.
for ($i = 0; $i -lt 30; $i++) {
  if (-not (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe })) { break }
  Start-Sleep -Seconds 1
}
robocopy $Src $Dst /E /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Update failed (robocopy $LASTEXITCODE). Please download the latest zip from GitHub.", 'TeslaVideo') | Out-Null
}
Start-Process -FilePath $Exe
Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
`

// Start a process through WMI so it is not in this app's job object and survives our exit
// (a plain detached spawn can be killed together with the app).
function launchDetached(argv) {
  const cmdline = argv.map(a => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')
  const ps = [
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdline.replace(/'/g, "''")}'; ProcessStartupInformation = $si }`,
    'exit $r.ReturnValue',
  ].join('; ')
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { windowsHide: true }, err => (err ? reject(new Error(`无法启动更新程序：${err.message}`)) : resolve()))
  })
}

// Downloads and stages the update, then quits so the script can replace the files.
async function installUpdate(info, onProgress) {
  if (!app.isPackaged) throw new Error('开发模式下不能自动更新')
  const exe = process.execPath
  const installDir = path.dirname(exe)
  try {
    fs.accessSync(installDir, fs.constants.W_OK)
  } catch {
    throw new Error(`没有写入权限：${installDir}`)
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teslavideo-update-'))
  const zip = path.join(tmp, 'update.zip')
  await download(info.url, zip, info.size, onProgress)
  const unpacked = path.join(tmp, 'unpacked')
  fs.mkdirSync(unpacked)
  await extract(zip, unpacked)
  const src = findAppDir(unpacked, path.basename(exe))
  const script = path.join(tmp, 'update.ps1')
  fs.writeFileSync(script, SCRIPT)
  await launchDetached([
    'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
    '-ProcId', String(process.pid), '-Src', src, '-Dst', installDir, '-Exe', exe, '-Tmp', tmp,
  ])
  app.quit()
}

module.exports = { checkForUpdate, installUpdate }
