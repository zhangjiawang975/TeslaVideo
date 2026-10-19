// electron-builder's "dir" target always writes dist/win-unpacked; name it after the version.
const fs = require('node:fs')
const path = require('node:path')
const { productName, version } = require('../package.json')

const dist = path.join(__dirname, '..', 'dist')
const target = path.join(dist, `${productName}-${version}`)
fs.rmSync(target, { recursive: true, force: true })
fs.renameSync(path.join(dist, 'win-unpacked'), target)
console.log(`已输出 dist/${path.basename(target)}/${productName}.exe`)
