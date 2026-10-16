/**
 * 无头 Edge 驱动 test/harness.html，跑一串断言 + 截图。
 *
 * 用法：node test/cdp-harness.mjs [debugPort] [shotsDir]
 * 退出码 0 = 全过。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 9333)
const SHOTS = process.argv[3] || path.join(HERE, 'shots')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const HARNESS = 'file:///' + path.join(HERE, 'harness.html').replace(/\\/g, '/')

fs.mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
let failed = 0
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '   ' + JSON.stringify(detail)}`)
}

// ---------------------------------------------------------------- CDP client

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result) }
      } else {
        this.events.push(msg)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)) } }, 20000)
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(function(){ try { return (${expr}) } catch (e) { return { __err: String(e && e.stack || e) } } })()`,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails))
    const v = r.result?.value
    if (v && typeof v === 'object' && v.__err) throw new Error('eval error: ' + v.__err)
    return v
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    const f = path.join(SHOTS, name + '.png')
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
    return f
  }
  /** 把游戏画布按 z 倍放大另存，用来看清 44px 下的鲸鱼画成什么样 */
  async shotCanvas(name, z = 4) {
    const url = await this.eval(`(function(){
      var c = document.querySelector('.wr-canvas');
      if (!c) return null;
      var o = document.createElement('canvas');
      o.width = c.width * ${z}; o.height = c.height * ${z};
      var g = o.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(c, 0, 0, o.width, o.height);
      return o.toDataURL('image/png');
    })()`)
    if (!url) return null
    const f = path.join(SHOTS, name + '.png')
    fs.writeFileSync(f, Buffer.from(String(url).split(',')[1], 'base64'))
    return f
  }
}

// ---------------------------------------------------------------- boot edge

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-run-edge-'))
const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--allow-file-access-from-files',
  '--disable-features=msEdgeSyncConfirmation,msEdgeFirstRunExperience',
  '--window-size=1440,900',
  '--remote-debugging-port=' + PORT,
  '--remote-allow-origins=*',
  '--user-data-dir=' + userDataDir,
  HARNESS + '#seed=1234',
], { stdio: 'ignore' })

function killEdge() {
  try { spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }) } catch (e) { /* ignore */ }
}
process.on('exit', killEdge)
process.on('SIGINT', () => { killEdge(); process.exit(130) })

async function findTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('file:'))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch (e) { /* not up yet */ }
    await sleep(250)
  }
  throw new Error('headless Edge did not expose a page target')
}

const wsUrl = await findTarget()
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
const cdp = new Cdp(ws)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

for (let i = 0; i < 60; i++) {
  const ready = await cdp.eval('!!window.__harnessReady').catch(() => false)
  if (ready) break
  await sleep(150)
}

// ---------------------------------------------------------------- assertions

try {
  const boot = await cdp.eval(`({
    ready: !!window.__harnessReady,
    roots: window.__harness.roots(),
    styles: window.__harness.pluginStyles(),
    disposers: window.__harness.disposerCount,
    api: !!window.__whaleRun,
    registered: window.__ModuleLoader__.has('@dph/dsh-whale-run'),
    pe: getComputedStyle(document.getElementById('whale-run-root')).pointerEvents,
    z: getComputedStyle(document.getElementById('whale-run-root')).zIndex,
    card: window.__harness.cardRect(),
    errors: window.__harness.errors(),
  })`)
  check('插件被 __ModuleLoader__ 注册', boot.registered)
  check('apply 后只有一个覆盖层根', boot.roots === 1, boot.roots)
  check('注入的 style 带 data-plugin 标记（且只有一份）', boot.styles === 1, boot.styles)
  check('ctx.effect 收到了清理函数', boot.disposers >= 2, boot.disposers)
  check('覆盖层根 pointer-events: none', boot.pe === 'none', boot.pe)
  check('覆盖层 z-index = 950', boot.z === '950', boot.z)
  check('调试口 window.__whaleRun 就位', boot.api)
  check('启动时无 JS 错误', boot.errors.length === 0, boot.errors)
  check('假输入框量到了尺寸', boot.card && boot.card.width > 300, boot.card && { w: boot.card.width, h: boot.card.height })

  check('没拖之前跑道没出现', !(await cdp.eval('window.__harness.runwayShown()')))

  // --- 抓取 ---
  check('grab(hero) 成功', await cdp.eval('window.__whaleRun.grab("hero")'))
  await sleep(120)
  const after = await cdp.eval(`({
    heroHidden: window.__harness.heroHidden(),
    sideHidden: window.__harness.sideHidden(),
    carryLive: window.__harness.carryLive(),
    shown: window.__harness.runwayShown(),
  })`)
  check('原鲸鱼被隐藏（visibility）', after.heroHidden, after)
  check('侧边栏那只没被误伤', !after.sideHidden)
  check('跟随鼠标的鲸鱼出现了', after.carryLive)
  check('跑道滑出来了', after.shown)

  // 新增手感：1:1 尺寸、标题打碎、弹簧滞后、拖尾
  const hand = await cdp.eval(`(function(){
    var src = document.querySelector('[data-slot="conversation.hero.brand.mark"] svg').getBoundingClientRect();
    var h = window.__whaleRun.headline();
    return {
      sourceW: Math.round(src.width),
      carryW: Math.round(window.__whaleRun.carryingSize),
      shattering: window.__whaleRun.shattering,
      spans: document.querySelectorAll('.wr-shatter span').length,
      text: h ? h.text : null,
      hidden: h ? h.hidden : null,
      texts: window.__whaleRun.heroTexts(),
      frags: Array.prototype.map.call(document.querySelectorAll('.wr-shatter > *'), function (el) {
        var r = el.getBoundingClientRect();
        var cs = getComputedStyle(el);
        return {
          t: el.textContent, x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height),
          o: Number(cs.opacity).toFixed(2), color: cs.color, vis: cs.visibility, disp: cs.display,
        };
      }),
    };
  })()`)
  check('拖起来那只按原位尺寸 1:1 画（不再大一圈）', Math.abs(hand.carryW - hand.sourceW) <= 1, hand)
  check('标题「探索未至之境」被逐字打碎', hand.spans > 0 && hand.shattering === true, hand)
  check('打碎时原句只是暂时藏起来，内容没被改', hand.text === '探索未至之境' && hand.hidden === true, hand)
  check('旁边的「预览版」也被一起带走（没落下）',
    hand.texts.length >= 2 && hand.texts.every((t) => t.hidden)
      && hand.texts.some((t) => t.text === '预览版'), hand.texts)
  await cdp.shot('01a-刚拿起来-字正在碎')
  const badgeFrag = (hand.frags || []).find((f) => f.t === '预览版')
  check('「预览版」整块克隆着飞（还带着胶囊的样式，不是干文字）',
    !!badgeFrag && badgeFrag.w > 8 && badgeFrag.h > 8, hand.frags)

  // --- 几何 ---
  const geo = await cdp.eval(`(function(){
    var r = window.__harness.runwayRect(), c = window.__harness.cardRect();
    var s = document.querySelector('[data-composer-seat]').getBoundingClientRect();
    var chips = document.querySelector('.seatChips').getBoundingClientRect();
    var hl = document.querySelector('.titleGroup span').getBoundingClientRect();
    return { r: {l:r.left,t:r.top,w:r.width,h:r.height,b:r.bottom},
             c: {l:c.left,t:c.top,w:c.width,h:c.height},
             s: {l:s.left,t:s.top,w:s.width},
             chips: {t: chips.top, b: chips.bottom},
             hl: {t: hl.top, b: hl.bottom},
             vw: window.innerWidth };
  })()`)
  check('跑道和欢迎页那句标题同一条 Y 轴',
    Math.abs((geo.r.t + geo.r.h / 2) - (geo.hl.t + geo.hl.b) / 2) < 2.5,
    { runwayCy: Math.round(geo.r.t + geo.r.h / 2), textCy: Math.round((geo.hl.t + geo.hl.b) / 2) })
  check('跑道不会压到「标准模式」那一行', geo.r.b <= geo.chips.t + 0.5, { runwayBottom: geo.r.b, chipsTop: geo.chips.t })
  check('跑道与卡片水平居中对齐（±2px）',
    Math.abs((geo.r.l + geo.r.w / 2) - (geo.c.l + geo.c.w / 2)) < 2,
    { runwayCx: geo.r.l + geo.r.w / 2, cardCx: geo.c.l + geo.c.w / 2 })
  check('跑道没超出视口', geo.r.l >= 0 && geo.r.l + geo.r.w <= geo.vw + 1)

  // --- 移到跑道上 ---
  const armed = await cdp.eval(`(function(){
    window.__whaleRun.moveTo(${geo.r.l + geo.r.w / 2}, ${geo.r.t + geo.r.h / 2});
    return document.querySelector('.wr-runway').classList.contains('wr-armed');
  })()`)
  check('鼠标移到跑道上时高亮（wr-armed）', armed)
  await sleep(260)
  const hintOp = await cdp.eval('window.__harness.hintOpacity()')
  check('悬在跑道上时提示语淡出', hintOp !== null && hintOp < 0.15, hintOp)
  const carrying = await cdp.eval(`({
    stats: window.__harness.carryStats(),
    zCarry: getComputedStyle(document.querySelector('.wr-carry')).zIndex,
    zRunway: getComputedStyle(document.querySelector('.wr-runway')).zIndex,
  })`)
  check('手上那只鲸鱼真的画在了跟随层上', carrying.stats && carrying.stats.coverage > 0.015, carrying.stats)
  check('跟随层叠在跑道之上', Number(carrying.zCarry) > Number(carrying.zRunway), carrying)
  await cdp.shot('01-拖着鲸鱼-跑道已高亮')

  // --- 弹簧滞后 + 拖尾 ---
  const lag = await cdp.eval(`(function(){
    var r = document.querySelector('.wr-runway').getBoundingClientRect();
    window.__whaleRun.moveTo(r.left + 28, r.top + 8);
    return { lag: window.__whaleRun.carryingLag };
  })()`)
  check('瞬移之后是滞后跟随，不是硬跟手', lag.lag > 20, lag)
  await sleep(220)
  const trail = await cdp.eval('window.__whaleRun.trailCount')
  check('拖动时留下拖尾粒子', trail > 0, trail)

  // --- 放下（落点故意放在跑道靠中间，好验"慢慢游回开头"）---
  await cdp.eval(`(function(){
    var r = document.querySelector('.wr-runway').getBoundingClientRect();
    window.__whaleRun.moveTo(r.left + r.width * 0.55, r.top + r.height * 0.5);
    return true;
  })()`)
  await sleep(160)
  check('dropNow() 落位', await cdp.eval('window.__whaleRun.dropNow()'))
  const entering = await cdp.eval(`({
    entering: window.__whaleRun.entering,
    wx: Math.round(window.__whaleRun.whaleX || 0),
    y: window.__whaleRun.whaleY,
    airborne: window.__whaleRun.whaleAirborne,
    phase: window.__whaleRun.state,
  })`)
  check('落点在跑道中间 → 从落点开始，不瞬移归位', entering.entering === true && entering.wx > 100, entering)
  check('放手之后是**先掉下来**（不是直接站在跑道上）',
    entering.airborne === true && entering.y > 4, entering)
  await cdp.shot('02a-掉下来的途中')

  // 看它有没有弹：记录落地后的竖直速度符号变化
  const bounce = await cdp.eval(`(function(){
    var eg = window.__whaleRun.engine, seenDown = false, bounced = false;
    for (var i = 0; i < 240; i++) {
      var before = eg.st.y;
      eg.step(1/120);
      if (!eg.st.grounded && eg.st.vy < 0 && before <= 0.5) bounced = true;
      if (eg.st.entLanded) break;
    }
    return { bounced: bounced, landed: eg.st.entLanded, y: Math.round(eg.st.y) };
  })()`)
  check('在跑道上弹了一下才落定', bounce.bounced === true && bounce.landed === true, bounce)

  // 落定之后游到起点（掉下来 + 弹一下要时间，轮询）
  let walked = null
  for (let i = 0; i < 40; i++) {
    walked = await cdp.eval(`({ entering: window.__whaleRun.entering, wx: Math.round(window.__whaleRun.whaleX || 0) })`)
    if (walked.entering === false) break
    await sleep(100)
  }
  check('落定后慢慢游到开头（x 回到起点 30）', walked.entering === false && walked.wx === 30, walked)
  await sleep(80)
  const dropped = await cdp.eval(`({ state: window.__whaleRun.state, heroHidden: window.__harness.heroHidden() })`)
  check('掉到跑道上后进入 running', dropped.state === 'running', dropped)
  check('游戏期间原鲸鱼仍然隐藏', dropped.heroHidden)

  await sleep(1500)
  const played = await cdp.eval(`({ score: window.__whaleRun.score, y: window.__whaleRun.engine.st.y, stats: window.__harness.canvasStats() })`)
  check('分数在涨', played.score > 0, played.score)
  // 现在是透明底（让界面透出来），所以只能要求"画了东西"而不是"铺满了"
  check('画布真的画了东西（透明底，只有水线和角色）',
    played.stats && played.stats.coverage > 0.02 && played.stats.coverage < 0.6 && played.stats.max > 120, played.stats)
  await cdp.shot('02-跑起来了')
  await cdp.shotCanvas('02b-画布放大', 4)

  // --- 跳跃 ---
  const jump = await cdp.eval(`(function(){
    var before = window.__whaleRun.engine.st.y;
    window.__whaleRun.key(' ');
    var peak = before;
    for (var i = 0; i < 40; i++) { window.__whaleRun.engine.step(1/120); peak = Math.max(peak, window.__whaleRun.engine.st.y) }
    return { before: before, peak: peak };
  })()`)
  check('空格把鲸鱼跳起来了', jump.peak > 40, jump)
  await cdp.shot('03-跳起来')

  // --- 撞障碍 ---
  const overCheck = await cdp.eval(`(function(){
    var eg = window.__whaleRun.engine;
    eg.st.y = 0; eg.st.grounded = true; eg.st.vy = 0;
    eg.st.obstacles.push({ kind:'coral', x: 40, y: eg.groundY - 40, oy: 40, w: 20, h: 40, alive: true, phase: 0 });
    for (var i = 0; i < 60 && eg.st.phase !== 'over'; i++) eg.step(1/120);
    return { phase: eg.st.phase, score: eg.st.score, best: window.__whaleRun.best };
  })()`)
  check('撞上障碍后 game over', overCheck.phase === 'over', overCheck)
  check('最高分落盘了', overCheck.best > 0, overCheck.best)

  // --- 撞死之后得分要摆在跑道正中（用户要的：不是角落里那行小字）---
  const midScore = await cdp.eval(`(function(){
    var r = document.querySelector('.wr-runway').getBoundingClientRect();
    var f = document.querySelector('.wr-over .wr-final');
    var b = document.querySelector('.wr-over .wr-best');
    var fb = f.getBoundingClientRect();
    return {
      h: Math.round(r.height),
      final: f.textContent,
      best: b.textContent,
      size: parseFloat(getComputedStyle(f).fontSize),
      score: window.__whaleRun.score,
      shown: document.querySelector('.wr-runway').classList.contains('wr-over-show'),
      cy: Math.round(fb.top + fb.height / 2 - r.top),
    };
  })()`)
  check('跑道拉高了（有地方摆那个大字）', midScore.h >= 150, midScore.h)
  check('撞死之后得分摆正中间、跟引擎分数一致、字号够大',
    midScore.shown === true && midScore.final === String(midScore.score) &&
    midScore.size >= 28 && Math.abs(midScore.cy - midScore.h / 2) <= midScore.h * 0.3, midScore)
  check('正中那行还报了最高分', /最高/.test(midScore.best) && /\d/.test(midScore.best), midScore.best)

  // --- 撞死之后不许原地躺下：被打飞、翻着滚出画布，再一路掉到窗口下沿才消失 ---
  await sleep(60)
  const flung = await cdp.eval(`(function(){
    var eg = window.__whaleRun.engine;
    return { airborne: !eg.st.grounded, y: eg.st.y, vy: eg.st.vy, rot: eg.st.rot };
  })()`)
  check('撞死那一下是被打飞的（弹离水面，不是站着倒）',
    flung.airborne === true && flung.y > 0, flung)
  await sleep(120)
  const flying = await cdp.eval(`({ rot: window.__whaleRun.whaleRot, y: Math.round(window.__whaleRun.engine.st.y) })`)
  check('飞出去的时候翻着滚（旋转角在长）', flying.rot > flung.rot + 0.3, { was: flung.rot, now: flying.rot })
  await cdp.shot('04-gameover')

  // 掉出画布底边 → 位置/旋转/速度原样交给覆盖层接着往下掉
  let handoff = null
  for (let i = 0; i < 40; i++) {
    handoff = await cdp.eval(`(function(){
      var r = document.querySelector('.wr-runway').getBoundingClientRect();
      return {
        thrown: window.__whaleRun.thrown,
        falling: window.__whaleRun.falling,
        running: window.__whaleRun.running,
        ry: Math.round(window.__whaleRun.carryingY),
        canvasBottom: Math.round(r.top + r.height),
        carryLive: document.querySelector('.wr-carry').classList.contains('wr-live'),
      };
    })()`)
    if (handoff.thrown) break
    await sleep(40)
  }
  check('掉出画布后交给覆盖层接着掉（没有停在原地、也没有凭空消失）',
    handoff.thrown === true && handoff.falling === true && handoff.carryLive === true, handoff)
  // 上界放宽：轮询之间它一直在往下掉（~500px/s），慢一帧就远一点。
  // "接得上"的严格验证在真机那边（逐帧记录：画布内 ry=317 → 交棒 ry=404，画布底 379）。
  check('接力那一帧位置接得上（就在画布下沿附近）',
    handoff.running === false && handoff.ry >= handoff.canvasBottom - 60 && handoff.ry <= handoff.canvasBottom + 220, handoff)
  await cdp.shot('04b-被丢出去')

  // 一路掉到窗口下沿 → 水花 → 变回原来那只图标
  let gone = null
  for (let i = 0; i < 50; i++) {
    gone = await cdp.eval(`({
      falling: window.__whaleRun.falling,
      retractPending: window.__whaleRun.retractPending,
      heroHidden: window.__harness.heroHidden(),
      shown: document.querySelector('.wr-runway').classList.contains('wr-shown'),
    })`)
    if (!gone.falling) break
    await sleep(80)
  }
  check('掉到窗口下沿就消失（鲸鱼已经没了）', gone.falling === false, gone)
  // ⚠️ 图标和那行字**先别回来**：跑道就摆在它们那条 Y 轴上，早一步回来就是鲸鱼/标题/水线叠成一团
  check('结算那屏还亮着（分数先让人看清）', gone.shown === true && gone.retractPending === true, gone)
  check('这时候原位那只还没来得及还回来（不会跟水线叠在一起）', gone.heroHidden === true, gone)
  await cdp.shot('04c-掉出界面（结算还亮着）')

  // 结算收走 → 水面退去 → 图标和那行字才一起回来
  let retracted = null
  for (let i = 0; i < 60; i++) {
    retracted = await cdp.eval(`({
      shown: document.querySelector('.wr-runway').classList.contains('wr-shown'),
      running: window.__whaleRun.running,
      pe: getComputedStyle(document.querySelector('.wr-runway')).pointerEvents,
      heroHidden: window.__harness.heroHidden(),
      texts: window.__whaleRun.heroTexts(),
    })`)
    if (!retracted.shown && retracted.heroHidden === false && retracted.texts.length >= 2 &&
        retracted.texts.every((t) => !t.hidden)) break
    await sleep(100)
  }
  check('结算收走之后跑道自己收干净（界面回到原样）',
    retracted.shown === false && retracted.running === false && retracted.pe === 'none', retracted)
  check('水面退了之后，原位那只和那些字才回来',
    retracted.heroHidden === false && retracted.texts.length >= 2 &&
    retracted.texts.every((t) => !t.hidden), retracted)
  await cdp.shot('04d-收干净了')

  // 界面已经回到原样了，这会儿再敲空格**不该**凭空又开一局（防止误触）
  const afterSweep = await cdp.eval(`(function(){
    window.__whaleRun.key(' ');
    return { running: window.__whaleRun.running, phase: window.__whaleRun.state };
  })()`)
  check('收干净之后空格不再开新局（界面已经还原，别被误触打扰）',
    afterSweep.running === false, afterSweep)

  // --- game over 之后能不能再来一局 ---
  // 上面那一局已经"收干净"了，所以先重新起一局再撞死；鲸鱼飞出去之后**在结算还没收走之前**
  // 按空格 —— 走的就是"结算期间重开"那条路（顺带得把正在下坠的那只取消掉）。
  const again = await cdp.eval(`(function(){
    window.__whaleRun.restart();
    return { phase: window.__whaleRun.state, running: window.__whaleRun.running,
             heroHidden: window.__harness.heroHidden() };
  })()`)
  check('再来一局起得来（跑道又出来、图标又被带走）',
    again.phase === 'running' && again.running === true && again.heroHidden === true, again)
  // 先等它落定、游回起点（"掉进来"那段是不判碰撞的），再撞死
  for (let i = 0; i < 40; i++) {
    const e = await cdp.eval('window.__whaleRun.entering')
    if (e === false) break
    await sleep(100)
  }
  await cdp.eval(`(function(){
    var eg = window.__whaleRun.engine;
    eg.st.y = 0; eg.st.grounded = true; eg.st.vy = 0;
    eg.st.obstacles.push({ kind:'coral', x: 40, y: eg.groundY - 40, oy: 40, w: 20, h: 40, alive: true, phase: 0 });
    return true;
  })()`)
  await sleep(600)   // 等它被打飞出画布（这时结算还亮着）
  const replayKey = await cdp.eval(`(function(){
    var out = { before: window.__whaleRun.state, running: window.__whaleRun.running,
                wasFalling: window.__whaleRun.falling, wasPending: window.__whaleRun.retractPending };
    window.__whaleRun.key(' ');
    out.afterSpace = window.__whaleRun.state;
    out.score = window.__whaleRun.score;
    out.afterFalling = window.__whaleRun.falling;
    out.afterPending = window.__whaleRun.retractPending;
    out.overShown = document.querySelector('.wr-runway').classList.contains('wr-over-show');
    return out;
  })()`)
  check('撞死那一串还没演完的时候按空格能重开一局（正在下坠的那只也被取消）',
    replayKey.before === 'over' && (replayKey.wasFalling === true || replayKey.wasPending === true) &&
    replayKey.afterSpace === 'running' && replayKey.afterFalling === false &&
    replayKey.afterPending === false && !replayKey.overShown, replayKey)

  const replayClick = await cdp.eval(`(function(){
    var eg = window.__whaleRun.engine;
    eg.st.phase = 'over';
    document.querySelector('.wr-runway').classList.add('wr-over-show');
    document.querySelector('.wr-canvas').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    return {
      phase: window.__whaleRun.state,
      overShown: document.querySelector('.wr-runway').classList.contains('wr-over-show'),
    };
  })()`)
  check('game over 后点跑道能重开一局', replayClick.phase === 'running' && !replayClick.overShown, replayClick)

  // 重开之后分数要归零、障碍清空，不能接着上一局算
  const replayFresh = await cdp.eval(`({
    score: window.__whaleRun.score,
    obstacles: window.__whaleRun.engine.st.obstacles.length,
    speed: Math.round(window.__whaleRun.engine.st.speed),
  })`)
  check('重开是干净的一局（分数归零、障碍清空）',
    replayFresh.score === 0 && replayFresh.obstacles === 0 && replayFresh.speed <= 300, replayFresh)

  // --- 同种子可复现 ---
  const seq = await cdp.eval(`(function(){
    // 撞到障碍引擎就停了，所以每帧把生成的障碍取走清空，只留"第几帧生成、什么类型、什么高度"
    function run(){
      window.__whaleRun.setSeed(1234);
      window.__whaleRun.restart();
      var eg = window.__whaleRun.engine;
      var out = [];
      for (var i = 0; i < 3600 && out.length < 8; i++) {
        eg.step(1/120);
        while (eg.st.obstacles.length) {
          var o = eg.st.obstacles.shift();
          out.push(o.kind + '/' + o.oy + '@' + i);
        }
      }
      return out.join(',');
    }
    var a = run(), b = run();
    return { a: a, b: b, same: a === b && a.split(',').length >= 6 };
  })()`)
  check('同种子两次开局障碍序列一致', seq.same, seq)

  // --- 水母：500 分之后才出场 ---
  const jellyGate = await cdp.eval(`(function(){
    window.__whaleRun.setSeed(99);
    window.__whaleRun.restart();
    var eg = window.__whaleRun.engine;
    var rec = [];
    for (var i = 0; i < 40000 && rec.length < 90; i++) {
      eg.step(1/120);
      while (eg.st.obstacles.length) {          // 每帧清空，免得撞上就停了
        var o = eg.st.obstacles.shift();
        rec.push({ s: eg.st.score, jelly: o.kind === 'jelly' || o.kind === 'jellyHigh', swim: !!o.swim });
      }
    }
    var early = rec.filter(function (r) { return r.s < 500 });
    var jellies = rec.filter(function (r) { return r.jelly });
    return {
      n: rec.length, earlyN: early.length, earlyJelly: early.filter(function (r) { return r.jelly }).length,
      jellyN: jellies.length, jellyN2: jellies.length,
      minJellyScore: jellies.length ? Math.min.apply(null, jellies.map(function (r) { return r.s })) : -1,
      allSwim: jellies.every(function (r) { return r.swim }),
      maxScore: rec.length ? rec[rec.length - 1].s : -1,
    };
  })()`)
  check('500 分之前一个水母都不出', jellyGate.earlyN > 3 && jellyGate.earlyJelly === 0, jellyGate)
  check('过了 500 分水母就来了（最低那只也不早于 500 分）',
    jellyGate.jellyN > 2 && jellyGate.minJellyScore >= 500 && jellyGate.maxScore >= 500, jellyGate)
  check('出场的水母都带 S 型游动的参数', jellyGate.allSwim === true, jellyGate)

  // --- 水母的 S 型波形只往上摆：任何相位下潜都躲得开（这是"公平"的底线）---
  const jellySwim = await cdp.eval(`(function(){
    var eg = window.__whaleRun.engine;
    var dived = eg.st.diving, grounded = eg.st.grounded, y = eg.st.y;
    eg.st.diving = true; eg.st.grounded = true; eg.st.y = 0;
    var divTop = eg.whaleBox().y;            // 下潜时的盒子顶边（比跑动矮 11px）
    eg.st.diving = false;
    var runTop = eg.whaleBox().y;
    eg.st.diving = dived; eg.st.grounded = grounded; eg.st.y = y;
    var hiB = 1e9, loB = -1e9, diveOK = true, runHit = false;   // y 小＝屏幕位置高
    var hitCount = 0, runOK = 0, N = 48;
    for (var i = 0; i <= N; i++) {
      var o = { x: 300, oy: 40, h: 22, w: 26, amp: 46, k: 6.2832 / 300, ph: i / N * 6.2832 };
      var b = eg.swimY(o) + 22;              // 盒子底边
      if (b < hiB) hiB = b;
      if (b > loB) loB = b;
      if (b > divTop) diveOK = false;        // 最低那一档压到潜水鲸鱼头上 = 躲不开
      if (b > runTop) { runHit = true; hitCount++ } else runOK++;
    }
    return { diveOK: diveOK, runHit: runHit, swing: Math.round(loB - hiB),
             troughClear: Math.round(divTop - loB), rise: Math.round(runTop - hiB),
             hitPhase: Math.round(hitCount / (N + 1) * 100), passPhase: Math.round(runOK / (N + 1) * 100) };
  })()`)
  check('水母下探到最低时压着鲸鱼跑的那条线（这一档就是"能撞到"的）',
    jellySwim.diveOK === true && jellySwim.troughClear >= 2 && jellySwim.runHit === true, jellySwim)
  check('水母的 S 摆得够大：低相位撞得到、高相位跑着过得去（两头都占相当一段）',
    jellySwim.swing >= 34 && jellySwim.rise >= 8 &&
    jellySwim.hitPhase >= 15 && jellySwim.passPhase >= 15, jellySwim)

  // --- 二段跳：空中能再蹬一下，但比第一下矮；落地补回来；第三下不给 ---
  const dbl = await cdp.eval(`(function(){
    var api = window.__whaleRun, eg = api.engine;
    function fresh(){
      eg.st.obstacles.length = 0;
      eg.st.y = 0; eg.st.vy = 0; eg.st.grounded = true; eg.st.diving = false; eg.st.airJumps = 0;
    }
    // airAt: 第几帧补第二下（-1 = 不补）；extraAt: 再补一下（该被拒）
    // ⚠️ airJumps 要在"补完**当场**"读 —— 落地时会归零，跑完再读永远是 0。
    // ⚠️ 被拒没被拒要问引擎自己的 jump()（返回布尔）；调试口的 key() 是走键盘事件、没有返回值。
    function run(airAt, extraAt){
      fresh();
      api.key(' ');                       // 第一下：走键盘这条路
      eg.step(1/240);
      var peak = eg.st.y, airJumped = 0, thirdRet = null;
      for (var i = 0; i < 3000; i++) {
        if (i === airAt) { api.key(' '); airJumped = eg.st.airJumps }
        if (i === extraAt) thirdRet = eg.jump();
        eg.step(1/240);
        if (eg.st.y > peak) peak = eg.st.y;
        if (eg.st.grounded) break;
      }
      return { peak: Math.round(peak), airJumped: airJumped, thirdRet: thirdRet, grounded: eg.st.grounded };
    }
    var single = run(-1, -1);
    var double = run(60, -1);       // 0.25s 后（已经在往下掉了）补一下
    var triple = run(60, 100);      // 再补一下 —— 不该有反应
    var again = run(-1, -1);        // 落地之后二段跳应该补回来了
    return { single: single, double: double, triple: triple, again: again };
  })()`)
  check('二段跳真的更高（空中再蹬一下）', dbl.double.peak > dbl.single.peak + 15, dbl)
  check('二段跳比第一下矮（不是再来一个完整的）',
    dbl.double.peak < dbl.single.peak * 1.8 && dbl.double.airJumped === 1, dbl)
  check('空中只能补一次（第三下被引擎拒掉，高度也一像素没多）',
    dbl.triple.peak === dbl.double.peak && dbl.triple.thirdRet === false, dbl.triple)
  check('落地之后二段跳补回来了（再跳一次还是一样的高度）',
    dbl.again.peak === dbl.single.peak, dbl.again)

  // --- 关键：碎字演完之后**不许自己长回来**（用户专门报过这个）---
  await sleep(400)
  const stillGone = await cdp.eval('window.__whaleRun.heroTexts()')
  check('碎字演完之后那些字不会自己长回来',
    stillGone.length >= 2 && stillGone.every((t) => t.hidden), stillGone)

  // --- Esc 收场 ---
  await cdp.eval('window.__whaleRun.key("Escape")')
  await sleep(320)
  const quit = await cdp.eval(`({
    shown: window.__harness.runwayShown(),
    heroHidden: window.__harness.heroHidden(),
    carryLive: window.__harness.carryLive(),
    running: window.__whaleRun.running,
  })`)
  check('Esc 后跑道收起', !quit.shown, quit)
  check('Esc 后原鲸鱼恢复', !quit.heroHidden, quit)
  check('Esc 后停止运行', quit.running === false)

  // 收场时那些字是**拼回来**的（不是硬切出来）：先确认合字动画在跑，再等它演完
  await sleep(120)
  const reassembling = await cdp.eval(`({
    dir: window.__whaleRun.shatterDir,
    frags: document.querySelectorAll('.wr-shatter > *').length,
  })`)
  check('收场时那些字是从波浪里拼回来的（不硬切）',
    reassembling.dir === -1 && reassembling.frags > 0, reassembling)

  let headQuit = null
  for (let i = 0; i < 40; i++) {
    const st2 = await cdp.eval(`({ texts: window.__whaleRun.heroTexts(), shattering: window.__whaleRun.shattering })`)
    headQuit = st2.texts
    if (headQuit.length >= 2 && headQuit.every((t) => !t.hidden) && st2.shattering === false) break
    await sleep(100)
  }
  check('拼完之后那些字回来了',
    headQuit.length >= 2 && headQuit.every((t) => !t.hidden), headQuit)
  check('拼完克隆层清空', (await cdp.eval('window.__whaleRun.shattering')) === false)
  await cdp.shot('05-收场后')

  // --- 拖到跑道外面松手 → 鲸鱼飞回原位 ---
  await cdp.eval('window.__whaleRun.grab("hero")')
  await cdp.eval('window.__whaleRun.moveTo(20, 20)')
  const rejected = await cdp.eval('({ armed: document.querySelector(".wr-runway").classList.contains("wr-armed") })')
  check('拖到跑道外时不高亮', !rejected.armed)
  await cdp.eval('window.__whaleRun.release()')
  await sleep(120)
  const outDrop = await cdp.eval(`({
    falling: window.__whaleRun.falling, running: window.__whaleRun.running,
    shown: window.__harness.runwayShown(), heroHidden: window.__harness.heroHidden(),
  })`)
  check('放到空处 → 开始下坠（不是硬飞回原位）', outDrop.falling === true && !outDrop.running && !outDrop.shown, outDrop)
  check('下坠期间原位那只仍然藏着（还没变回去）', outDrop.heroHidden === true, outDrop)

  // 等它掉出下边框
  let fell = true
  for (let i = 0; i < 40; i++) {
    fell = await cdp.eval('window.__whaleRun.falling')
    if (!fell) break
    await sleep(100)
  }
  const vanished = await cdp.eval(`({ falling: window.__whaleRun.falling, heroHidden: window.__harness.heroHidden() })`)
  check('碰到下边框后停下', vanished.falling === false, vanished)
  check('消失之后变回原位那只图标', vanished.heroHidden === false, vanished)

  // 鲸鱼变回图标了，句子这时候才该回来
  let headBack = null
  for (let i = 0; i < 30; i++) {
    headBack = await cdp.eval('window.__whaleRun.heroTexts()')
    if (headBack.length && headBack.every((t) => !t.hidden)) break
    await sleep(100)
  }
  check('鲸鱼变回图标之后，那些字才回来',
    headBack.length >= 2 && headBack.every((t) => !t.hidden), headBack)

  // --- 拼字不能先闪一帧"完整的字" ---
  // 丢下去变回图标那条路是在渲染循环**内部**触发的，那一帧的步进已经跑过了；
  // 不在启动那一刻就把碎片摆成"散开"的样子，就会先上一帧完整的字再跳走。
  await cdp.eval('window.__whaleRun.grab("hero")')
  await sleep(1400)
  const inst = await cdp.eval(`(function(){
    window.__whaleRun.quit();
    var els = document.querySelectorAll('.wr-shatter > *');
    var maxO = 0;
    for (var i = 0; i < els.length; i++) maxO = Math.max(maxO, Number(getComputedStyle(els[i]).opacity));
    return { dir: window.__whaleRun.shatterDir, n: els.length, maxOpacity: Number(maxO.toFixed(2)) };
  })()`)
  check('拼字一上来就是散开的（不会先闪一帧完整的字）',
    inst.dir === -1 && inst.n > 0 && inst.maxOpacity < 0.05, inst)
  for (let i = 0; i < 40; i++) {
    if ((await cdp.eval('window.__whaleRun.shattering')) === false) break
    await sleep(100)
  }

  // --- 收起的跑道不许吃指针 ---
  // 这条就是"玩完一局之后再也摘不动鲸鱼"的根因：跑道的矩形压在欢迎页鲸鱼身上，
  // 收起来之后还留着 pointer-events:auto，于是那块看不见的矩形把点击全吃了。
  const parked = await cdp.eval(`(function(){
    var r = document.querySelector('.wr-runway');
    var rc = r.getBoundingClientRect();
    var s = document.querySelector('[data-slot="conversation.hero.brand.mark"] svg');
    var b = s.getBoundingClientRect();
    var w = Math.max(0, Math.min(rc.right, b.right) - Math.max(rc.left, b.left));
    var h = Math.max(0, Math.min(rc.bottom, b.bottom) - Math.max(rc.top, b.top));
    var top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      shown: r.classList.contains('wr-shown'),
      pe: getComputedStyle(r).pointerEvents,
      overlap: { w: Math.round(w), h: Math.round(h) },
      topEl: top ? top.tagName : 'none',
    };
  })()`)
  check('收起的跑道 pointer-events: none', parked.pe === 'none', parked)
  check('鲸鱼那个点上最上面的是鲸鱼自己，不是跑道', parked.topEl !== 'DIV' || parked.overlap.w === 0, parked)

  // --- 用真指针事件再摘一次（grab() 走的是内部捷径，覆盖不到 onPointerDown）---
  const realPointer = await cdp.eval(`(function(){
    var s = document.querySelector('[data-slot="conversation.hero.brand.mark"] svg');
    var b = s.getBoundingClientRect();
    var x = b.left + b.width / 2, y = b.top + b.height / 2;
    s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
    document.body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 60, clientY: y + 40, pointerId: 1 }));
    return { carrying: window.__whaleRun.carrying, shown: document.querySelector('.wr-runway').classList.contains('wr-shown') };
  })()`)
  check('真指针路径下也能把鲸鱼摘下来（第二次）', realPointer.carrying === true, realPointer)
  await cdp.eval('window.__whaleRun.quit()')
  await sleep(260)

  // --- 渔网会变形（网格自己是活的）；瓶子是死的（用户明确要求别动）---
  // 单独把障碍画到一张空画布上量：整屏每帧都在滚，跟位置没关系，只比"形状本身"
  const netAnim = await cdp.eval(`(function(){
    var art = window.__whaleRun._internals.art;
    var c = document.createElement('canvas');
    c.width = 90; c.height = 70;
    var g = c.getContext('2d');
    function sig(kind, t, ph){
      g.clearRect(0, 0, 90, 70);
      // x/y/w/h 全用整数、每次画在同一处 —— 两次的差别只可能来自对象自身的形态
      art.drawObstacle(g, { kind: kind, x: 24, y: 24, w: 38, h: 22, oy: 22, phase: ph }, t);
      var d = g.getImageData(0, 0, 90, 70).data;
      var s = '', ink = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (var p = 0, i = 3; i < d.length; i += 4, p++) {
        if (d[i] > 90) {
          s += '1'; ink++;
          var px = p % 90, py = (p - px) / 90;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
        } else s += '0';
      }
      return { s: s, ink: ink, box: [x0, y0, x1, y1] };
    }
    var ns = [sig('net', 0.0, 0.7), sig('net', 0.55, 0.7), sig('net', 1.10, 0.7)];
    var b1 = sig('bottle', 0.0, 0), b2 = sig('bottle', 1.10, 0);
    // 网格被顶出去多远：画出来的墨迹不能离碰撞盒太远，否则"看着没碰上却撞了"
    var out = 0;
    for (var k = 0; k < ns.length; k++) {
      var b = ns[k].box;
      out = Math.max(out, 24 - b[0], 24 - b[1], b[2] - 62, b[3] - 46);   // 盒 = x 24..62, y 24..46
    }
    return { distinct: ns[0].s !== ns[1].s && ns[0].s !== ns[2].s && ns[1].s !== ns[2].s,
             netInk: ns[0].ink, bottleSame: b1.s === b2.s, bottleInk: b1.ink,
             overlap: out };
  })()`)
  check('渔网的网格自己是活的（三个时刻画出来的形状都不一样）',
    netAnim.distinct === true && netAnim.netInk > 40, netAnim)
  check('瓶子保持静止（画两次一模一样）', netAnim.bottleSame === true, netAnim)
  check('形变不会跑出碰撞盒太多（墨迹越过盒子 ≤ 4px）', netAnim.overlap <= 4, netAnim.overlap)

  // --- 浅色主题：墨线和文字都得跟着翻（用户报的"dsh 变浅色后障碍物看不见"）---
  const themeDark = await cdp.eval(`({
    light: window.__whaleRun.theme.light,
    attr: window.__whaleRun.theme.attr,
    ink: window.__whaleRun.inkColor,
    obstacle: window.__harness.obstacleInk(),
    hint: getComputedStyle(document.querySelector('.wr-hint')).color,
  })`)
  check('默认（深色主题）判定为深色，root 上不带 data-wr-light',
    themeDark.light === false && themeDark.attr === false && themeDark.ink === 'rgba(255,255,255,1)', themeDark)
  check('深色下障碍是白墨', themeDark.obstacle.n > 100 && themeDark.obstacle.r > 200, themeDark.obstacle)
  check('深色下提示文字是浅色', /^rgba?\(2\d\d/.test(themeDark.hint), themeDark.hint)

  await cdp.eval('window.__harness.setTheme("light")')
  await sleep(140)
  const themeLight = await cdp.eval(`({
    light: window.__whaleRun.theme.light,
    attr: window.__whaleRun.theme.attr,
    ink: window.__whaleRun.inkColor,
    obstacle: window.__harness.obstacleInk(),
    hint: getComputedStyle(document.querySelector('.wr-hint')).color,
    score: getComputedStyle(document.querySelector('.wr-score')).color,
    varInk: getComputedStyle(document.getElementById('whale-run-root')).getPropertyValue('--wr-ink').trim(),
    whale: getComputedStyle(document.querySelector('[data-slot="conversation.hero.brand.mark"] svg')).color,
  })`)
  check('切到浅色主题后被认出来（root 带上 data-wr-light）',
    themeLight.light === true && themeLight.attr === true && themeLight.ink === 'rgba(0,0,0,1)', themeLight)
  check('浅色下障碍变成黑墨（用户要的就是这个）',
    themeLight.obstacle.n > 100 && themeLight.obstacle.r < 60, themeLight.obstacle)
  check('浅色下提示文字和分数都变黑',
    /^rgba?\(0, 0, 0/.test(themeLight.hint) && /^rgba?\(0, 0, 0/.test(themeLight.score),
    { hint: themeLight.hint, score: themeLight.score })
  check('CSS 通道变量跟着翻（--wr-ink 0,0,0）', themeLight.varInk === '0,0,0', themeLight.varInk)

  // 属性优先：token 还写着深色字（只按亮度判会说这是浅色主题），
  // 但 body 上挂着 data-ds-dark-theme —— dsh 说了算的是它
  await cdp.eval('window.__harness.setTheme("dark-attr")')
  await sleep(140)
  check('body[data-ds-dark-theme] 在的时候一律当深色（属性优先）',
    (await cdp.eval('window.__whaleRun.theme.light')) === false)

  await cdp.eval('window.__harness.setTheme("dark")')
  await sleep(140)
  const themeBack = await cdp.eval(`({
    light: window.__whaleRun.theme.light,
    attr: window.__whaleRun.theme.attr,
    r: window.__harness.obstacleInk().r,
    hint: getComputedStyle(document.querySelector('.wr-hint')).color,
  })`)
  check('切回深色能复原（墨线、文字都白回来）',
    themeBack.light === false && themeBack.attr === false && themeBack.r > 200 &&
    /^rgba?\(2\d\d/.test(themeBack.hint), themeBack)

  // --- 一只在往下掉的时候不许再摘另一只；那只飞完自己把图标还回来 ---
  const swap = await cdp.eval(`(function(){
    window.__whaleRun.grab('hero');
    window.__whaleRun.moveTo(40, 40);        // 跑道外 → 松手就是下坠
    window.__whaleRun.release();
    var falling = window.__whaleRun.falling;
    window.__whaleRun.grab('sidebar');       // 半空中去摘另一只：应当被挡掉
    return { falling: falling, carrying: window.__whaleRun.carrying };
  })()`)
  check('下坠那一路还在演的时候摘不了别的鲸鱼', swap.falling === true && swap.carrying === false, swap)
  let backHome = null
  for (let i = 0; i < 40; i++) {
    backHome = await cdp.eval(`({
      falling: window.__whaleRun.falling,
      hero: window.__harness.heroHidden(), side: window.__harness.sideHidden(),
    })`)
    if (!backHome.falling) break
    await sleep(100)
  }
  check('那只飞完之后两只鲸鱼都在（谁也没被永久藏起来）',
    backHome.falling === false && backHome.hero === false && backHome.side === false, backHome)

  // --- 从侧边栏那只起手：中间 hero 那只也得跟着消失 ---
  // 跑道上跑的就是"那只鲸鱼"，不能一边在跑道上跑、一边在欢迎页原地还留着一只。
  const twin = await cdp.eval(`(function(){
    window.__whaleRun.quit();
    var r = { before: window.__harness.heroHidden() };
    window.__whaleRun.grab('sidebar');
    r.duringHero = window.__harness.heroHidden();
    r.duringSide = window.__harness.sideHidden();
    r.carrying = window.__whaleRun.carrying;
    return r;
  })()`)
  check('从侧边栏起手 → 中间 hero 那只也一起消失',
    twin.before === false && twin.duringHero === true && twin.duringSide === true &&
    twin.carrying === true, twin)

  const twinRun = await cdp.eval(`(function(){
    var r = document.querySelector('.wr-runway').getBoundingClientRect();
    window.__whaleRun.moveTo(r.left + r.width * 0.5, r.top + r.height * 0.45);
    window.__whaleRun.dropNow();
    return { hero: window.__harness.heroHidden(), side: window.__harness.sideHidden(),
             running: window.__whaleRun.running };
  })()`)
  check('侧边栏那只落到跑道上跑着的时候，中间那只仍然是消失的',
    twinRun.hero === true && twinRun.side === true && twinRun.running === true, twinRun)

  const twinBack = await cdp.eval(`(function(){
    window.__whaleRun.quit();
    return { hero: window.__harness.heroHidden(), side: window.__harness.sideHidden() };
  })()`)
  check('收场之后两只都还回原位（谁也没被永久藏起来）',
    twinBack.hero === false && twinBack.side === false, twinBack)

  // --- 撞死交接那一帧：位置、尺寸、透明度都得跟画布那边接得上 ---
  await cdp.eval(`(function(){
    window.__whaleRun.grab('sidebar');   // 侧边栏那只只有 24px，引擎会夹到 34 —— 交接时不能跳一下
    var r = document.querySelector('.wr-runway').getBoundingClientRect();
    window.__whaleRun.moveTo(r.left + r.width * 0.5, r.top + r.height * 0.45);
    return true;
  })()`)
  await sleep(220)
  await cdp.eval('window.__whaleRun.dropNow()')
  for (let i = 0; i < 40; i++) {
    if ((await cdp.eval('window.__whaleRun.entering')) === false) break
    await sleep(100)
  }
  await cdp.eval(`(function(){
    var eg = window.__whaleRun.engine;
    eg.st.y = 0; eg.st.grounded = true; eg.st.vy = 0;
    eg.st.obstacles.push({ kind:'coral', x: 40, y: eg.groundY - 40, oy: 40, w: 20, h: 40, alive: true, phase: 0 });
    window.__rec2 = [];
    var t0 = performance.now();
    (function loop(){
      if (performance.now() - t0 > 2600) return;
      var r = document.querySelector('.wr-runway').getBoundingClientRect();
      var c = document.querySelector('.wr-carry');
      window.__rec2.push({
        t: Math.round(performance.now() - t0),
        falling: window.__whaleRun.falling,
        op: Math.round(parseFloat(getComputedStyle(c).opacity) * 100) / 100,
        size: Math.round(window.__whaleRun.carryingSize),
        engineW: window.__whaleRun.engine.whaleW,
        // 画布那边这一帧会把鲸鱼画在哪（屏幕坐标的中心）—— 覆盖层得画在同一个点上
        expect: Math.round(r.top + window.__whaleRun.engine.groundY - window.__whaleRun.engine.st.y
                           - window.__whaleRun.engine.whaleH / 2),
        ry: Math.round(window.__whaleRun.carryingY),
      });
      requestAnimationFrame(loop);
    })();
    return true;
  })()`)
  await sleep(2400)
  const track = (await cdp.eval('window.__rec2')) || []
  const fly = track.filter((f) => f.falling)
  const minOp = fly.length ? Math.min(...fly.map((f) => f.op)) : null
  check('交接之后那只是实心的（不会先淡一下才看得见）', minOp !== null && minOp > 0.9,
    { frames: fly.length, minOp })
  check('交接那一帧画在画布本该画的位置上（不会上下跳一下）',
    fly.length > 0 && Math.abs(fly[0].ry - fly[0].expect) <= 1,
    { ry: fly[0] && fly[0].ry, expect: fly[0] && fly[0].expect })
  check('交接前后尺寸一致（不会在半空里缩一圈）',
    fly.length > 0 && fly[0].size === fly[0].engineW,
    { size: fly[0] && fly[0].size, engineW: fly[0] && fly[0].engineW })
  // 撞死这一整套走完之后，焦点不该还留在跑道上（不然用户敲字没反应）
  let focusAfter = null
  for (let i = 0; i < 40; i++) {
    focusAfter = await cdp.eval(`(function(){
      var a = document.activeElement;
      return { onRunway: !!(a && a.closest && a.closest('#whale-run-root')),
               tag: a ? (a.tagName + (a.hasAttribute && a.hasAttribute('data-composer-input') ? '[input]' : '')) : 'none' };
    })()`)
    if (!focusAfter.onRunway) break
    await sleep(100)
  }
  check('撞死收场之后焦点不再卡在跑道上', focusAfter.onRunway === false, focusAfter)

  // --- 标题正"拼回来"的那 ~1 秒里又把鲸鱼摘了：这一局的标题也得碎（不能整局亮着）---
  await cdp.eval(`(function(){
    window.__whaleRun.quit();
    window.__whaleRun.grab('hero');
    window.__whaleRun.moveTo(40, 40);
    window.__whaleRun.release();     // 放到空处 → 下坠 → 变回图标 → 拼字开始
    return true;
  })()`)
  let caught = false
  for (let i = 0; i < 60; i++) {
    if ((await cdp.eval('window.__whaleRun.shatterDir')) === -1) { caught = true; break }
    await sleep(30)
  }
  const regrab = await cdp.eval(`(function(){
    window.__whaleRun.grab('hero');
    return {
      dir: window.__whaleRun.shatterDir,
      frags: document.querySelectorAll('.wr-shatter > *').length,
      texts: window.__whaleRun.heroTexts(),
      carrying: window.__whaleRun.carrying,
    };
  })()`)
  check('拼字中途再摘一次 → 标题照样碎（这一局不会整局亮着）',
    caught && regrab.carrying === true && regrab.dir === 1 && regrab.frags > 0 &&
    regrab.texts.length >= 2 && regrab.texts.every((t) => t.hidden), regrab)
  await cdp.eval('window.__whaleRun.quit()')
  await sleep(300)

  // --- 侧边栏那只 + 吞掉 click ---
  const side = await cdp.eval(`(function(){
    var cl = window.__harness.newSessionClicks();
    window.__whaleRun.grab('sidebar');
    var btn = document.querySelector('.brand');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { clicks: window.__harness.newSessionClicks() - cl, sideHidden: window.__harness.sideHidden() };
  })()`)
  check('侧边栏鲸鱼也能被摘下', side.sideHidden, side)
  check('拖拽后的那次 click 被吃掉（没有新建会话）', side.clicks === 0, side)
  await cdp.eval('window.__whaleRun.quit()')
  await sleep(260)

  // --- 正被打飞出去（下坠中）时插件被拆掉（HMR 场景）：图标和字都得还回来、定时器得清掉 ---
  const midFlightDispose = await cdp.eval(`(function(){
    window.__whaleRun.grab('hero');
    window.__whaleRun.moveTo(40, 40);
    window.__whaleRun.release();
    var falling = window.__whaleRun.falling;
    var staying = window.__whaleRun.retractPending;   // 拆之前先读，拆完调试口就没了
    window.__harness.dispose();
    return {
      falling: falling,
      heroHidden: window.__harness.heroHidden(),
      roots: window.__harness.roots(),
      staying: staying,
    };
  })()`)
  check('下坠途中被拆插件 → 图标还回来、覆盖层没了、没有留下的定时器',
    midFlightDispose.falling === true && midFlightDispose.heroHidden === false &&
    midFlightDispose.roots === 0 && !midFlightDispose.staying, midFlightDispose)
  await sleep(1400)
  const stayGone = await cdp.eval(`({ hidden: window.__harness.heroHidden(), roots: window.__harness.roots() })`)
  check('拆完之后隔一会儿也没有"幽灵定时器"把东西再动一下',
    stayGone.hidden === false && stayGone.roots === 0, stayGone)
  await cdp.eval(`window.__harness.apply()`)
  await sleep(200)

  // --- 正拖着的时候插件被拆掉（HMR 场景）：鲸鱼必须还回去 ---
  const midDispose = await cdp.eval(`(function(){
    window.__whaleRun.grab('hero');
    var hiddenWhileCarrying = window.__harness.heroHidden();
    window.__harness.dispose();
    return { hiddenWhileCarrying: hiddenWhileCarrying, hiddenAfter: window.__harness.heroHidden(), roots: window.__harness.roots() };
  })()`)
  check('拆插件时正拖着鲸鱼 → 鲸鱼被放回原位', midDispose.hiddenWhileCarrying && !midDispose.hiddenAfter, midDispose)
  check('拆插件后覆盖层也没了', midDispose.roots === 0, midDispose.roots)

  // --- 卸载 / 重挂 ---
  const un = await cdp.eval(`(function(){
    window.__harness.dispose();
    var roots = window.__harness.roots();
    var before = window.__harness.canvasStats();
    window.__whaleRun && window.__whaleRun.key(' ');
    return { roots: roots, api: !!window.__whaleRun, styles: window.__harness.pluginStyles(), before: before };
  })()`)
  check('dispose 后覆盖层被移除', un.roots === 0, un)
  check('dispose 后调试口被清掉', un.api === false)

  const re = await cdp.eval(`(function(){
    window.__harness.apply();
    return { roots: window.__harness.roots(), styles: window.__harness.pluginStyles(), api: !!window.__whaleRun };
  })()`)
  check('重新 apply 后只有一层根（没有累积）', re.roots === 1, re)
  check('重新 apply 后 style 仍是一份', re.styles === 1, re)
  check('重新 apply 后调试口回来', re.api)

  // --- 最终错误检查 ---
  const errs = await cdp.eval('({ harness: window.__harness.errors(), page: (window.__cdpPageErrors||[]) })')
  const runtimeErrors = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text)
  check('harness 侧无捕获错误', errs.harness.length === 0, errs.harness)
  check('运行时无未捕获异常', runtimeErrors.length === 0, runtimeErrors)
} catch (e) {
  check('跑完断言序列', false, String(e && e.stack || e))
} finally {
  console.log(`\n${results.length - failed}/${results.length} 通过，截图在 ${SHOTS}`)
  ws.close()
  killEdge()
}

process.exit(failed === 0 ? 0 : 1)
