/**
 * 打正在跑的真 app：连 CDP，订异常/console，用真指针事件把鲸鱼拖到跑道上。
 *
 * 前置：app 必须带 --remote-debugging-port 启动，例如
 *   set DSH_HOME=D:\dsh-desktop-home
 *   "D:\DeepSeekHarness\DeepSeek Harness.exe" --remote-debugging-port=9222
 *
 * 用法：node test/cdp-live.mjs [port] [shotsDir]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 9222)
const SHOTS = process.argv[3] || path.join(HERE, 'shots-live')
const PKG = '@dph/dsh-whale-run'

fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '   ' + JSON.stringify(detail)}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result) }
      } else this.events.push(msg)
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
      returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error('eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    const v = r.result?.value
    if (v && typeof v === 'object' && v.__err) throw new Error('eval error: ' + v.__err)
    return v
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'))
  }
  async mouse(type, x, y, buttons) {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: buttons ?? (type === 'mouseMoved' ? 1 : 1),
      clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse',
    })
  }
}

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      // 桌面版渲染层是 dsh-app:// 协议；自建/网页版是 127.0.0.1
      const page = list.find((t) => t.type === 'page' && /^(dsh-app:|http:\/\/127\.0\.0\.1)/.test(t.url))
      if (page?.webSocketDebuggerUrl) return page
    } catch (e) { /* not up */ }
    await sleep(300)
  }
  throw new Error(`连不上 127.0.0.1:${PORT} 的调试端口 —— app 是不是没带 --remote-debugging-port 启动？`)
}

const page = await findPage()
console.log(`目标：${page.url}`)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
const cdp = new Cdp(ws)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

// ⚠️ 先看窗口可不可见：窗口在后台/最小化时 Chromium 会把 rAF 节流到几乎不跑，
// 游戏引擎直接冻住 —— 那时候下面**每一条**断言都会假失败（实测一次挂掉 15 条，
// 排查半天才发现是窗口被别的窗口挡住了）。这一条要放在最前面说清楚。
const vis0 = await cdp.eval('document.visibilityState')
check('app 窗口是可见的（后台窗口 rAF 被节流，引擎会冻住）', vis0 === 'visible', vis0)
if (vis0 !== 'visible') {
  console.log('      ⚠️ 把 DeepSeek Harness 窗口调到最前面再跑，否则后面全是假失败。')
}

// 真机测试是连着同一个页面反复跑的，上一次可能留下"正拖着/正在跑"的状态。
// 开跑前先收干净，断言才有意义。
await cdp.eval(`(function(){
  if (window.__whaleRun) { try { window.__whaleRun.quit() } catch (e) {} }
  return true;
})()`)
await sleep(400)
const resetState = await cdp.eval(`({
  carrying: window.__whaleRun ? window.__whaleRun.carrying : null,
  running: window.__whaleRun ? window.__whaleRun.running : null,
  shown: document.querySelector('.wr-runway') ? document.querySelector('.wr-runway').classList.contains('wr-shown') : null,
})`)
check('开跑前状态是干净的', !resetState.carrying && !resetState.running && !resetState.shown, resetState)

try {
  const stage = await cdp.eval(`({
    styles: document.querySelectorAll('style[data-plugin="${PKG}"]').length,
    roots: document.querySelectorAll('#whale-run-root').length,
    api: !!window.__whaleRun,
    hero: !!document.querySelector('[data-slot="conversation.hero.brand.mark"] svg'),
    side: !!document.querySelector('[data-slot="sidebar.brand.mark"] svg'),
    card: !!document.querySelector('[data-composer-card]'),
    input: !!document.querySelector('[data-composer-input]'),
  })`)
  check('注入的 style 只有一份', stage.styles === 1, stage.styles)
  check('覆盖层根只有一份', stage.roots === 1, stage.roots)
  check('插件跑起来了（window.__whaleRun 在）', stage.api)
  check('找到了输入框卡片', stage.card)
  check('找到了输入框', stage.input)
  check('找到了鲸鱼（hero 或侧边栏至少有一只）', stage.hero || stage.side, { hero: stage.hero, side: stage.side })

  const hl = await cdp.eval('window.__whaleRun.headline()')
  check('真机 · 定位到了欢迎页那句「探索未至之境」', hl && hl.text === '探索未至之境', hl)

  if (!stage.hero && !stage.side) {
    console.log('\n当前界面没有鲸鱼 —— 新建一个空会话再跑一次。')
  } else {
    const sel = stage.hero ? '[data-slot="conversation.hero.brand.mark"] svg' : '[data-slot="sidebar.brand.mark"] svg'
    const w = await cdp.eval(`(function(){
      var r = document.querySelector('${sel}').getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    })()`)
    await cdp.shot('live-0-初始')

    // 真的按住、拖、松手
    await cdp.mouse('mousePressed', w.x, w.y)
    await cdp.mouse('mouseMoved', w.x + 60, w.y + 40)
    await sleep(120)
    const mid = await cdp.eval(`({
      carrying: window.__whaleRun.carrying,
      shown: document.querySelector('.wr-runway') ? document.querySelector('.wr-runway').classList.contains('wr-shown') : false,
    })`)
    check('按住拖动能把鲸鱼拿起来', mid.carrying, mid)
    check('拖着的时候跑道滑出来了', mid.shown, mid)

    const hand = await cdp.eval(`(function(){
      var s = document.querySelector('${sel}');
      var h = window.__whaleRun.headline();
      return {
        srcW: Math.round(s.getBoundingClientRect().width),
        carryW: Math.round(window.__whaleRun.carryingSize),
        spans: document.querySelectorAll('.wr-shatter span').length,
        shattering: window.__whaleRun.shattering,
        hlText: h ? h.text : null,
        hlHidden: h ? h.hidden : null,
        lag: window.__whaleRun.carryingLag,
        texts: window.__whaleRun.heroTexts(),
      };
    })()`)
    check('真机 · 拖起来那只按原位尺寸 1:1', Math.abs(hand.carryW - hand.srcW) <= 1, hand)
    check('真机 · 标题被逐字打碎并暂时藏起来', hand.spans > 0 && hand.shattering === true && hand.hlHidden === true, hand)
    check('真机 · 那一行的字全部被带走（含「预览版」）',
      hand.texts.length >= 2 && hand.texts.every((t) => t.hidden), hand.texts)
    await cdp.shot('live-1-拿起来了')

    const r = await cdp.eval(`(function(){ var b = document.querySelector('.wr-runway').getBoundingClientRect(); return { cx: b.left+b.width/2, cy: b.top+b.height/2 } })()`)
    await cdp.mouse('mouseMoved', r.cx - 120, r.cy)
    await sleep(60)
    await cdp.mouse('mouseMoved', r.cx, r.cy)
    await sleep(80)
    await cdp.shot('live-2-悬在跑道上')
    await cdp.mouse('mouseReleased', r.cx, r.cy)
    await sleep(200)

    const started = await cdp.eval(`({ state: window.__whaleRun.state, running: window.__whaleRun.running })`)
    check('松手后开跑了', started.running === true && started.state === 'running', started)

    const landing = await cdp.eval(`({
      entering: window.__whaleRun.entering,
      wx: Math.round(window.__whaleRun.whaleX || 0),
      y: window.__whaleRun.whaleY,
      air: window.__whaleRun.whaleAirborne,
    })`)
    check('真机 · 松手是掉下来再游到起点（不是闪现到跑道）',
      landing.entering === true && landing.wx !== 30, landing)
    console.log(`      （松手瞬间：离地 ${landing.y}px，在空中=${landing.air}）`)
    await cdp.shot('live-3a-落水中')

    await sleep(1800)
    const score = await cdp.eval('window.__whaleRun.score')
    check('分数在涨', score > 0, score)
    const hlGone = await cdp.eval('window.__whaleRun.heroTexts()')
    check('真机 · 碎字演完之后那些字不会自己长回来',
      hlGone.length >= 2 && hlGone.every((t) => t.hidden), hlGone)
    await cdp.shot('live-3-跑起来了')

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
    await sleep(120)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
    await cdp.shot('live-4-跳起来了')

    // ---- 二段跳：空中（还没落水时）再按一下得真能再顶一截 ----
    // ⚠️ 空格要**按住**：40ms 就松手会触发"松手截断"（可变跳跃高度），量到的是个矮跳，
    //    会以为二段跳没生效。
    const spaceDown = { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }
    const spaceUp = { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }
    await sleep(500)   // 等上一跳彻底落回水里
    await cdp.eval(`(function(){
      var eg = window.__whaleRun.engine;
      eg.st.obstacles.length = 0;
      eg.st.y = 0; eg.st.vy = 0; eg.st.grounded = true; eg.st.airJumps = 0;
      return true;
    })()`)
    await cdp.send('Input.dispatchKeyEvent', spaceDown)
    await sleep(210)                     // 一直按住，爬到接近第一下的最高点
    const apex1 = await cdp.eval('({ y: Math.round(window.__whaleRun.engine.st.y), air: !window.__whaleRun.engine.st.grounded })')
    await cdp.send('Input.dispatchKeyEvent', spaceDown)   // 空中再按一下（不是长按重复）
    await sleep(170)
    const apex2 = await cdp.eval('({ y: Math.round(window.__whaleRun.engine.st.y), used: window.__whaleRun.engine.st.airJumps })')
    await cdp.send('Input.dispatchKeyEvent', spaceUp)
    check('真机 · 空中再按一下能二段跳（比第一下顶得更高）',
      apex1.air === true && apex2.used === 1 && apex2.y > apex1.y + 8, { apex1: apex1, apex2: apex2 })
    await cdp.shot('live-4b-二段跳')

    // ---- 撞死，然后试着重开（用户报的"只能玩一局"）----
    const focusNow = await cdp.eval(`(function(){
      var a = document.activeElement;
      return a ? (a.tagName + '#' + (a.id||'') + '.' + String(a.className||'').split(' ').slice(0,2).join('.')) : 'none';
    })()`)
    // 撞死不许原地躺下：被打飞、翻着滚出画布，位置交给跟随层接着掉到窗口下沿。
    // ⚠️ 这一段只有 ~1 秒，而一次截图/一次 CDP 往返就可能花掉几百毫秒 ——
    //    靠"睡一会儿再问一次"是抓不到的（实测抓到的时候它已经掉出窗口了）。
    //    所以让页面自己每帧记一笔，回头来读这本账。
    await cdp.eval(`(function(){
      window.__rec = [];
      var t0 = performance.now();
      (function loop(){
        var t = performance.now() - t0;
        if (t > 5200) return;
        var r = document.querySelector('.wr-runway');
        window.__rec.push({
          t: Math.round(t),
          thrown: window.__whaleRun.thrown,
          falling: window.__whaleRun.falling,
          ry: Math.round(window.__whaleRun.carryingY),
          rot: Math.round((window.__whaleRun.falling ? window.__whaleRun.carryingTilt : window.__whaleRun.whaleRot) * 100) / 100,
          run: window.__whaleRun.running,
          cb: Math.round(r.getBoundingClientRect().bottom),
          shown: r.classList.contains('wr-shown'),
          pend: window.__whaleRun.retractPending,
          hh: (function () {
            var s = document.querySelector('[data-slot="conversation.hero.brand.mark"] svg');
            return !!s && s.style.visibility === 'hidden';
          })(),
        });
        requestAnimationFrame(loop);
      })();
      return true;
    })()`)
    await cdp.eval(`(function(){
      var eg = window.__whaleRun.engine;
      eg.st.y = 0; eg.st.grounded = true; eg.st.vy = 0;
      eg.st.obstacles.push({ kind:'coral', x: 40, y: eg.groundY - 40, oy: 40, w: 20, h: 40, alive: true, phase: 0 });
      return true;
    })()`)
    await sleep(350)
    const dead = await cdp.eval('({ phase: window.__whaleRun.state, running: window.__whaleRun.running })')
    check('能撞出 game over', dead.phase === 'over', dead)

    // 撞死之后得分要摆在跑道正中（大字），跑道也得比原来高
    const midScore = await cdp.eval(`(function(){
      var r = document.querySelector('.wr-runway').getBoundingClientRect();
      var card = document.querySelector('[data-composer-card]').getBoundingClientRect();
      var f = document.querySelector('.wr-over .wr-final');
      var fb = f.getBoundingClientRect();
      return {
        h: Math.round(r.height), bottom: Math.round(r.bottom), cardTop: Math.round(card.top),
        final: f.textContent, best: document.querySelector('.wr-over .wr-best').textContent,
        size: parseFloat(getComputedStyle(f).fontSize),
        score: window.__whaleRun.score,
        cy: Math.round(fb.top + fb.height / 2 - r.top),
      };
    })()`)
    check('真机 · 跑道拉高了，下沿还是停在输入区上面',
      midScore.h >= 150 && midScore.bottom <= midScore.cardTop, midScore)
    check('真机 · 撞死之后得分摆正中（大字、跟引擎分数一致）',
      midScore.final === String(midScore.score) && midScore.size >= 28 &&
      Math.abs(midScore.cy - midScore.h / 2) <= midScore.h * 0.35, midScore)
    console.log(`      （结算：${midScore.best}）`)
    await cdp.shot('live-5-gameover')
    console.log(`      （撞死时焦点在：${focusNow}）`)
    await sleep(900)

    const rec = await cdp.eval('window.__rec') || []
    const at = rec.findIndex((f) => f.thrown)
    const handed = at > 0 ? rec[at] : null
    const before = at > 0 ? rec[at - 1] : null
    check('真机 · 撞死之后被打飞出画布（不是原地躺着）',
      at > 0 && before.falling === false && handed.falling === true && handed.run === false && before.rot > 0.5,
      { at, before, handed })
    check('真机 · 交棒那一帧位置接得上（就在画布下沿往下一点）',
      !!handed && handed.ry >= handed.cb - 60 && handed.ry <= handed.cb + 140, handed)
    const fall = rec.slice(at).filter((f) => f.falling)
    check('真机 · 掉出去这一路是持续往下、还在翻',
      fall.length >= 2 && fall[fall.length - 1].ry > fall[0].ry + 100 &&
      fall[fall.length - 1].rot > fall[0].rot + 0.5,
      { n: fall.length, first: fall[0], last: fall[fall.length - 1] })
    const flewShot = fall[Math.floor(fall.length * 0.4)]
    console.log(`      （飞行轨迹 ${rec.length} 帧；交棒 t=${handed && handed.t}ms，落 ry=${flewShot && flewShot.ry}）`)
    await cdp.shot('live-5a-被丢出界面')

    // 掉到窗口下沿 → 水花 → 变回原位那只图标；结算那屏先留一会儿再自己收走。
    // ⚠️ 这段是"中间态"（结算只亮 ~0.8s），**不能**用"睡一会儿再问一次"：
    //    中间隔着一次截图 + 几次 CDP 往返就是好几百毫秒，问的时候早就过去了（实测假失败）。
    //    改成从上面那本逐帧账里核对顺序。
    const after = rec.slice(at)
    const lingers = after.filter((f) => f.shown && f.pend && f.hh === true)
    const backOut = after.filter((f) => !f.shown && f.hh === false)
    check('真机 · 掉到界面边缘就没了（没停在下边、也没原地躺着）',
      at > 0 && after.some((f) => !f.falling), { at: at, n: after.length })
    check('真机 · 结算那屏先亮着（分数看得清，图标还押着不还回来）',
      lingers.length >= 3, { n: lingers.length, first: lingers[0], last: lingers[lingers.length - 1] })
    check('真机 · 水面退去之后才把图标还回来', backOut.length >= 2,
      { n: backOut.length, tail: after.slice(-3), lastLinger: lingers[lingers.length - 1] })
    await cdp.shot('live-5b-掉出界面（结算还亮着）')

    let swept = null
    for (let i = 0; i < 60; i++) {
      swept = await cdp.eval(`({
        shown: document.querySelector('.wr-runway').classList.contains('wr-shown'),
        running: window.__whaleRun.running,
        heroHidden: (function(){ var s = document.querySelector('[data-slot="conversation.hero.brand.mark"] svg'); return !!s && s.style.visibility === 'hidden' })(),
        texts: window.__whaleRun.heroTexts(),
      })`)
      if (!swept.shown && swept.heroHidden === false && swept.texts.length >= 2 &&
          swept.texts.every((t) => !t.hidden)) break
      await sleep(100)
    }
    check('真机 · 水面退去之后，跑道收干净、图标和那些字才回来',
      swept.shown === false && swept.running === false && swept.heroHidden === false &&
      swept.texts.length >= 2 && swept.texts.every((t) => !t.hidden), swept)
    await cdp.shot('live-5c-收干净了')

    // 焦点不能还卡在跑道上 —— 不然用户回到界面敲字没反应
    const focusBack = await cdp.eval(`(function(){
      var a = document.activeElement;
      return { onOverlay: !!(a && a.closest && a.closest('#whale-run-root')),
               input: !!(a && a.hasAttribute && a.hasAttribute('data-composer-input')) };
    })()`)
    check('真机 · 收场之后焦点已经从跑道回到输入框那边', focusBack.onOverlay === false, focusBack)
    // 把焦点挪开再敲空格 —— 验的是"界面上随手一下空格不该又开一局"（焦点在输入框里那是正常打字）
    await cdp.eval(`(function(){ var a = document.activeElement; if (a && a.blur) a.blur(); return true })()`)

    // 收干净之后再敲空格**不该**凭空开新局（界面已经还原，别被误触打扰）
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
    await sleep(80)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
    await sleep(200)
    const noRestart = await cdp.eval(`({ running: window.__whaleRun.running })`)
    check('真机 · 收干净之后空格不再开新局', noRestart.running === false, noRestart)

    // 再来一局，撞死，**在结算还没收走的时候**按空格重开
    await cdp.eval('window.__whaleRun.restart()')
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
    let thrownNow = false
    for (let i = 0; i < 30; i++) {
      thrownNow = await cdp.eval('window.__whaleRun.thrown')
      if (thrownNow) break
      await sleep(50)
    }
    check('再来一局撞死之后鲸鱼又被丢出去了', thrownNow === true, thrownNow)

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
    await sleep(100)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
    await sleep(200)
    const replayByKey = await cdp.eval(`({
      phase: window.__whaleRun.state,
      score: window.__whaleRun.score,
      falling: window.__whaleRun.falling,
      overShown: document.querySelector('.wr-runway').classList.contains('wr-over-show'),
    })`)
    check('真机 · 撞死那一串还没演完时按空格能重开（下坠那只也被取消）',
      replayByKey.phase === 'running' && replayByKey.falling === false && !replayByKey.overShown, replayByKey)

    // 再撞死一次，这次用鼠标点跑道
    await cdp.eval(`(function(){
      var eg = window.__whaleRun.engine;
      eg.st.obstacles.push({ kind:'coral', x: 40, y: eg.groundY - 40, oy: 40, w: 20, h: 40, alive: true, phase: 0 });
      return true;
    })()`)
    await sleep(350)
    const r2 = await cdp.eval(`(function(){ var b = document.querySelector('.wr-runway').getBoundingClientRect(); return { cx: b.left+b.width/2, cy: b.top+b.height/2, phase: window.__whaleRun.state } })()`)
    await cdp.mouse('mousePressed', r2.cx, r2.cy)
    await cdp.mouse('mouseReleased', r2.cx, r2.cy)
    await sleep(250)
    const replayByClick = await cdp.eval(`({
      phase: window.__whaleRun.state,
      overShown: document.querySelector('.wr-runway').classList.contains('wr-over-show'),
    })`)
    check('真机 · game over 后点跑道能重开', replayByClick.phase === 'running' && !replayByClick.overShown, replayByClick)
    await cdp.shot('live-6-重开之后')

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await sleep(120)
    const reas = await cdp.eval(`({
      dir: window.__whaleRun.shatterDir,
      frags: document.querySelectorAll('.wr-shatter > *').length,
    })`)
    check('真机 · 收场时那些字是从波浪里拼回来的（不硬切）',
      reas.dir === -1 && reas.frags > 0, reas)
    await cdp.shot('live-6a-字正在拼回来')

    await sleep(400)
    const quit = await cdp.eval(`({
      running: window.__whaleRun.running,
      heroHidden: (function(){ var s = document.querySelector('[data-slot="conversation.hero.brand.mark"] svg'); return !!s && s.style.visibility === 'hidden' })(),
      shown: document.querySelector('.wr-runway').classList.contains('wr-shown'),
    })`)
    check('Esc 能收场', quit.running === false && quit.shown === false, quit)
    check('原鲸鱼被放回去了', quit.heroHidden === false, quit.heroHidden)
    // 拼字要演 ~1 秒，轮询等它回来
    let hlBack = null
    for (let i = 0; i < 40; i++) {
      hlBack = await cdp.eval('window.__whaleRun.heroTexts()')
      if (hlBack.length >= 2 && hlBack.every((t) => !t.hidden)) break
      await sleep(100)
    }
    check('真机 · 那些字拼回来之后才可见',
      hlBack.length >= 2 && hlBack.every((t) => !t.hidden), hlBack)
    await cdp.shot('live-7-收场后')

    // ---- 收起之后还能不能再摘一次（"一次性的"最可能是这条）----
    const probe = await cdp.eval(`(function(){
      function info(sel, name){
        var s = document.querySelector(sel);
        if (!s) return { name: name, found: false };
        var r = s.getBoundingClientRect();
        var cx = r.left + r.width/2, cy = r.top + r.height/2;
        var top = document.elementFromPoint(cx, cy);
        return {
          name: name, found: true,
          x: cx, y: cy,
          vis: getComputedStyle(s).visibility,
          topEl: top ? (top.tagName + '#' + (top.id || '') + '.' + String(top.className || '').split(' ').slice(0, 2).join('.')) : 'none',
        };
      }
      return {
        hero: info('[data-slot="conversation.hero.brand.mark"] svg', 'hero'),
        side: info('[data-slot="sidebar.brand.mark"] svg', 'sidebar'),
      };
    })()`)
    console.log(`      hero 那个点上最上面是：${probe.hero.found ? probe.hero.topEl : '(没有 hero)'}`)
    console.log(`      sidebar 那个点上最上面是：${probe.side.found ? probe.side.topEl : '(没有 sidebar)'}`)

    const target = probe.hero.found ? probe.hero : probe.side
    if (target.found) {
      await cdp.mouse('mousePressed', target.x, target.y)
      await cdp.mouse('mouseMoved', target.x + 70, target.y + 50)
      await sleep(150)
      const second = await cdp.eval(`({
        carrying: window.__whaleRun.carrying,
        shown: document.querySelector('.wr-runway').classList.contains('wr-shown'),
      })`)
      check('收起之后还能再摘第二次', second.carrying === true, { second, target: target.name })
      if (second.carrying) {
        const r3 = await cdp.eval(`(function(){ var b = document.querySelector('.wr-runway').getBoundingClientRect(); return { cx: b.left+b.width/2, cy: b.top+b.height/2 } })()`)
        await cdp.mouse('mouseMoved', r3.cx, r3.cy)
        await sleep(80)
        await cdp.mouse('mouseReleased', r3.cx, r3.cy)
        await sleep(600)
        const again = await cdp.eval('({ state: window.__whaleRun.state, running: window.__whaleRun.running })')
        check('第二次也能开起来', again.running === true && again.state === 'running', again)
        await cdp.shot('live-8-第二次玩')

        // ---- 水母：把分数顶到 500+ 之后才出场，而且是上下游着走的 ----
        await cdp.eval(`(function(){
          var api = window.__whaleRun;
          if (!api.running) api.restart();   // 上面那张截图的工夫里它可能已经撞死了
          api.engine.st.obstacles.length = 0;
          api.engine.st.dist = 7200;         // score = dist/12 = 600
          return true;
        })()`)
        let sawJelly = null
        // ⚠️ 水母只占出生的 38%，等一两只会等到"没中签"的假失败 —— 等的时候把场上的
        //    障碍清掉，鲸鱼就不会撞死（不然引擎一停就不再出生了），能一直等到它出现。
        for (let i = 0; i < 120; i++) {
          sawJelly = await cdp.eval(`(function(){
            var api = window.__whaleRun, eg = api.engine;
            if (!api.running) { api.restart(); eg = api.engine }   // 中途撞死了就重开
            eg.st.dist = 7200;                                     // 分数顶在门槛之上
            var obs = eg.st.obstacles, found = null;
            for (var i = 0; i < obs.length; i++) {
              var o = obs[i];
              if (!o.swim) continue;
              if (!o.__p) { o.__p = 1; o.__y0 = o.y }
              found = { kind: o.kind, x: Math.round(o.x), swim: !!o.swim, y: Math.round(o.y) };
            }
            if (!found) obs.length = 0;      // 还没等到就先别让它撞死
            return found;
          })()`)
          if (sawJelly) break
          await sleep(60)
        }
        check('真机 · 500 分之后水母才出现', !!sawJelly && sawJelly.swim === true, sawJelly)
        await cdp.shot('live-9-水母出来了')
        await sleep(420)
        const jellyMove = await cdp.eval(`(function(){
          var obs = window.__whaleRun.engine.st.obstacles;
          for (var i = 0; i < obs.length; i++) {
            var o = obs[i];
            if (o.__p) return { y0: Math.round(o.__y0), y: Math.round(o.y),
                                x0: Math.round(o.x), state: window.__whaleRun.state };
          }
          return null;
        })()`)
        check('真机 · 水母确实在上下游（同一只 y 变了）',
          !!jellyMove && jellyMove.state === 'running' && jellyMove.y !== jellyMove.y0, jellyMove)
      }
    }

    // ---- 收起之后，输入框还能不能正常点（隐形跑道不能挡路）----
    const composerHit = await cdp.eval(`(function(){
      window.__whaleRun.quit();
      var c = document.querySelector('[data-composer-card]');
      var r = c.getBoundingClientRect();
      var el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      var runway = document.querySelector('.wr-runway');
      return {
        topEl: el ? (el.tagName + '#' + (el.id||'') + '.' + String(el.className||'').split(' ').slice(0,2).join('.')) : 'none',
        insideRunway: !!(el && el.closest && el.closest('.wr-runway')),
        runwayPE: getComputedStyle(runway).pointerEvents,
      };
    })()`)
    check('收起后隐形跑道不挡输入框的点击', composerHit.insideRunway === false, composerHit)

    // 跑道的矩形压在谁头上？收起之后它必须完全不吃指针 —— 不然会被挡住的就是鲸鱼本身
    const overlap = await cdp.eval(`(function(){
      window.__whaleRun.quit();
      var r = document.querySelector('.wr-runway').getBoundingClientRect();
      function ov(sel){
        var s = document.querySelector(sel); if (!s) return null;
        var b = s.getBoundingClientRect();
        var w = Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left));
        var h = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top));
        return { w: Math.round(w), h: Math.round(h) };
      }
      return {
        runway: { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), pe: getComputedStyle(document.querySelector('.wr-runway')).pointerEvents },
        hero: ov('[data-slot="conversation.hero.brand.mark"] svg'),
        side: ov('[data-slot="sidebar.brand.mark"] svg'),
      };
    })()`)
    console.log(`      跑道矩形 ${JSON.stringify(overlap.runway)}`)
    console.log(`      与 hero 鲸鱼重叠 ${JSON.stringify(overlap.hero)}，与侧边栏鲸鱼重叠 ${JSON.stringify(overlap.side)}`)
  }
} catch (e) {
  check('跑完真机流程', false, String(e && e.stack || e))
} finally {
  const exc = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text)
  const errs = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error')
    .map((e) => (e.params.args || []).map((a) => a.value ?? a.description).join(' '))
  const ours = exc.concat(errs).filter((s) => /whale-run|__ModuleLoader__|client-modules/i.test(String(s)))
  check('浏览器端没有和本插件相关的报错', ours.length === 0, ours.slice(0, 5))

  console.log(`\n${failed === 0 ? '全过' : failed + ' 项没过'} · 截图在 ${SHOTS}`)
  try { ws.close() } catch (e) { /* ignore */ }
}

process.exit(failed === 0 ? 0 : 1)
