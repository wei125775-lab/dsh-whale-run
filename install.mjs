#!/usr/bin/env node
/**
 * 把 dsh-whale-run 装进 dsh 的 profile。
 *
 * 这个包是**纯本地、零 npm 依赖**的，所以整个脚本不碰 pnpm、不碰 registry ——
 * 只做三件事：把文件复制进 profile 的 node_modules、在 profile 的 package.json 里
 * 登记 dependencies 和 dsh.profile.bundles、留一份备份。
 *
 * 用法：
 *   node install.mjs                 装
 *   node install.mjs --dry-run       只打印要改什么，不动盘
 *   node install.mjs --verify        装完自检（文件在不在、声明对不对）
 *   node install.mjs --uninstall     卸
 *
 * 其他参数：--dsh-home <路径>  --profile <名字>
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = '@dph/dsh-whale-run'
const PKG_DIR_NAME = 'dsh-whale-run'
const SCOPE = '@dph'
const BAK_SUFFIX = '.bak-whalerun'
const COPY = ['package.json', 'cordis.patch.yml', 'lib', 'README.md']

// ------------------------------------------------------------------ args

function flag(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : undefined
}
const DRY = !!flag('dry-run')
const UNINSTALL = !!flag('uninstall')
const VERIFY = !!flag('verify')
const WANT_PROFILE = typeof flag('profile') === 'string' ? flag('profile') : undefined
const DSH_HOME = (typeof flag('dsh-home') === 'string' ? flag('dsh-home') : undefined)
  || process.env.DSH_HOME
  || path.join(os.homedir(), '.dsh')

// ------------------------------------------------------------------ output

const C = process.stdout.isTTY
  ? { r: '\x1b[0m', b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', e: '\x1b[31m' }
  : { r: '', b: '', d: '', g: '', y: '', e: '' }

const say = (s) => console.log(s)
const ok = (s) => say(`${C.g}✓${C.r} ${s}`)
const warn = (s) => say(`${C.y}!${C.r} ${s}`)
const bad = (s) => say(`${C.e}✗${C.r} ${s}`)
const dim = (s) => say(`${C.d}${s}${C.r}`)
const head = (s) => say(`\n${C.b}${s}${C.r}`)

function die(msg, hint) {
  bad(msg)
  if (hint) dim(hint)
  process.exit(1)
}

// ------------------------------------------------------------------ profile

function findProfiles() {
  const root = path.join(DSH_HOME, 'profiles')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'package.json')))
    .map((d) => ({ name: d.name, dir: path.join(root, d.name) }))
}

function resolveProfile() {
  const profiles = findProfiles()
  if (!profiles.length) die(`在 ${path.join(DSH_HOME, 'profiles')} 下没找到任何 profile`,
    '先确认 dsh 桌面版装好了、而且至少启动过一次 —— profiles/ 那个目录是它自己建的。\n'
    + '如果 dsh 的数据目录不在默认位置（默认是用户主目录下的 .dsh），\n'
    + '就把 DSH_HOME 环境变量指过去，或者启动时带 --dsh-home <路径>。')
  if (WANT_PROFILE) {
    const hit = profiles.find((p) => p.name === WANT_PROFILE)
    if (!hit) die(`profile "${WANT_PROFILE}" 不存在`, `现有：${profiles.map((p) => p.name).join(', ')}`)
    return hit
  }
  const desktop = profiles.find((p) => p.name === 'desktop')
  if (desktop) return desktop
  const web = profiles.find((p) => p.name === 'web')
  if (web) return web
  if (profiles.length === 1) return profiles[0]
  die('有多个 profile，无法替你决定', `用 --profile 指定：${profiles.map((p) => p.name).join(', ')}`)
}

// ------------------------------------------------------------------ manifest

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  try { return JSON.parse(raw) } catch (e) { die(`${file} 不是合法 JSON：${e.message}`) }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function backupOnce(file) {
  const bak = file + BAK_SUFFIX
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak)
    dim(`  备份 ${path.basename(file)} → ${path.basename(bak)}`)
  }
}

function targetDir(profile) {
  return path.join(profile.dir, 'node_modules', SCOPE, PKG_DIR_NAME)
}

// ------------------------------------------------------------------ verify

function verify(profile) {
  head('自检')
  let problems = 0
  const fail = (m) => { bad(m); problems++ }

  const dst = targetDir(profile)
  if (!fs.existsSync(dst)) return fail(`包目录不存在：${dst}`)

  const pj = path.join(dst, 'package.json')
  if (!fs.existsSync(pj)) return fail(`包内缺 package.json`)
  const meta = readJson(pj)
  ok(`包内 package.json：${meta.name}@${meta.version}`)
  if (meta.name !== PKG) fail(`包名是 ${meta.name}，应该是 ${PKG}`)

  const patch = meta?.dsh?.bundle?.patch
  if (!patch) fail('没有声明 dsh.bundle.patch —— 0.2.0 的插件管理器会以 not-a-bundle 拒装')
  else if (!fs.existsSync(path.join(dst, patch))) fail(`dsh.bundle.patch 指向的 ${patch} 不存在`)
  else ok(`bundle patch：${patch}`)

  if (meta?.dsh?.client?.platform !== 'web') fail('dsh.client.platform 不是 "web"')
  else ok('dsh.client.platform = web')

  const clientRel = meta?.exports?.['./client']
  if (!clientRel) fail('exports["./client"] 没声明 —— 客户端半侧不会被加载')
  else {
    const clientFile = path.join(dst, clientRel)
    if (!fs.existsSync(clientFile)) fail(`exports["./client"] 指向的 ${clientRel} 不存在`)
    else {
      ok(`客户端 bundle：${clientRel}`)
      const src = fs.readFileSync(clientFile, 'utf8')
      const m = src.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*['"]([^'"]+)['"]/)
      if (!m) fail('client.js 里没有 window.__ModuleLoader__.load({ id, ... })')
      else if (m[1] !== PKG) fail(`client.js 注册的 id 是 "${m[1]}"，必须精确等于包名 ${PKG}`)
      else ok(`client.js 注册 id 正确：${m[1]}`)
      if (!/return\s+module\.exports/.test(src)) fail('client.js 的 factory 没有 return module.exports')
      if (!/exports\.apply\s*=/.test(src)) fail('client.js 没有导出 apply')
    }
  }

  const prof = readJson(path.join(profile.dir, 'package.json'))
  const bundles = prof?.dsh?.profile?.bundles || []
  if (!bundles.includes(PKG)) fail(`profile 的 dsh.profile.bundles 里没有 ${PKG} —— 装上了也不会被加载`)
  else ok(`profile bundles 已登记（第 ${bundles.indexOf(PKG) + 1} 位，共 ${bundles.length} 条）`)
  if (!prof?.dependencies?.[PKG]) warn('profile 的 dependencies 里没有这条（不影响加载，但 pnpm install 会把它当外来包）')
  else ok('profile dependencies 已登记')

  const indexFile = path.join(dst, 'lib', 'index.js')
  if (!fs.existsSync(indexFile)) fail('缺宿主半侧 lib/index.js —— loader 会找不到这条 entry')
  else ok('宿主半侧 lib/index.js 在')

  if (problems === 0) {
    say('')
    ok('自检全过')
    dim('首次安装需要重启整个 app（profile 的 patch 只在启动时读一次）；')
    dim('之后改 lib/client.js 靠 HMR，存盘约 1 秒自动生效，不用重启。')
    return true
  }
  say('')
  bad(`${problems} 项没过`)
  return false
}

// ------------------------------------------------------------------ uninstall

function uninstall(profile) {
  head(`卸载（profile: ${profile.name}）`)
  const dst = targetDir(profile)
  const manifestFile = path.join(profile.dir, 'package.json')
  const prof = readJson(manifestFile)

  const bundles = prof?.dsh?.profile?.bundles || []
  const i = bundles.indexOf(PKG)
  if (i >= 0) {
    if (DRY) dim(`  会从 dsh.profile.bundles[${i}] 移除 ${PKG}`)
    else { bundles.splice(i, 1); prof.dsh.profile.bundles = bundles }
  } else warn('dsh.profile.bundles 里本来就没有它')

  if (prof.dependencies && prof.dependencies[PKG] !== undefined) {
    if (DRY) dim(`  会从 dependencies 移除 ${PKG}`)
    else delete prof.dependencies[PKG]
  }

  if (fs.existsSync(dst)) {
    if (DRY) dim(`  会删除 ${dst}`)
    else { fs.rmSync(dst, { recursive: true, force: true }) }
  } else warn('包目录本来就不在')

  if (!DRY) {
    backupOnce(manifestFile)
    writeJson(manifestFile, prof)
    ok('已卸载（package.json 的备份留着，没删）')
    dim('重启 app 生效。')
  }
}

// ------------------------------------------------------------------ install

function copyInto(dst, profile) {
  const scopeDir = path.dirname(dst)
  const stage = path.join(scopeDir, '.whale-run.stage')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  for (const item of COPY) {
    const from = path.join(HERE, item)
    if (!fs.existsSync(from)) { warn(`源里没有 ${item}，跳过`); continue }
    fs.cpSync(from, path.join(stage, item), { recursive: true })
  }
  fs.rmSync(dst, { recursive: true, force: true })
  fs.mkdirSync(scopeDir, { recursive: true })
  fs.renameSync(stage, dst)
}

function install(profile) {
  head(`安装到 profile: ${profile.name}`)
  dim(`  ${profile.dir}`)

  const dst = targetDir(profile)
  const manifestFile = path.join(profile.dir, 'package.json')
  const prof = readJson(manifestFile)

  if (!prof.dsh) prof.dsh = {}
  if (!prof.dsh.profile) prof.dsh.profile = {}
  if (!Array.isArray(prof.dsh.profile.bundles)) prof.dsh.profile.bundles = []
  if (!prof.dependencies) prof.dependencies = {}

  const bundles = prof.dsh.profile.bundles
  const already = bundles.includes(PKG)

  if (DRY) {
    dim(`  会复制 ${COPY.join(', ')} → ${dst}`)
    dim(`  dependencies["${PKG}"] = "file:./node_modules/${PKG}"`)
    if (already) dim(`  bundles 里已有（第 ${bundles.indexOf(PKG) + 1} 位），不重复加`)
    else dim(`  会把 "${PKG}" push 到 bundles 末尾（第 ${bundles.length + 1} 位，最后应用）`)
    dim('  package.json 会先备份为 package.json' + BAK_SUFFIX)
    say('')
    ok('--dry-run，什么都没动')
    return
  }

  copyInto(dst, profile)
  ok(`已复制到 ${dst}`)

  backupOnce(manifestFile)
  prof.dependencies[PKG] = `file:./node_modules/${PKG}`
  if (!already) bundles.push(PKG)
  writeJson(manifestFile, prof)
  ok(`已登记：dependencies + dsh.profile.bundles（第 ${bundles.indexOf(PKG) + 1} 位，共 ${bundles.length} 条）`)

  say('')
  if (!verify(profile)) process.exit(1)
  say('')
  ok('装好了')
  dim('下一步：**完全退出并重开 DeepSeek Harness**（第一次装必须重启）。')
  dim('重开后新建一个空会话，欢迎页中央那只鲸鱼就能按住拖下来。')
}

// ------------------------------------------------------------------ main

say(`${C.b}dsh-whale-run${C.r}  把鲸鱼摘下来跑一局`)
dim(`DSH_HOME = ${DSH_HOME}`)

const profile = resolveProfile()
dim(`profile   = ${profile.name}`)

if (UNINSTALL) uninstall(profile)
else if (VERIFY) process.exit(verify(profile) ? 0 : 1)
else install(profile)
