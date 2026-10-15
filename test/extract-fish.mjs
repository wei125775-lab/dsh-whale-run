/**
 * 从 dsh 的 app.asar 里把鲸鱼 logo 的 path 数据抠出来，写进 test/fixtures/fish-path.js。
 *
 * 只读 asar、只写一个 fixture 文件。插件本身**不**依赖这个文件 ——
 * 插件永远从活的 DOM 上读 path；这个 fixture 只是给离线 harness 一个
 * 形状正确的鲸鱼（否则 harness 里画的就不是鲸鱼）。
 *
 * 用法：node test/extract-fish.mjs [asar路径] [输出路径]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASAR = process.argv[2] || 'D:/DeepSeekHarness/resources/app.asar'
const OUT = process.argv[3] || path.join(HERE, 'fixtures', 'fish-path.js')

const TARGET = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'

function readAsarMember(asarPath, memberPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    // asar: 16 字节 pickle 头，第 12 字节起是 JSON header 的长度
    const headerSize = head.readUInt32LE(12)
    const hb = Buffer.alloc(headerSize)
    fs.readSync(fd, hb, 0, headerSize, 16)
    const json = JSON.parse(hb.toString('utf8'))
    const base = 16 + headerSize

    const parts = memberPath.split('/')
    let node = json
    for (const p of parts) {
      const files = node.files
      if (!files || !files[p]) throw new Error(`asar member not found: ${parts.slice(0, parts.indexOf(p) + 1).join('/')}`)
      node = files[p]
    }
    // 注意：offset / size 在 header JSON 里是字符串
    const size = Number(node.size)
    const offset = Number(node.offset)
    if (!Number.isFinite(size) || !Number.isFinite(offset)) throw new Error('asar member is a directory, not a file')
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, base + offset)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const src = readAsarMember(ASAR, TARGET)
const m = src.match(/FISH_LOGO_PATH\s*=\s*"([^"]+)"/)
if (!m) throw new Error('FISH_LOGO_PATH not found in ' + TARGET)
const d = m[1]

const vb = src.match(/FISH_LOGO_VIEWBOX\s*=\s*\{\s*width:\s*([\d.]+)\s*,\s*height:\s*([\d.]+)/)
const width = vb ? Number(vb[1]) : 23.16
const height = vb ? Number(vb[2]) : 17.04

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(
  OUT,
  '// 由 test/extract-fish.mjs 生成，勿手改。\n' +
  '// 来源：' + ASAR + ' :: ' + TARGET + '\n' +
  'window.__FISH_PATH__ = ' + JSON.stringify(d) + ';\n' +
  'window.__FISH_VIEWBOX__ = ' + JSON.stringify(`0 0 ${width} ${height}`) + ';\n',
  'utf8',
)

console.log(`ok: ${d.length} chars path, viewBox 0 0 ${width} ${height} -> ${OUT}`)
