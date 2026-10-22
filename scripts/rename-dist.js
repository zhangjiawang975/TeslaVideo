// electron-builder's "dir" target always writes dist/win-unpacked; name it after the version.
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { productName, version } = require('../package.json')

const dist = path.join(__dirname, '..', 'dist')
const target = path.join(dist, `${productName}-${version}`)
fs.rmSync(target, { recursive: true, force: true })
fs.renameSync(path.join(dist, 'win-unpacked'), target)
console.log(`已输出 dist/${path.basename(target)}/${productName}.exe`)

// Release asset; the in-app updater looks for "*-win-x64.zip" containing this folder.
const zip = path.join(dist, `${productName}-${version}-win-x64.zip`)
fs.rmSync(zip, { force: true })
// System bsdtar (Git's GNU tar can't write zip).
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
execFileSync(tar, ['-a', '-cf', zip, '-C', dist, path.basename(target)])
console.log(`已打包 dist/${path.basename(zip)}`)
