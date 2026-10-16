/* dsh-whale-run — 浏览器半侧。
 *
 * 把界面上那只鲸鱼（空会话欢迎页中央的 hero 鲸鱼，或侧边栏 logo）用鼠标摘下来，
 * 拖到输入框上方滑出的跑道上放下，跑一局小恐龙式的跑酷。
 *
 * 设计要点（改这个文件前先读）：
 *   1. 一律用 data-slot / data-composer-* 这类非 hash 锚点定位，绝不写死 CSS module 的类名。
 *   2. 鲸鱼的形状从活的 DOM 上抓（path 的 d + viewBox），不硬编码那 3474 字符，
 *      这样升级 dsh 后画的仍然是当前版本的官方 logo。
 *   3. 平台开着 HMR：本文件一存盘，整个插件会被拆掉重建。任何 listener / timer /
 *      observer 都必须挂进 ctx.effect 的清理函数，否则会跨重建累积。
 *   4. 注入的 <style> 必须带 data-plugin，否则会被平台的 claimStyles 认领给别的插件，
 *      然后那个插件重建时把它删掉。
 *   5. 引擎和美术是零 DOM 副作用的纯逻辑，将来可以直接搬进 lib/client.engine.js。
 */

window.__ModuleLoader__.load({
  id: '@dph/dsh-whale-run',
  factory: function (require) {
    'use strict'

    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ============================================================ §1 config

    var PKG = '@dph/dsh-whale-run'
    var Z_INDEX = 950
    var GAP = 12             // 水面与输入卡片顶边的距离
    var RUNWAY_H = 160        // 跑道高度：地面线固定在离下沿 14px，多出来的都在上方（撞死后的得分摆那儿）
    var JELLY_FROM = 500      // 水母从 500 分才开始出现（前半段只有地面那三样）
    var RUNWAY_H_MIN = 72
    var FLOOR_H = 14
    var DRAG_SLOP = 4
    var CARRY_BOX = 120      // 跟随鼠标那只鲸鱼的画布边长（够放下原位那种大号的 + 回弹）
    var STORE_BEST = 'dsh-whale-run.best'
    var STORE_MUTE = 'dsh-whale-run.mute'
    var WALK_MS = 700        // 落点挪到起点要多久
    var START_X = 30         // 鲸鱼在跑道上的起点（左边缘）
    var HEADLINE = '探索未至之境'   // 欢迎页 hero 那句标题，落下时碎掉的就是它

    var SEL_HERO = '[data-slot="conversation.hero.brand.mark"]'
    var SEL_SIDE = '[data-slot="sidebar.brand.mark"]'
    var SEL_CARD = '[data-composer-card]'
    var SEL_SEAT = '[data-composer-seat]'
    var SEL_INPUT = '[data-composer-input]'
    var EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]'
    var MODAL = '[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]'

    function log() {
      var a = Array.prototype.slice.call(arguments)
      a.unshift('[whale-run]')
      console.log.apply(console, a)
    }

    // ============================================================ §1b theme
    // dsh 的整站配色挂在 <body> 上：**浅色是 body 自己那一块 token，深色是
    // body[data-ds-dark-theme] 那一块**（两套完整 token 在 head CSS 里对切）。
    // 我们画的是"墨线" —— 写死白线在浅色底上就是隐形，所以这里量出当前主题，
    // 白墨 / 黑墨二选一。canvas 不认 CSS 变量，只能 JS 侧自己存一份（见 ink()）。
    // ⚠️ 不能用 prefers-color-scheme 判：dsh 允许显式选主题，用户选的跟系统不一致时它不作数。
    var THEME = { light: false }

    // 同一个 alpha 值，黑墨铺在浅底上"看着"比白墨铺在深底上淡一截
    //（对比度按相对亮度算：深底那档 4.3:1，浅底只有 3.0:1）。所以浅色这一档整体加重，
    // 让两边的线稿看起来一样实。1.25 是照着"对比度拉平"算出来的。
    var INK_K = 1.25

    function ink(a) {
      return THEME.light ? 'rgba(0,0,0,' + Math.min(1, a * INK_K) + ')' : 'rgba(255,255,255,' + a + ')'
    }

    // 水线：暗色那套是「白 / 淡蓝」两层（深海偏蓝），浅色跟着换成「黑 / 深藏青」，
    // 否则白线铺在浅底上等于什么都没画。透明度走参数（要乘 INK_K），别再拼字符串前缀。
    function waterInk(deep, a) {
      if (THEME.light) return 'rgba(' + (deep ? '20,52,96,' : '0,0,0,') + Math.min(1, a * INK_K) + ')'
      return 'rgba(' + (deep ? '198,220,255,' : '255,255,255,') + a + ')'
    }

    function lumOf(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 }

    // 把 CSS 颜色串折成 0~1 亮度。认不出来（color-mix / light-dark 之类）返回 null，
    // 调用方走下一档；透明度接近 0 的也当没给（透明黑会被算成"深色"）。
    function cssLum(s) {
      s = String(s || '').trim()
      var m = /^#([0-9a-f]{3,8})$/i.exec(s)
      if (m) {
        var h = m[1]
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
        if (h.length !== 6 && h.length !== 8) return null
        return lumOf(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16))
      }
      m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/i.exec(s)
      if (!m) return null
      if (m[4] !== undefined) {
        var a = m[4].indexOf('%') >= 0 ? parseFloat(m[4]) / 100 : parseFloat(m[4])
        if (!(a > 0.1)) return null
      }
      return lumOf(+m[1], +m[2], +m[3])
    }

    function detectLight() {
      var body = document.body
      if (!body) return false
      // 最直接的判据：dsh 的深色主题就是这一条属性（两套 token 都挂在它身上）
      if (body.hasAttribute('data-ds-dark-theme')) return false
      var cs = getComputedStyle(body)
      // 退一档：主文字的亮度（浅色主题下主文字是深色）
      var l = cssLum(cs.getPropertyValue('--dsw-alias-label-primary'))
      if (l === null) l = cssLum(cs.backgroundColor)      // 再退一档：页面底色
      if (l === null) return !window.matchMedia('(prefers-color-scheme: dark)').matches
      return l < 0.5
    }

    // ============================================================ §2 css

    // 风格基调：**别做成一整块卡片**。dsh 是极简暗色 UI，
    // 跑道应该只是一层几乎看不见的水面 + 一条波纹线，不要边框、不要底色、不要阴影。
    // 颜色一律走 --wr-ink / --wr-glow / --wr-k 三个通道变量：浅色主题下由
    // `#whale-run-root[data-wr-light]` 整体翻成黑字白晕、透明度按 --wr-k 加重
    //（同一个 alpha 黑墨在浅底上"看着更淡"，见 INK_K），不用写两套。改文案/布局时
    // 别再往这里写死 rgba(255,255,255,...)。
    // 透明度都写成 calc(a*var(--wr-k))：浅色主题下 --wr-k 变成 INK_K，
    // 同一条规则自动加重一档，不用为浅色再抄一遍整段 CSS。
    function inkA(a) { return 'rgba(var(--wr-ink),calc(' + a + '*var(--wr-k)))' }
    function glowA(a) { return 'rgba(var(--wr-glow),' + a + ')' }

    var CSS = [
      '#whale-run-root{position:fixed;inset:0;pointer-events:none;z-index:' + Z_INDEX + ';contain:layout style;',
      '  --wr-ink:255,255,255;--wr-glow:0,0,0;--wr-k:1}',
      // 浅色主题：字变黑、投影变白（投影在浅底上本来就几乎看不见，留着只是为了
      // 水线从字底下过的时候还能把字托出来）
      '#whale-run-root[data-wr-light]{--wr-ink:0,0,0;--wr-glow:255,255,255;--wr-k:' + INK_K + '}',
      '#whale-run-root[hidden]{display:none}',

      '.wr-runway{position:absolute;left:0;top:0;z-index:1;pointer-events:auto;will-change:transform;outline:none}',
      // 收起时必须是 pointer-events:none —— 不然那块 width/height 还留着的隐形矩形
      // 会一直挡在输入框（和压在下面的鲸鱼）上面，把点击全吃掉。
      '.wr-runway:not(.wr-shown){pointer-events:none}',
      '.wr-inner{position:relative;width:100%;height:100%;opacity:0;transform:translateY(7px);',
      '  transition:opacity .52s ease-out,transform .56s cubic-bezier(.22,.9,.28,1)}',
      '.wr-runway.wr-shown .wr-inner{opacity:1;transform:none}',
      '.wr-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}',

      '.wr-hud{position:absolute;right:2px;top:2px;display:flex;gap:6px;align-items:center;',
      '  font:500 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em;',
      '  color:' + inkA('.34') + ';pointer-events:none}',
      '.wr-hud .wr-hi{opacity:.6}',
      '.wr-btn{pointer-events:auto;width:18px;height:18px;border:0;border-radius:5px;padding:0;',
      '  background:transparent;color:' + inkA('.34') + ';cursor:pointer;',
      '  font:400 11px/1 system-ui,sans-serif;display:flex;align-items:center;justify-content:center}',
      '.wr-btn:hover{background:' + inkA('.08') + ';color:' + inkA('.7') + '}',
      '.wr-hint{position:absolute;left:50%;top:22%;transform:translate(-50%,-50%);pointer-events:none;',
      '  font:400 11px/1 system-ui,sans-serif;color:' + inkA('.28') + ';letter-spacing:.12em;',
      '  white-space:nowrap;transition:opacity .3s}',
      '.wr-runway.wr-armed .wr-hint,.wr-runway.wr-playing .wr-hint{opacity:0}',
      // 结算那层**一点底都不留**（留了就又是一块"半透明窗口"），
      // 只靠文字自己的投影保证在任意背景上都读得出来。
      '.wr-over{position:absolute;inset:0;display:flex;flex-direction:column;gap:6px;',
      '  align-items:center;justify-content:center;pointer-events:none;opacity:0;transition:opacity .2s}',
      '.wr-runway.wr-over-show .wr-over{opacity:1}',
      '.wr-over b{font:500 11px/1 system-ui,sans-serif;color:' + inkA('.58') + ';letter-spacing:.3em;',
      '  text-shadow:0 1px 14px ' + glowA('.95') + ',0 0 3px ' + glowA('.9') + '}',
      // 得分：撞死之后摆在正中的那个大字（角落那行小 HUD 太不显眼）
      '.wr-over em{font:600 34px/1 ui-monospace,SFMono-Regular,Consolas,monospace;font-style:normal;',
      '  color:' + inkA('.97') + ';font-variant-numeric:tabular-nums;letter-spacing:.02em;',
      '  text-shadow:0 2px 18px ' + glowA('.96') + ',0 0 4px ' + glowA('.9') + ';',
      '  transform:translateY(6px) scale(.82);transition:transform .34s cubic-bezier(.2,.9,.3,1.25)}',
      '.wr-runway.wr-over-show .wr-over em{transform:none}',
      '.wr-over span{font:400 10px/1 system-ui,sans-serif;color:' + inkA('.62') + ';letter-spacing:.06em;',
      '  text-shadow:0 1px 10px ' + glowA('.95') + '}',
      '.wr-over .wr-best{color:' + inkA('.45') + '}',

      // 粒子层（全屏）与手上那只鲸鱼，都浮在跑道之上
      '.wr-fx{position:absolute;left:0;top:0;z-index:2;pointer-events:none}',
      '.wr-carry{position:absolute;left:0;top:0;z-index:4;pointer-events:none;opacity:0;',
      '  will-change:transform;transition:opacity .18s}',
      '.wr-carry.wr-live{opacity:1}',
      // 标题碎掉的那一层：逐字克隆，位置/字体全部从原节点量出来
      '.wr-shatter{position:absolute;left:0;top:0;z-index:3;pointer-events:none}',
      '.wr-shatter span{position:absolute;left:0;top:0;white-space:pre;will-change:transform,opacity,filter}',
    ].join('\n')

    // 必须打标记：平台的 claimStyles 会把无主 <style> 认领给下一个物化的插件，
    // 然后那个插件重建时把我们的样式删掉。打了标记就归我们，平台负责在 reload 时清。
    // 另外这里是「复用」而不是「再插一份」——HMR 会把插件整个重建，
    // 每次 apply 都插一份的话，反复存盘就会堆出一串重复的 <style>。
    function ensureStyle() {
      var el = document.querySelector('style[data-plugin="' + PKG + '"]')
      if (el) return el
      el = document.createElement('style')
      el.setAttribute('data-plugin', PKG)
      el.textContent = CSS
      document.head.appendChild(el)
      return el
    }

    // ============================================================ §3 fish

    var fishCache = { d: null, path: null }

    function parseViewBox(s) {
      var n = String(s || '').trim().split(/[\s,]+/).map(Number)
      return n.length === 4 && n.every(function (v) { return isFinite(v) && v > 0 }) ? n : [0, 0, 23.16, 17.04]
    }

    // 从 DOM 上抓一只鲸鱼：返回 { d, vb, color, svg }
    function readFish(sel) {
      var host = document.querySelector(sel)
      if (!host) return null
      var svg = host.querySelector('svg')
      if (!svg) return null
      var p = svg.querySelector('path')
      var d = p && p.getAttribute('d')
      if (!d) return null
      var color = ''
      try { color = getComputedStyle(svg).color || '' } catch (e) { color = '' }
      return { d: d, vb: parseViewBox(svg.getAttribute('viewBox')), color: color, svg: svg }
    }

    function getFishPath(d) {
      if (fishCache.d === d && fishCache.path) return fishCache.path
      var p = null
      try { p = new Path2D(d) } catch (e) { p = null }
      fishCache.d = d
      fishCache.path = p
      return p
    }

    // ============================================================ §4 store

    function loadNum(key, fallback) {
      try {
        var v = localStorage.getItem(key)
        return v === null ? fallback : Number(v)
      } catch (e) { return fallback }
    }

    function saveNum(key, n) {
      try { localStorage.setItem(key, String(n)) } catch (e) { /* 不透明 origin 就放弃 */ }
    }

    // ============================================================ §5 sound

    function createSound() {
      var ctx = null
      var muted = loadNum(STORE_MUTE, 0) === 1
      function ac() {
        if (ctx) return ctx
        try {
          var C = window.AudioContext || window.webkitAudioContext
          if (!C) return null
          ctx = new C()
        } catch (e) { ctx = null }
        return ctx
      }
      function beep(freq, dur, type, gain, slideTo) {
        if (muted) return
        var a = ac()
        if (!a) return
        try {
          if (a.state === 'suspended') a.resume()
          var o = a.createOscillator()
          var g = a.createGain()
          o.type = type || 'square'
          o.frequency.setValueAtTime(freq, a.currentTime)
          if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, a.currentTime + dur)
          g.gain.setValueAtTime(Math.max(0.0001, (gain || 0.05)), a.currentTime)
          g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur)
          o.connect(g)
          g.connect(a.destination)
          o.start()
          o.stop(a.currentTime + dur + 0.02)
        } catch (e) { /* 音频失败不该影响游戏 */ }
      }
      return {
        jump: function () { beep(520, 0.07, 'square', 0.045) },
        point: function () { beep(880, 0.09, 'sine', 0.05) },
        hit: function () { beep(180, 0.3, 'sawtooth', 0.06, 70) },
        land: function () { beep(300, 0.05, 'sine', 0.03) },
        isMuted: function () { return muted },
        toggle: function () { muted = !muted; saveNum(STORE_MUTE, muted ? 1 : 0); return muted },
        // HMR 会把插件整个重建，不关掉的话反复存盘会攒下一堆 AudioContext，
        // 而浏览器对同时存在的 AudioContext 数量是有硬上限的。
        close: function () {
          if (!ctx) return
          try { ctx.close() } catch (e) { /* 已经关了 */ }
          ctx = null
        },
      }
    }

    // ============================================================ §6 engine
    // 纯逻辑，不碰 DOM，可用 setSeed 复现。

    function mulberry32(seed) {
      var a = seed >>> 0
      return function () {
        a = (a + 0x6d2b79f5) | 0
        var t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    var GRAV = 2600
    var JUMP_V = -585
    var AIR_JUMP_K = 0.72     // 二段跳的初速倍率（高度按平方算 ≈ 第一下的一半）
    var DIVE_GRAV = 5600
    var SPEED_MIN = 300
    var SPEED_MAX = 640
    var RAMP_S = 60

    function createEngine(cfg) {
      var W = cfg.w
      var H = cfg.h
      var groundY = H - FLOOR_H
      var rng = cfg.rng || Math.random

      // 跑道上的鲸鱼就用「拖起来那只」的尺寸，落地时不会突然变大一圈
      var WHALE_W = Math.max(34, Math.min(72, cfg.whaleW || 44))
      var WHALE_H = WHALE_W * (cfg.vb ? cfg.vb[3] / cfg.vb[2] : 17.04 / 23.16)

      var st = {
        phase: 'ready',      // ready | running | over
        t: 0, dist: 0, score: 0, speed: SPEED_MIN,
        wx: START_X,         // 鲸鱼当前的左边缘 x（掉落之后要慢慢挪到起点，不能瞬移）
        entering: false, enterT: 0, enterFrom: START_X, entLanded: false, enterBounce: 0,
        y: 0, vy: 0, grounded: true, diving: false, diveHeld: false,
        obstacles: [], nextAt: 0, shake: 0, flash: 0, milestone: 0,
        theme: 0, bubbles: [], splashes: [], jumpCut: false,
        airJumps: 0, jumpV: -585,
        // 撞死之后不许原地躺下：先被打飞起来转着，掉出画布就交给覆盖层接着往下掉。
        over: 0, rot: 0, kvx: 0, out: false, thrown: false,
      }

      function reset() {
        st.phase = 'ready'
        st.t = 0; st.dist = 0; st.score = 0; st.speed = SPEED_MIN
        st.wx = START_X; st.entering = false; st.enterT = 0; st.enterFrom = START_X
        st.entLanded = false; st.enterBounce = 0
        st.y = 0; st.vy = 0; st.grounded = true; st.diving = false; st.diveHeld = false
        st.airJumps = 0; st.jumpV = JUMP_V
        st.obstacles = []; st.nextAt = 0.85; st.over = 0; st.shake = 0; st.flash = 0
        st.rot = 0; st.kvx = 0; st.out = false; st.thrown = false
        st.milestone = 0; st.theme = 0; st.splashes = []
        st.bubbles = []
        for (var i = 0; i < 18; i++) {
          st.bubbles.push({ x: rng() * W, y: rng() * groundY, r: 1 + rng() * 2.6, sp: 0.25 + rng() * 0.9 })
        }
      }

      reset()

      function whaleBox() {
        var h = (st.diving && st.grounded) ? 15 : 26
        return { x: st.wx + 7, y: groundY - st.y - h, w: WHALE_W - 16, h: h }
      }

      // 水母的 S 型游动：**一会高一会低**，低的时候顶在鲸鱼跑的那条线上（撞得到、必须下潜），
      // 高的时候抬到跑着能过（但别跳）。相位挂在**世界坐标 x** 上（不是时间上）：
      // 路径钉死在场景里，同一颗种子复现得出同一条，玩家也能提前看出它要往哪去、该不该下潜。
      // ⚠️ 下探的**最低点就是原来那个会撞人的高度**（不再往下）：下潜时鲸鱼只剩 15px 高，
      //    盒子底再往下压一点就变成"躲不开"了 —— 水母必须永远潜得过去。
      // ⚠️ 头顶的地方不够摆（窗口很矮）时幅度自己收，别把整只摆出画布外面 —— 那样
      //    看不见却照样撞人。（`resize` 之后也走这里，所以放在函数里算而不是出生时算一次。）
      function swimY(o) {
        var room = groundY - o.oy - o.h - 6
        var amp = Math.max(0, Math.min(o.amp, room))
        return groundY - o.oy - amp * (0.5 + 0.5 * Math.sin(o.x * o.k + o.ph))
      }

      function newObstacle() {
        var r = rng()
        var kind
        // 水母是后段的难度：500 分之前只出地面那三样
        if (st.score >= JELLY_FROM) {
          if (r < 0.62) kind = rng() < 0.45 ? 'bottle' : (rng() < 0.6 ? 'net' : 'coral')
          else if (r < 0.88) kind = 'jelly'         // 必须下潜
          else kind = 'jellyHigh'                    // 从下面游过去就行
        } else {
          kind = r < 0.45 ? 'bottle' : (r < 0.75 ? 'net' : 'coral')
        }
        var o = { kind: kind, x: W + 24, alive: true, phase: rng() * 6.28 }
        if (kind === 'bottle') { o.w = 16; o.h = 30 }
        else if (kind === 'net') { o.w = 38; o.h = 22 }
        else if (kind === 'coral') { o.w = 20; o.h = 40 }
        else if (kind === 'jelly') { o.w = 26; o.h = 22; o.oy = 40 }
        else { o.w = 26; o.h = 22; o.oy = 62 }
        if (kind === 'net' || kind === 'coral' || kind === 'bottle') o.oy = o.h
        else {
          o.swim = true
          // 摆幅比它自己还高：低相位要**明显顶在鲸鱼跑的那条线上**（撞得到、必须下潜），
          // 高相位要明显抬到跑着能过的高度。摆太小就只是原地抖，看不出"一会高一会低"。
          o.amp = 34 + rng() * 12                // 34~46px：比它自己高一大截，摆起来才像"一会高一会低"（只往上摆，见 swimY）
          o.k = 6.2832 / (300 + rng() * 120)     // 一个 S 走多长
          o.ph = rng() * 6.2832                  // 各自错开
        }
        o.y = o.swim ? swimY(o) : groundY - o.oy
        return o
      }

      function splash(x, n, scale) {
        for (var i = 0; i < n; i++) {
          st.splashes.push({
            x: x + (rng() - 0.5) * 20 * scale,
            y: groundY,
            vx: (rng() - 0.5) * 150 * scale,
            vy: (-70 - rng() * 110) * scale,
            life: 0.45 + rng() * 0.25,
          })
        }
      }

      function hit(a, b) {
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      }

      // 起跳。站地上是正常那一下；**空中还能再蹬一下**（二段跳），但比第一下矮
      // （JUMP_V 乘 0.72，高度只到约一半），而且一段跳只能补一次。
      function jump() {
        if (st.phase === 'ready') { st.phase = 'running'; st.t = 0 }
        if (st.phase !== 'running') return false
        var air = !st.grounded
        if (air && st.airJumps >= 1) return false
        var v = air ? JUMP_V * AIR_JUMP_K : JUMP_V
        st.vy = v
        st.jumpV = v
        st.grounded = false
        st.diving = false
        st.jumpCut = false
        if (air) st.airJumps++
        var b = whaleBox()               // 注意在 grounded=false 之后取：空中那只的盒子是站姿那套
        for (var i = 0; i < 7; i++) {
          st.splashes.push({
            x: b.x + rng() * b.w,
            // 二段跳的气泡炸在**脚底下**（它离水面还有一段），一段跳才是水面炸开
            y: air ? b.y + b.h : groundY,
            vx: (rng() - 0.5) * 90,
            vy: air ? 30 + rng() * 70 : -60 - rng() * 90,
            life: air ? 0.38 : 0.5,
          })
        }
        return true
      }

      function releaseJump() {
        // 用**这一下自己的**初速来算"松手截断"，二段跳照样能控高
        var cut = st.jumpV * 0.45
        if (st.phase === 'running' && !st.grounded && st.vy < cut) {
          st.vy = cut
          st.jumpCut = true
        }
      }

      function setDive(on) {
        st.diveHeld = !!on
        if (st.phase !== 'running') return
        if (on) {
          st.diving = true
          if (!st.grounded) st.vy += 900
        } else {
          st.diving = false
        }
      }

      // fromX：松手时鲸鱼的左边缘（跑道局部 x）
      // fromY：松手时鲸鱼**离地多高**（>0 就是悬在空中）—— 会给它一段自由落体 + 一次弹跳
      function start(fromX, fromY) {
        reset()
        st.phase = 'running'
        if (typeof fromX === 'number' && isFinite(fromX)) {
          st.enterFrom = Math.max(-WHALE_W, Math.min(W, fromX))
          st.wx = Math.max(0, Math.min(W - WHALE_W, st.enterFrom))
          st.entering = true
          st.enterT = 0
          st.entLanded = false
          st.enterBounce = 0
          var drop = (typeof fromY === 'number' && isFinite(fromY) && fromY > 0) ? fromY : 0
          st.y = drop
          st.grounded = drop <= 0.5
          st.vy = 0
        }
        return true
      }

      // 撞死之后：先被打飞起来、翻着滚，落回水面再一路掉出画布。
      // 出了画布就归覆盖层接着画（`st.out` → 插件里的 throwWhaleOut），
      // 从画布底边到窗口底边那一段在引擎里是看不见的，只能交给它。
      function stepOver(dt) {
        st.over += dt
        if (st.thrown) return
        var prevY = st.y
        st.vy += GRAV * 0.9 * dt
        st.y -= st.vy * dt
        st.wx += st.kvx * dt
        st.kvx *= (1 - Math.min(0.5, 0.8 * dt))
        st.rot += (5.4 + st.over * 3) * dt        // 越翻越快
        if (prevY > 0 && st.y <= 0) splash(st.wx + WHALE_W / 2, 12, 1.35)
        if (st.y < -(WHALE_H + 12)) st.out = true
      }

      function step(dt) {
        if (dt > 0.1) dt = 0.1
        if (st.phase !== 'running') {
          if (st.phase === 'over') stepOver(dt)
          whirl(dt)
          return
        }
        st.t += dt

        if (st.entering) {
          // 入场分两段：先**掉下来**（落水 + 弹一下），落定了再从落点游到起点。
          st.enterT += dt
          if (!st.entLanded) {
            if (!st.grounded) {
              st.vy += GRAV * dt
              st.y -= st.vy * dt
              if (st.y <= 0) {
                st.y = 0
                var impact = st.vy
                splash(st.wx + WHALE_W / 2, 8, 1.1)
                if (st.enterBounce < 1 && impact > 160) {
                  // 在跑道上弹一下再走
                  st.enterBounce++
                  st.vy = -impact * 0.42
                  st.grounded = false
                  if (cfg.onLand) cfg.onLand()
                } else {
                  st.vy = 0
                  st.grounded = true
                  st.airJumps = 0            // 落地就把二段跳补回来
                  st.entLanded = true
                  st.enterT = 0
                  if (cfg.onLand) cfg.onLand()
                }
              }
            } else {
              st.entLanded = true
              st.enterT = 0
            }
          } else {
            var ep = Math.min(1, st.enterT / (WALK_MS / 1000))
            var ee = ep < 0.5 ? 2 * ep * ep : 1 - Math.pow(-2 * ep + 2, 2) / 2
            st.wx = st.enterFrom + (START_X - st.enterFrom) * ee
            if (ep >= 1) { st.entering = false; st.wx = START_X; st.enterFrom = START_X }
          }
          st.enterFrom = Math.min(W - WHALE_W, Math.max(0, st.enterFrom))
          stepParticles(dt)
          return
        }

        st.speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * Math.min(1, st.t / RAMP_S)
        st.dist += st.speed * dt
        var sc = Math.floor(st.dist / 12)
        if (sc > st.score) st.score = sc
        if (st.score - st.milestone >= 100) {
          st.milestone = Math.floor(st.score / 100) * 100
          st.flash = 0.35
          if (cfg.onPoint) cfg.onPoint(st.milestone)
        }
        st.theme = Math.floor(st.score / 700) % 2
        if (st.flash > 0) st.flash = Math.max(0, st.flash - dt)
        if (st.shake > 0) st.shake = Math.max(0, st.shake - dt)

        // 竖直运动
        var g = (st.diving && !st.grounded) ? DIVE_GRAV : GRAV
        if (!st.grounded) {
          st.vy += g * dt
          st.y -= st.vy * dt
          if (st.y <= 0) {
            st.y = 0; st.vy = 0; st.grounded = true
            st.airJumps = 0              // 落地就把二段跳补回来
            if (cfg.onLand) cfg.onLand()
            for (var s = 0; s < 6; s++) {
              st.splashes.push({ x: st.wx + rng() * WHALE_W, y: groundY, vx: (rng() - 0.5) * 120, vy: -40 - rng() * 70, life: 0.4 })
            }
          }
        } else if (st.diving) {
          st.y = 0
        }

        // 障碍
        for (var i = st.obstacles.length - 1; i >= 0; i--) {
          var o = st.obstacles[i]
          o.x -= st.speed * dt
          if (o.swim) o.y = swimY(o)          // 水母沿着自己的波形上下游
          if (o.x + o.w < -30) { st.obstacles.splice(i, 1); continue }
          if (o.alive && hit(whaleBox(), o)) {
            o.alive = false
            st.phase = 'over'
            st.over = 0
            st.shake = 0.4
            // 被打飞：往上弹一下、顺带往后漂，接着由 stepOver 翻着滚出画布
            st.vy = -320
            st.grounded = false
            st.diving = false
            st.diveHeld = false
            st.kvx = -80
            for (var d = 0; d < 14; d++) {
              st.splashes.push({
                x: st.wx + rng() * WHALE_W,
                y: groundY - 8 - rng() * 22,
                vx: (rng() - 0.5) * 150,
                vy: -50 - rng() * 120,
                life: 0.9,
              })
            }
            if (cfg.onGameOver) cfg.onGameOver(st.score)
            return
          }
        }
        st.nextAt -= dt
        if (st.nextAt <= 0) {
          st.obstacles.push(newObstacle())
          st.nextAt = (0.60 + rng() * 0.55) + 40 / st.speed
        }

        stepParticles(dt)
      }

      function stepParticles(dt) {
        for (var b = st.bubbles.length - 1; b >= 0; b--) {
          var bu = st.bubbles[b]
          bu.x -= (st.speed * 0.12 + bu.sp * 8) * dt
          bu.y -= bu.sp * 22 * dt
          if (bu.x < -8 || bu.y < -8) { bu.x = W + 8; bu.y = groundY * (0.15 + rng() * 0.85) }
        }
        whirl(dt)
      }

      function whirl(dt) {
        for (var k = st.splashes.length - 1; k >= 0; k--) {
          var sp = st.splashes[k]
          sp.life -= dt
          if (sp.life <= 0) { st.splashes.splice(k, 1); continue }
          sp.vy += 420 * dt
          sp.x += sp.vx * dt
          sp.y += sp.vy * dt
        }
      }

      return {
        st: st,
        groundY: groundY,
        whaleW: WHALE_W,
        whaleH: WHALE_H,
        whaleBox: whaleBox,
        jump: jump,
        releaseJump: releaseJump,
        setDive: setDive,
        start: start,
        reset: reset,
        step: step,
        swimY: swimY,
        resize: function (w, h) {
          W = w; H = h; groundY = H - FLOOR_H
          for (var i = 0; i < st.obstacles.length; i++) {
            var o = st.obstacles[i]
            o.y = o.swim ? swimY(o) : groundY - o.oy
          }
        },
      }
    }

    // ============================================================ §7 art

    function createArt(getP2d, vb, colorRef) {
      var VW = vb[2]
      var VH = vb[3]

      function drawWhale(ctx, cx, cy, w, opts) {
        var p = getP2d()
        if (!p) return
        opts = opts || {}
        var k = w / VW
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(opts.rot || 0)
        ctx.scale(k * (opts.sx || 1), k * (opts.sy || 1))
        ctx.translate(-VW / 2, -VH / 2)
        ctx.globalAlpha = opts.alpha === undefined ? 1 : opts.alpha
        // 落不到 DOM 颜色时（拿不到那只 svg）跟着主题走，别用写死的浅色
        ctx.fillStyle = opts.color || colorRef.value || (THEME.light ? '#16181c' : '#e6edf3')
        ctx.fill(p)
        ctx.restore()
        ctx.globalAlpha = 1
      }

      // 障碍一律做成单色线稿：跟 dsh 的 UI 一个调子。
      // 原来那套彩色卡通风（紫水母/蓝瓶子/红珊瑚）贴在界面里像一块贴纸。
      // ⚠️ 颜色**每帧现算**（ink() 跟着主题翻），别再提成模块级的常量字符串 ——
      //    那样一提就锁死在暗色主题上，浅色底下全隐形。
      function drawJelly(ctx, o, t) {
        var cx = o.x + o.w / 2
        var cy = o.y + 10
        var wob = Math.sin(t * 3.4 + o.phase) * 1.8
        ctx.save()
        ctx.strokeStyle = ink(.42)
        ctx.fillStyle = ink(.16)
        ctx.lineWidth = 1.3
        ctx.beginPath()
        ctx.ellipse(cx, cy + wob, o.w / 2, 9 + wob * 0.3, 0, Math.PI, 0)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
        for (var i = -2; i <= 2; i++) {
          ctx.beginPath()
          ctx.moveTo(cx + i * 4, cy + wob)
          ctx.quadraticCurveTo(cx + i * 4 + Math.sin(t * 4.2 + i) * 3, cy + 9 + wob, cx + i * 4 + Math.sin(t * 4.2 + i + 1) * 4, cy + 18 + wob)
          ctx.stroke()
        }
        ctx.restore()
      }

      function drawBottle(ctx, o) {
        var x = o.x, y = o.y, w = o.w, h = o.h
        ctx.save()
        ctx.strokeStyle = ink(.42)
        ctx.fillStyle = ink(.16)
        ctx.lineWidth = 1.3
        rr(ctx, x, y + 8, w, h - 8, 3)
        ctx.fill(); ctx.stroke()
        rr(ctx, x + w * 0.3, y, w * 0.4, 9, 2)
        ctx.fill(); ctx.stroke()
        ctx.restore()
      }

      // 渔网的形变场（u: 0=网格左 → 1=右；v: 0=上 → 1=下；t/phase 走各自节奏）。
      // 网不是一块硬板：被水拖着一路拧、网格线自己在动。三层叠起来：
      //   ① 中间被水顶得向后凹（静态形变，看着才"软"）
      //   ② 上下两端朝相反方向滑 —— 整张网来回拧，这才是"被拖着走"的感觉
      //   ③ 一道波在网格上游走，让每根线自己也在变
      function netDx(u, v, t, ph) {
        var su = Math.sin(Math.PI * u)
        return -1.6 * su * Math.sin(Math.PI * v)
          + 1.2 * Math.sin(t * 1.9 + ph) * (v - 0.5)
          + 0.9 * Math.sin(v * 4.2 + t * 3.4 + ph) * su
      }
      function netDy(u, v, t, ph) {
        return 0.8 * Math.sin(u * 4.6 - t * 2.8 + ph) * Math.sin(Math.PI * v)
      }

      function drawNet(ctx, o, t) {
        var x = o.x, y = o.y, w = o.w, h = o.h
        var ph = o.phase || 0
        // 格子数固定，横竖**共用同一套顶点**，交叉点才不会错开
        var nx = Math.max(2, Math.round(w / 6))
        var ny = Math.max(2, Math.round(h / 6))
        var i, j, u, v, px, py
        function vx(uu, vv) { return x + w * uu + netDx(uu, vv, t, ph) }
        function vy(uu, vv) { return y + h * vv + netDy(uu, vv, t, ph) }
        ctx.save()
        ctx.strokeStyle = ink(.42)
        ctx.lineWidth = 1
        ctx.globalAlpha = 0.8
        for (i = 0; i <= nx; i++) {
          u = i / nx
          ctx.beginPath()
          for (j = 0; j <= ny; j++) {
            v = j / ny
            if (j === 0) ctx.moveTo(vx(u, v), vy(u, v)); else ctx.lineTo(vx(u, v), vy(u, v))
          }
          ctx.stroke()
        }
        for (j = 0; j <= ny; j++) {
          v = j / ny
          ctx.beginPath()
          for (i = 0; i <= nx; i++) {
            u = i / nx
            if (i === 0) ctx.moveTo(vx(u, v), vy(u, v)); else ctx.lineTo(vx(u, v), vy(u, v))
          }
          ctx.stroke()
        }
        // 四条边再描一遍（跟着形变走，不再是直角的 strokeRect）
        ctx.globalAlpha = 1
        ctx.lineWidth = 1.4
        ctx.beginPath()
        for (j = 0; j <= ny; j++) { v = j / ny; px = vx(0, v); py = vy(0, v); if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py) }
        for (i = 1; i <= nx; i++) { u = i / nx; ctx.lineTo(vx(u, 1), vy(u, 1)) }
        for (j = ny - 1; j >= 0; j--) { v = j / ny; ctx.lineTo(vx(1, v), vy(1, v)) }
        for (i = nx - 1; i >= 0; i--) { u = i / nx; ctx.lineTo(vx(u, 0), vy(u, 0)) }
        ctx.closePath()
        ctx.stroke()
        ctx.restore()
      }

      function drawCoral(ctx, o, t) {
        var x = o.x + o.w / 2, base = o.y + o.h
        ctx.save()
        ctx.strokeStyle = ink(.42)
        ctx.lineWidth = 2.2
        ctx.lineCap = 'round'
        var arms = [[-7, -13], [0, -19], [7, -12]]
        for (var i = 0; i < arms.length; i++) {
          ctx.beginPath()
          ctx.moveTo(x, base)
          ctx.quadraticCurveTo(x + arms[i][0] * 0.6, base + arms[i][1] * 0.7, x + arms[i][0], base + arms[i][1] - Math.sin(t * 1.6 + i) * 1.5)
          ctx.stroke()
        }
        ctx.restore()
      }

      function rr(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2)
        ctx.beginPath()
        ctx.moveTo(x + r, y)
        ctx.arcTo(x + w, y, x + w, y + h, r)
        ctx.arcTo(x + w, y + h, x, y + h, r)
        ctx.arcTo(x, y + h, x, y, r)
        ctx.arcTo(x, y, x + w, y, r)
        ctx.closePath()
      }

      return {
        drawWhale: drawWhale,
        rr: rr,
        drawObstacle: function (ctx, o, t) {
          if (o.kind === 'jelly' || o.kind === 'jellyHigh') return drawJelly(ctx, o, t)
          if (o.kind === 'bottle') return drawBottle(ctx, o)
          if (o.kind === 'net') return drawNet(ctx, o, t)
          return drawCoral(ctx, o, t)
        },
      }
    }

    // 水面。基调是**几乎看不见**：不做卡片、不做边框、不上彩色，
    // 只有一条行进中的波浪线 + 一层极淡的渐变，让它读起来像界面的一部分。
    // intro（0~1）是刚出现时的"翻涌"强度，之后收敛到很弱 —— 所以它是涌出来的，不是弹出来的。
    function paintWater(ctx, W, H, gy, theme, t, dist, intro) {
      var deep = theme !== 0
      var k = intro === undefined ? 1 : intro

      // **不在界面上铺任何底色**。铺了就会看出一块"半透明窗口"，
      // 而我们要的是直接在原来的 UI 上跑 —— 所以这里只有水线和线上的东西。
      // 也正因为没有底色，必须自己清屏，否则每帧往上叠会糊成一片白。
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, W, H)

      // 两端淡出的横向渐变 —— 不然水线就是一根被剪断的直线，很突兀
      function edgeFade(alpha) {
        var g2 = ctx.createLinearGradient(0, 0, W, 0)
        g2.addColorStop(0, waterInk(deep, 0))
        g2.addColorStop(0.07, waterInk(deep, alpha))
        g2.addColorStop(0.93, waterInk(deep, alpha))
        g2.addColorStop(1, waterInk(deep, 0))
        return g2
      }

      // 两层错相位的波浪线叠出"翻涌"感
      ctx.save()
      ctx.lineWidth = 1
      for (var layer = 0; layer < 2; layer++) {
        var amp = (1.5 + 3.2 * k) * (layer === 0 ? 1 : 0.62)
        var phase = t * (1.05 + layer * 0.5) + layer * 1.7
        var y0 = gy + layer * 3
        ctx.strokeStyle = edgeFade(layer === 0 ? 0.22 : 0.10)
        ctx.beginPath()
        for (var x = -6; x <= W + 6; x += 6) {
          var y = y0 + Math.sin(x * 0.021 + phase) * amp + Math.sin(x * 0.0068 - phase * 0.6) * amp * 0.5
          if (x <= -6) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      ctx.restore()

      // 线下方一点点碎光随距离滚动 —— 没有它整条跑道像静止的
      ctx.save()
      ctx.fillStyle = edgeFade(0.13)
      var unit = 42
      var off = ((dist || 0) % unit) - unit
      for (var s = 0; s * unit + off < W + unit; s++) {
        var sx = s * unit + off
        var idx = Math.floor(((dist || 0) - off) / unit) + s
        var h1 = Math.abs(Math.sin(idx * 12.9898)) % 1
        ctx.fillRect(sx + h1 * 26, gy + 5, 6 + h1 * 10, 1)
      }
      ctx.restore()
    }

    function paintScene(ctx, eg, art, st, opts) {
      var W = opts.w
      var H = opts.h
      var gy = eg.groundY
      var shallow = st.theme === 0
      var t = opts.t

      paintWater(ctx, W, H, gy, st.theme, t, st.dist, opts.intro)

      // 气泡
      ctx.save()
      ctx.strokeStyle = ink(.16)
      ctx.lineWidth = 1
      for (var b = 0; b < st.bubbles.length; b++) {
        var bu = st.bubbles[b]
        ctx.beginPath()
        ctx.arc(bu.x, bu.y, bu.r, 0, 6.2832)
        ctx.stroke()
      }
      ctx.restore()

      // 障碍
      for (var k = 0; k < st.obstacles.length; k++) art.drawObstacle(ctx, st.obstacles[k], t)

      // 鲸鱼
      var diving = st.diving && st.grounded
      var bx = st.wx + eg.whaleW / 2
      var by = gy - st.y - eg.whaleH / 2
      var rot = 0
      var sx = 1, sy = 1
      if (st.phase === 'running') {
        if (st.grounded) {
          // 已经贴着地面往前冲了，所以常态就给一点前倾，再叠一层摆动的余韵
          var swim = Math.sin(t * 9.4)
          by += swim * 1.5
          rot = 0.055 + swim * 0.045
          sx = 1 + swim * 0.02
          sy = 1 - swim * 0.02
          if (diving) { sx = 1.16; sy = 0.62; rot = 0.02; by = gy - eg.whaleH * 0.31 }
        } else {
          rot = st.vy < 0 ? -0.24 : 0.16
          sy = st.jumpCut ? 0.95 : 1.04
          sx = st.jumpCut ? 1.03 : 0.98
        }
      } else if (st.phase === 'over') {
        // 被打飞之后一路翻着滚（旋转由 stepOver 算，掉出画布那段由覆盖层接手）
        rot = st.rot
      } else {
        by += Math.sin(t * 2.2) * 1.6
        rot = Math.sin(t * 2.2) * 0.03
      }
      // 出了画布就不再由这儿画了 —— 覆盖层那只正好从同一个位置接着往下掉，
      // 两边同时画就会看见两只。
      if (!st.thrown) art.drawWhale(ctx, bx, by, eg.whaleW, { rot: rot, sx: sx, sy: sy })

      // 水花
      ctx.save()
      ctx.fillStyle = ink(.6)
      for (var s = 0; s < st.splashes.length; s++) {
        var sp = st.splashes[s]
        ctx.globalAlpha = Math.max(0, Math.min(1, sp.life * 2))
        ctx.beginPath()
        ctx.arc(sp.x, sp.y, 1.6, 0, 6.2832)
        ctx.fill()
      }
      ctx.restore()

      // 里程碑闪光 —— 只闪一点点，别搞得像故障
      if (st.flash > 0) {
        ctx.save()
        ctx.globalAlpha = st.flash * 0.14
        ctx.fillStyle = THEME.light ? '#000000' : '#ffffff'
        ctx.fillRect(0, 0, W, H)
        ctx.restore()
      }
    }

    // ============================================================ §8 layout

    // 输入区里**除开 hero 那一整块**之外，最靠上的那个可见控件
    //（也就是「选择工作区 / 标准模式」那行）的顶边 —— 跑道的下沿不能越过它。
    // 那行字没有稳定类名（hash），只能按"可见 + 有尺寸 + 不在 hero 块里"筛。
    // ⚠️ 排除的必须是**整个 hero 块**：鲸鱼和那句标题是兄弟节点，
    //    只排除鲸鱼自己会把标题算成"最靠上的控件"，跑道反而被顶到标题上面去。
    // 整个 seat 子树每帧遍历太贵，缓存 ~120ms。
    var ctrlTopCache = null
    var ctrlTopAt = 0

    function composerControlTop(heroBlock) {
      var now = performance.now()
      if (ctrlTopCache !== null && now - ctrlTopAt < 120) return ctrlTopCache
      ctrlTopAt = now
      ctrlTopCache = null
      var seat = document.querySelector(SEL_SEAT)
      if (!seat) return null
      var nodes = seat.querySelectorAll('*')
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i]
        if (heroBlock && (n === heroBlock || n.contains(heroBlock) || heroBlock.contains(n))) continue
        var r = n.getBoundingClientRect()
        if (r.height < 8 || r.width < 8) continue
        var cs = getComputedStyle(n)
        if (cs.visibility === 'hidden' || cs.display === 'none') continue
        if (Number(cs.opacity) < 0.05) continue
        if (ctrlTopCache === null || r.top < ctrlTopCache) ctrlTopCache = r.top
      }
      return ctrlTopCache
    }

    // 返回跑道该对齐的参照：
    //   left / width  取**卡片**（跟输入框同宽才对得齐）；
    //   cardTop       卡片顶边，用来兜底别往下压到「选择工作区 / 标准模式」那行；
    //   seatTop       整个输入区的顶边（有消息、没有 hero 时用它当基准）；
    //   textCenter    欢迎页那句标题的竖直中心 —— 跑道的首选 Y 轴就跟它齐平。
    function measureComposer(heroTexts) {
      var cardEl = document.querySelector(SEL_CARD)
      var seatEl = document.querySelector(SEL_SEAT)
      var cr = cardEl ? cardEl.getBoundingClientRect() : null
      var sr = seatEl ? seatEl.getBoundingClientRect() : null
      var box = (cr && cr.width >= 60 && cr.height >= 20) ? cr : sr
      if (!box || box.width < 60 || box.height < 20) return null
      var center = null
      if (heroTexts && heroTexts.length) {
        var t = heroTexts[0].getBoundingClientRect()
        if (t.height > 4) center = t.top + t.height / 2
      }
      return {
        left: box.left,
        width: box.width,
        cardTop: box.top,
        seatTop: (sr && sr.top < box.top) ? sr.top : box.top,
        textCenter: center,
      }
    }

    // ============================================================ §9 keys

    function regionOf(ev) {
      var path = []
      try { path = ev.composedPath ? ev.composedPath() : [] } catch (e) { path = [] }
      var el = null
      for (var i = 0; i < path.length; i++) {
        if (path[i] instanceof Element) { el = path[i]; break }
      }
      if (!el) el = document.activeElement
      if (!el || !(el instanceof Element)) return 'page'
      if (el.closest('.xterm')) return 'terminal'
      if (el.closest(EDITABLE)) return 'editable'
      return 'page'
    }

    // ============================================================ §10 dom

    function el(tag, cls, attrs) {
      var n = document.createElement(tag)
      if (cls) n.className = cls
      if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k])
      return n
    }

    function buildRoot() {
      var root = el('div', '', { id: 'whale-run-root', 'data-whale-run-root': '' })

      var carry = el('canvas', 'wr-carry')
      carry.width = CARRY_BOX
      carry.height = CARRY_BOX

      var runway = el('div', 'wr-runway', { tabindex: '-1' })
      var inner = el('div', 'wr-inner')
      var canvas = el('canvas', 'wr-canvas')

      var hud = el('div', 'wr-hud')
      var score = el('span', 'wr-score')
      score.textContent = '0'
      var hi = el('span', 'wr-hi')
      hi.textContent = 'HI 0'
      var mute = el('button', 'wr-btn', { type: 'button', title: '音效开/关' })
      mute.textContent = '♪'
      var close = el('button', 'wr-btn', { type: 'button', title: '收起跑道 (Esc)' })
      close.textContent = '×'
      hud.appendChild(score)
      hud.appendChild(hi)
      hud.appendChild(mute)
      hud.appendChild(close)

      var hint = el('div', 'wr-hint')
      hint.textContent = '松手开始 · 空格起跳（空中再按一下二段跳）· ↓ 下潜'

      var over = el('div', 'wr-over')
      var ob = el('b')
      ob.textContent = 'GAME OVER'
      var of = el('em', 'wr-final')      // 这局得了多少分 —— 摆正中的大字
      of.textContent = '0'
      var obest = el('span', 'wr-best')
      obest.textContent = '最高 0'
      var os = el('span')
      os.textContent = '空格 / 点击重来 · Esc 收起'
      over.appendChild(ob)
      over.appendChild(of)
      over.appendChild(obest)
      over.appendChild(os)

      inner.appendChild(canvas)
      inner.appendChild(hud)
      inner.appendChild(hint)
      inner.appendChild(over)
      runway.appendChild(inner)

      // 全屏粒子层：拖尾、碎字溅出的泡、缩回原位时的涟漪，全画在这
      var fx = el('canvas', 'wr-fx')
      // 标题碎掉那一层：逐字克隆，位置/字体从原节点量出来
      var shatter = el('div', 'wr-shatter')

      // 层序就是 z-index 顺序：跑道 < 粒子 < 碎字 < 手上那只
      root.appendChild(runway)
      root.appendChild(fx)
      root.appendChild(shatter)
      root.appendChild(carry)

      return {
        root: root, runway: runway, inner: inner, canvas: canvas,
        fx: fx, shatter: shatter, carry: carry,
        score: score, hi: hi, mute: mute, close: close, hint: hint, over: over,
        final: of, best: obest,
      }
    }

    // ============================================================ §11 apply

    function apply(ctx) {
      if (!document.body) return
      if (typeof ctx.effect !== 'function') {
        log('context has no effect(); refusing to mount')
        return
      }

      console.count('whale-run:apply')

      var ui = buildRoot()
      var ctx2d = ui.canvas.getContext('2d')
      var fx2d = ui.fx.getContext('2d')
      var carry2d = ui.carry.getContext('2d')
      var sound = createSound()
      var art = null
      var engine = null
      var rootHidden = false

      // 手上那只鲸鱼。rx/ry 是「渲染位置」，跟 x/y（鼠标）之间隔着一根弹簧 ——
      // 这个滞后，加上拖尾粒子，就是"动态感"的全部来源。
      var held = {
        active: false, source: null, node: null, prevVis: '',
        // 从侧边栏那只起手时，中间 hero 那只也要一起被带走 —— 两者各存各的原值，
        // 共用一个变量的话后藏的那只会把先藏的原值覆盖掉。
        heroNode: null, heroPrev: '',
        x: 0, y: 0, rx: 0, ry: 0, vx: 0, vy: 0,
        lastX: 0, tilt: 0, size: 44, born: 0,
        trail: [], vfx: [],
        over: false,
        falling: false, fallVy: 0, spin: 0,
        fromGame: false,   // 这次下坠是"撞死了被丢出去"，不是"放到空处"
      }
      var dragging = { on: false, pid: null, source: null, sx: 0, sy: 0, moved: false }
      var running = false
      var rafId = 0
      var lastTs = 0
      var measureTick = 0
      var savedFocus = null
      var seedOverride = null
      var lastSize = null
      var swallow = null
      var runwayIn = 0         // 跑道「翻涌」的起点时间
      var retractTimer = 0     // 撞死之后结算那屏还要留一会儿，这是收跑道的定时器
      var restoreTimer = 0     // 收完跑道再把图标/那行字还回来，这是第二步的定时器
      var diedX = 30           // 撞死时鲸鱼在跑道上的 x —— 再来一局就从那儿掉回来
      var shatterFx = null     // 正在播的碎字动画
      var hiddenNodes = []     // 被我们藏起来的那几个字（「探索未至之境」+「预览版」），鲸鱼回来才还

      var colorRef = { value: '' }
      var fish = null

      function refreshFish() {
        fish = readFish(SEL_HERO) || readFish(SEL_SIDE)
        if (!fish) return false
        getFishPath(fish.d)
        if (fish.color) colorRef.value = fish.color
        if (!art) art = createArt(function () { return getFishPath(fish.d) }, fish.vb, colorRef)
        return true
      }

      // 主题一翻要动三样：CSS 那半边靠 root 上的 data-wr-light（只改两个通道变量），
      // canvas 那半边靠 THEME（art/水线/粒子每帧现读），还有手上那只鲸鱼的颜色 ——
      // 它本来是从 DOM 上读的（getComputedStyle(svg).color），主题变了它自己也变，
      // 不重新读一下就是"界面翻白了、鲸鱼还是白的"。
      var lastLight = null
      function applyTheme() {
        var light = detectLight()
        if (light === lastLight) return
        lastLight = light
        THEME.light = light
        ui.root.toggleAttribute('data-wr-light', light)
        var f = readFish(SEL_HERO) || readFish(SEL_SIDE)
        if (f && f.color) colorRef.value = f.color
        log('theme ' + (light ? 'light' : 'dark'))
      }

      // ---------- 尺寸 ----------

      function layoutRunway() {
        var info = heroTextInfo()
        var box = measureComposer(info.nodes)
        if (!box) { ui.runway.style.display = 'none'; return false }
        ui.runway.style.display = ''
        var vw = window.innerWidth || document.documentElement.clientWidth
        var w = Math.max(220, Math.min(box.width, vw - 24))
        var h = RUNWAY_H
        var top
        if (box.textCenter !== null) {
          // 首选：中心跟欢迎页那句标题齐平 —— 那些字开局就被卷走了，跑道占它那条带正好。
          // 但标题底边到下面那行选择器只有 ~27px，88px 的跑道**不可能**既居中又不压到它，
          // 所以再往下顶一道：下沿最多贴到那行字上面 8px。
          top = box.textCenter - h / 2
          var ctrl = composerControlTop(info.scope)
          if (ctrl !== null && top + h > ctrl - 8) top = ctrl - 8 - h
        } else {
          // 有消息、没有 hero 的会话：贴着输入区上沿
          top = box.seatTop - GAP - h
        }
        if (top < 8) { h = Math.max(RUNWAY_H_MIN, top + h - 8); top = 8 }
        var left = Math.round(box.left + (box.width - w) / 2)
        left = Math.max(8, Math.min(left, vw - w - 8))
        ui.runway.style.width = w + 'px'
        ui.runway.style.height = h + 'px'
        ui.runway.style.transform = 'translate3d(' + left + 'px,' + Math.round(top) + 'px,0)'
        return { w: w, h: h, left: left, top: top }
      }

      function syncCanvas(rect) {
        var dpr = window.devicePixelRatio || 1
        var cw = Math.round(rect.w)
        var ch = Math.round(rect.h)
        if (ui.canvas.width !== cw * dpr || ui.canvas.height !== ch * dpr) {
          ui.canvas.width = cw * dpr
          ui.canvas.height = ch * dpr
          if (engine) engine.resize(cw, ch)
        }
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
        return { w: cw, h: ch }
      }

      // ---------- 引擎 ----------

      function makeEngine(w, h) {
        var rng = seedOverride !== null ? mulberry32(seedOverride) : Math.random
        engine = createEngine({
          w: w, h: h, rng: rng, vb: fish ? fish.vb : null, whaleW: held.size,
          onPoint: function () { sound.point() },
          onLand: function () { sound.land() },
          onGameOver: function (score) {
            sound.hit()
            var prev = loadNum(STORE_BEST, 0)
            var best = score > prev ? score : prev
            if (score > prev) saveNum(STORE_BEST, best)
            ui.hi.textContent = 'HI ' + best
            ui.score.textContent = String(score)
            // 正中那两行：这局多少分、最好成绩（破纪录就直说）
            ui.final.textContent = String(score)
            ui.best.textContent = (score > prev ? '新纪录 · 最高 ' : '最高 ') + best
            ui.runway.classList.add('wr-over-show')
          },
        })
        ui.hi.textContent = 'HI ' + loadNum(STORE_BEST, 0)
      }

      // ---------- 携带 ----------

      function liveSourceNode(source) {
        var host = document.querySelector(source === 'hero' ? SEL_HERO : SEL_SIDE)
        return host ? host.querySelector('svg') : null
      }

      // 藏一个节点，并把它的**原值**返回给调用方自己收着。
      // 原值不再写进 held 上的单一变量：同时藏着两只（侧边栏那只 + 中间那只）时，
      // 后藏的那只会把先藏的原值覆盖掉，先那只还回去就还成了别人记的值。
      // 本来就 hidden 的，原值记成 '' —— 否则连捉两次会把 'hidden' 当成原值存下来，
      // 之后还回去还是 hidden，鲸鱼就永远消失了。
      function hideNode(n) {
        if (!n) return ''
        var cur = n.style.visibility
        n.style.visibility = 'hidden'
        return (cur === 'hidden') ? '' : (cur || '')
      }

      function unhideNode(n, prev) {
        if (!n) return
        try { if (n.isConnected) n.style.visibility = prev || '' } catch (e) { /* 节点没了就算了 */ }
      }

      // 从侧边栏那只起手时，中间 hero 那只也得跟着消失 —— 跑道上跑的就是"那只鲸鱼"，
      // 一边在跑道上跑、一边在欢迎页原地留着另一只，是用户报的那个 bug。
      // 会话页没有 hero（liveSourceNode 返回 null），这里就什么都不做。
      function hideHeroTwin() {
        if (held.source === 'hero') return
        var hero = liveSourceNode('hero')
        if (!hero || hero === held.node) return
        held.heroNode = hero
        held.heroPrev = hideNode(hero)
      }

      // 把"还没还回去的那两只"原样放回界面（不带任何特效），并清掉手上这两只的记账。
      function restoreBrought() {
        unhideNode(held.node, held.prevVis)
        unhideNode(held.heroNode, held.heroPrev)
        held.node = null
        held.heroNode = null
        held.prevVis = ''
        held.heroPrev = ''
      }

      function armSwallow() {
        if (swallow) return
        swallow = function (e) {
          e.stopPropagation()
          e.preventDefault()
          disarmSwallow()
        }
        document.addEventListener('click', swallow, true)
        setTimeout(disarmSwallow, 320)
      }

      function disarmSwallow() {
        if (!swallow) return
        document.removeEventListener('click', swallow, true)
        swallow = null
      }

      function beginDrag(ev, source) {
        dragging.on = true
        dragging.pid = ev.pointerId
        dragging.source = source
        dragging.sx = ev.clientX
        dragging.sy = ev.clientY
        dragging.moved = false
        dragging.target = ev.target
      }

      // ---------- 粒子（画在全屏那层）----------

      function spawnParticle(list, p) {
        if (list.length > 140) list.shift()
        list.push(p)
      }

      function burst(x, y, n, opt) {
        opt = opt || {}
        for (var i = 0; i < n; i++) {
          var a = Math.random() * 6.2832
          var sp = (opt.speed || 90) * (0.35 + Math.random())
          var life = (opt.life || 0.7) * (0.55 + Math.random() * 0.9)
          spawnParticle(held.vfx, {
            x: x + (Math.random() - 0.5) * (opt.spread || 8),
            y: y + (Math.random() - 0.5) * (opt.spread || 8),
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp - (opt.up || 0),
            r: (opt.r || 2) * (0.6 + Math.random()),
            life: life, max: life,
            lift: opt.lift || 0,
            color: opt.color || ink(.42),
            alpha: opt.alpha === undefined ? 0.8 : opt.alpha,
          })
        }
      }

      function stepFx(dt) {
        var lists = [held.vfx, held.trail]
        for (var L = 0; L < lists.length; L++) {
          var list = lists[L]
          for (var i = list.length - 1; i >= 0; i--) {
            var p = list[i]
            p.life -= dt
            if (p.life <= 0) { list.splice(i, 1); continue }
            p.vx *= (1 - Math.min(0.5, 2.2 * dt))
            p.vy *= (1 - Math.min(0.5, 2.2 * dt))
            p.vy -= p.lift * dt
            p.x += p.vx * dt
            p.y += p.vy * dt
          }
        }
      }

      function paintFx() {
        var lists = [held.vfx, held.trail]
        for (var L = 0; L < lists.length; L++) {
          var list = lists[L]
          for (var i = 0; i < list.length; i++) {
            var p = list[i]
            var k = Math.max(0, Math.min(1, p.life / p.max))
            fx2d.globalAlpha = k * p.alpha
            fx2d.fillStyle = p.color
            fx2d.beginPath()
            fx2d.arc(p.x, p.y, Math.max(0.3, p.r * (0.3 + 0.7 * k)), 0, 6.2832)
            fx2d.fill()
          }
        }
        fx2d.globalAlpha = 1
      }

      var trailAcc = 0
      function spawnTrail(dt) {
        var sp = Math.sqrt(held.vx * held.vx + held.vy * held.vy)
        if (sp < 0.7) return
        trailAcc += dt * (5 + sp * 0.5)
        var ang = Math.atan2(held.vy, held.vx)
        var back = held.size * 0.42
        while (trailAcc >= 1) {
          trailAcc -= 1
          var life = 0.4 + Math.random() * 0.5
          spawnParticle(held.trail, {
            x: held.rx - Math.cos(ang) * back + (Math.random() - 0.5) * 9,
            y: held.ry - Math.sin(ang) * back + (Math.random() - 0.5) * 9,
            vx: -held.vx * 0.1 + (Math.random() - 0.5) * 20,
            vy: -held.vy * 0.1 - 14 - Math.random() * 22,
            r: 0.9 + Math.random() * 1.9,
            life: life, max: life,
            lift: 24,
            color: ink(.5),
            alpha: 0.62,
          })
        }
      }

      // ---------- 标题「探索未至之境」粉碎化作波浪 ----------

      // 这一行上**所有**的文字：不只是「探索未至之境」，旁边那个「预览版」小胶囊也要。
      // 同时返回找到它们的那个 scope —— 它就是"hero 整块"，判跑道位置时要把整块排除掉。
      function heroTextInfo() {
        var hero = document.querySelector(SEL_HERO)
        if (!hero) return { nodes: [], scope: null }
        var scope = hero.parentElement
        for (var up = 0; up < 5 && scope && scope !== document.body; up++) {
          var out = []
          var leaves = scope.querySelectorAll('span,div,h1,h2,p,b,small')
          for (var i = 0; i < leaves.length; i++) {
            var n = leaves[i]
            if (n.children.length) continue
            if (n === hero || hero.contains(n)) continue
            var txt = (n.textContent || '').trim()
            if (!txt || txt.length > 24) continue
            var r = n.getBoundingClientRect()
            if (r.width <= 0 && r.height <= 0) continue
            out.push(n)
          }
          if (out.length) return { nodes: out, scope: scope }
          scope = scope.parentElement
        }
        return { nodes: [], scope: null }
      }

      function collectHeroText() { return heroTextInfo().nodes }

      function charRects(node) {
        var out = []
        if (!node.firstChild || node.firstChild.nodeType !== 3) return out
        var text = node.firstChild.nodeValue || ''
        var range = document.createRange()
        for (var i = 0; i < text.length; i++) {
          if (!text.charAt(i).trim()) continue
          try {
            range.setStart(node.firstChild, i)
            range.setEnd(node.firstChild, i + 1)
          } catch (e) { continue }
          var r = range.getBoundingClientRect()
          if (r.width <= 0 && r.height <= 0) continue
          out.push({ ch: text.charAt(i), x: r.left, y: r.top, w: r.width, h: r.height })
        }
        return out
      }

      // 克隆到覆盖层里做动画 —— **原节点一个字节都不改内容**，只临时 visibility:hidden，
      // 避免和 React 的渲染打架。整句拆成逐字飞，带样式的（比如「预览版」那个胶囊）整块克隆着飞。
      // 碎和合**共用同一套 pieces**：`s` 从 0（原位）走到 1（散开），碎是正着走、合是倒着走。
      function buildTextPieces(hideSources) {
        var nodes = collectHeroText()
        if (!nodes.length) return null
        ui.shatter.textContent = ''
        var pieces = []
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i]
          var r = node.getBoundingClientRect()
          if (hideSources) {
            node.style.visibility = 'hidden'
            hiddenNodes.push(node)
          }
          var chars = (node.textContent || '').trim() === HEADLINE ? charRects(node) : []
          if (chars.length) {
            var cs = getComputedStyle(node)
            for (var k = 0; k < chars.length; k++) {
              var c = chars[k]
              var sp = document.createElement('span')
              sp.textContent = c.ch
              sp.style.left = c.x + 'px'
              sp.style.top = c.y + 'px'
              sp.style.fontFamily = cs.fontFamily
              sp.style.fontSize = cs.fontSize
              sp.style.fontWeight = cs.fontWeight
              sp.style.fontStyle = cs.fontStyle
              sp.style.letterSpacing = cs.letterSpacing
              sp.style.color = cs.color
              ui.shatter.appendChild(sp)
              pieces.push({
                el: sp, delay: k * 42, spread: k - (chars.length - 1) / 2, rotDir: k % 2 ? 1 : -1,
                rect: c, waveAmp: 9, unit: false,
              })
            }
          } else {
            // 带边框/底色的整块克隆，类名还在，胶囊的样子丢不掉。
            // ⚠️ 颜色必须从原节点抄过来 —— 克隆挂在我们自己的层里，
            // 继承到的是覆盖层的默认色（黑），不抄就是黑字黑底、等于隐形。
            var cs2 = getComputedStyle(node)
            var cl = node.cloneNode(true)
            cl.style.position = 'absolute'
            cl.style.left = r.left + 'px'
            cl.style.top = r.top + 'px'
            cl.style.margin = '0'
            cl.style.color = cs2.color
            // ⚠️ cloneNode 会把行内 style 一起复制 —— 而原节点在上面刚被我们设成了
            // visibility:hidden，克隆体于是生下来就是隐形的。必须显式掰回来。
            cl.style.visibility = 'visible'
            cl.style.pointerEvents = 'none'
            ui.shatter.appendChild(cl)
            pieces.push({
              el: cl, delay: 60, spread: 0, rotDir: -1,
              rect: { x: r.left, y: r.top, w: r.width, h: r.height }, waveAmp: 6, unit: true,
            })
          }
        }
        return pieces.length ? { pieces: pieces, nodes: nodes } : null
      }

      function startShatter() {
        if (shatterFx) {
          if (shatterFx.dir > 0) return              // 正碎着，别重来
          // 正拼着（鲸鱼回来的那 ~1 秒）又被摘了：先让它收干净再重碎一次。
          // 不处理的话这一局的标题**整局都不碎**（startShatter 被自己挡住，而那次拼字
          // 演完还会把字还回来）。
          finishReassemble()
        }
        if (hiddenNodes.length) restoreHeadline()   // 上一轮没还回去的先还掉
        var built = buildTextPieces(true)
        if (!built) { restoreHeadline(); return }
        shatterFx = { pieces: built.pieces, t0: performance.now(), dir: 1 }
      }

      // 鲸鱼回来时把那些字**从波浪里重新拼回来**（不是淡入 —— 那太生硬）。
      function startReassemble() {
        if (!hiddenNodes.length) return
        if (shatterFx) {
          if (shatterFx.dir > 0) endShatter()   // 正碎着就先收掉（字仍然藏着）
          else return
        }
        var built = buildTextPieces(false)      // 原节点还藏着，layout 还在，量得到
        if (!built) { restoreHeadline(); return }
        for (var k = 0; k < built.pieces.length; k++) {
          var c = built.pieces[k].rect
          burst(c.x + c.w / 2, c.y + c.h / 2, 1, {
            speed: 18, up: 34, r: 1.4, life: 0.8, lift: 28, color: ink(.28), alpha: 0.6,
          })
        }
        shatterFx = { pieces: built.pieces, t0: performance.now(), dir: -1 }
        // ⚠️ 必须**立刻**把它们摆成"散开"的样子再上屏。
        // 这条路径（丢下去变回图标）是从渲染循环**内部**调的，而那一帧的
        // stepShatter 已经跑过了 —— 不预摆的话，克隆会以"完整的字样"先闪一帧。
        paintShatter(0)
        startLoop()   // 拼字动画要靠主循环推进，别指望调用方已经开着
      }

      // 把当前进度画到每个碎片上。返回已经演完的碎片数。
      function paintShatter(age) {
        var fx = shatterFx
        if (!fx) return 0
        var done = 0
        for (var i = 0; i < fx.pieces.length; i++) {
          var pc = fx.pieces[i]
          var p = (age - pc.delay) / 640
          if (p < 0) p = 0
          if (p >= 1) done++
          var e = fx.dir > 0 ? p : 1 - p     // 0 = 原位，1 = 散得最开
          var s = e * e
          var wave = Math.sin(i * 0.62 - age * 0.0072) * pc.waveAmp * (0.35 + s)
          var dx = pc.spread * 0.55 * s
          var dy = s * 24 + Math.sin(e * Math.PI) * wave * 0.7
          var rot = s * pc.rotDir * (pc.unit ? 5 : 9)
          var st = pc.el.style
          st.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) rotate(' + rot.toFixed(1) + 'deg) scale(' + (1 - (pc.unit ? 0.12 : 0.22) * s).toFixed(3) + ')'
          st.opacity = String(Math.max(0, 1 - s * 1.15))
          st.filter = 'blur(' + (s * 4.5).toFixed(2) + 'px)'
        }
        return done
      }

      function stepShatter(now) {
        if (!shatterFx) return
        var fx = shatterFx
        if (paintShatter(now - fx.t0) === fx.pieces.length) {
          if (fx.dir > 0) endShatter()
          else finishReassemble()
        }
      }

      // 碎完了就收摊 —— **那些字仍然藏着**，等鲸鱼回来再拼。
      function endShatter() {
        var fx = shatterFx
        if (!fx) return
        for (var k = 0; k < fx.pieces.length; k++) {
          var c = fx.pieces[k].rect
          burst(c.x + c.w / 2, c.y + c.h / 2, 1, {
            speed: 26, up: 46, r: 1.5, life: 0.9, lift: 34, color: ink(.30), alpha: 0.7,
          })
        }
        ui.shatter.textContent = ''
        shatterFx = null
      }

      // 拼回去了：克隆正好落在原位，把克隆撤掉、原节点显出来，接得上
      function finishReassemble() {
        ui.shatter.textContent = ''
        shatterFx = null
        restoreHeadline()
      }

      // 把藏起来的那几个字直接还原（不走特效）—— 只给"被拆掉"这种来不及演的场合用。
      function restoreHeadline() {
        var list = hiddenNodes
        hiddenNodes = []
        for (var i = 0; i < list.length; i++) {
          try { if (list[i].isConnected) list[i].style.visibility = '' } catch (e) { /* 节点没了 */ }
        }
      }

      // ---------- 携带 ----------

      function startCarry() {
        if (held.active) return
        // 一局正在跑 / 那只正被打飞出去的时候不许再摘 —— 那会儿去摘另一只，
        // 引擎手里那只和手上这只就串了（游戏还在跑、鲸鱼却跟着鼠标走）。
        if (running || held.falling) return
        var node = liveSourceNode(dragging.source)
        // 上一只还没还回去（正下坠 / 结算留置中）就去抓了另一只 —— 那只不能就这么被顶掉，
        // 否则它会永远留在 visibility:hidden，用户再也摘不到。
        if (held.node && held.node !== node) restoreBrought()
        held.active = true
        held.source = dragging.source
        held.node = node
        held.prevVis = hideNode(node)
        hideHeroTwin()
        held.x = dragging.sx
        held.y = dragging.sy
        held.rx = dragging.sx
        held.ry = dragging.sy
        held.vx = 0
        held.vy = 0
        held.lastX = dragging.sx
        held.tilt = 0
        held.falling = false
        held.spin = 0
        held.fromGame = false
        held.trail.length = 0
        held.born = performance.now()
        // 拖起来的那只按**原位那只的实际尺寸**画，1:1 ——
        // 原来写死 66px 再乘 1.06，跟 hero 那只（84px 量级）和小号的那只（24px）都对不上。
        var r = node ? node.getBoundingClientRect() : null
        held.size = (r && r.width > 8) ? r.width : 56
        ui.carry.classList.add('wr-live')
        ui.runway.classList.add('wr-shown')
        // 结算那一屏还挂着收跑道的定时器时又被摘了一次，得先撤掉它
        cancelRetract()
        ui.runway.classList.remove('wr-over-show')
        runwayIn = held.born
        if (held.source === 'sidebar') armSwallow()
        burst(held.rx, held.ry, 9, { speed: 70, r: 1.8, life: 0.6, lift: 26, color: ink(.45) })
        startShatter()
        startLoop()
      }

      function endCarry(x, y) {
        if (!held.active) return
        if (typeof x === 'number') { held.x = x; held.y = y }
        var accept = held.over
        ui.runway.classList.remove('wr-armed')
        held.active = false
        if (accept) {
          ui.carry.classList.remove('wr-live')
          drop()
        } else {
          // 放到空处：不硬飞回去，让它掉下去，碰到边框再消失
          held.falling = true
          held.fallVy = Math.max(160, held.vy * 0.6)
          held.over = false
          retractRunway()
          startLoop()
        }
      }

      function retractRunway() {
        ui.runway.classList.remove('wr-shown', 'wr-armed', 'wr-playing', 'wr-over-show')
        running = false
      }

      function drop() {
        var rect = layoutRunway()
        // 量不到输入区（理论上极少见）就别把这只鲸鱼和那行字吞了 —— 原样还回界面。
        if (!rect) { retractRunway(); restoreWhale(); return }
        var size = syncCanvas(rect)
        lastSize = size
        makeEngine(size.w, size.h)
        // 把「手上那只」的当前位置换算成跑道局部坐标，**原样交给引擎接着画** ——
        // 之后由引擎负责：从这儿自由落体 → 落水 → 在跑道上弹一下 → 再游到起点。
        // 所以这里不能让它"闪现"到跑道正中，位置必须对得上。
        var fromX = held.rx - rect.left - engine.whaleW / 2
        var whaleBottom = held.ry + engine.whaleH / 2
        var fromY = engine.groundY - (whaleBottom - rect.top)
        engine.start(fromX, Math.max(0, fromY))
        // 引擎用的尺寸是夹过的（34~72），手上那只可能是原位的 24 —— 对齐一下，
        // 覆盖层淡出的那 .18s 里两只才是同一条鲸鱼，不会一大一小。
        held.size = engine.whaleW
        ui.carry.classList.remove('wr-live')
        running = true
        ui.runway.classList.remove('wr-over-show')
        ui.runway.classList.add('wr-playing')
        sound.jump()
        savedFocus = document.activeElement
        try { ui.runway.focus({ preventScroll: true }) } catch (e) { try { ui.runway.focus() } catch (e2) {} }
        startLoop()
      }

      function cancelRetract() {
        if (retractTimer) { clearTimeout(retractTimer); retractTimer = 0 }
        if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = 0 }
      }

      // 撞死之后不许原地躺下 —— 引擎把鲸鱼打飞出画布底边时把接力棒交到这里：
      // 位置、旋转、速度全部 1:1 接过（画布和覆盖层用的是同一个 art、同一个尺寸），
      // 所以是"接着往下掉"，不是"换了一只从天上冒出来"。
      function throwWhaleOut(rect) {
        var s = engine.st
        s.thrown = true
        diedX = s.wx
        held.active = false
        held.over = false
        held.falling = true
        held.fromGame = true
        held.rx = rect.left + s.wx + engine.whaleW / 2
        // ⚠️ 减半个鲸鱼高：`held.ry` 是**中心**（drawCarry 居中画、stepFalling 的边界也是按中心算），
        //    而画布那边画的是 `groundY - y - whaleH/2`。少了这一下，接力那一帧会往下跳 12px。
        held.ry = rect.top + (engine.groundY - s.y) - engine.whaleH / 2
        held.vx = s.kvx
        held.fallVy = Math.max(0, s.vy)     // 屏幕坐标里正数=往下
        held.tilt = s.rot
        held.spin = 6.4                     // 掉下去这一路继续翻
        // 尺寸以**引擎实际用的那个**为准（跑道上那只被夹在 34~72，侧边栏那只只有 24），
        // 不然半空里会缩一圈。
        held.size = engine.whaleW
        // 交棒这一帧必须是实心的：`.wr-carry` 有个 .18s 的淡入过渡，画布那边已经不画鲸鱼了，
        // 再淡一下就是"两只都不是"的那一小段空档。
        ui.carry.style.transition = 'none'
        ui.carry.classList.add('wr-live')
        requestAnimationFrame(function () { ui.carry.style.transition = '' })
        running = false
        startLoop()
      }

      // 还回来的那只别硬生生地冒出来：淡入 + 一圈小泡
      function fadeIn(node) {
        if (!node || !node.isConnected) return
        var r = node.getBoundingClientRect()
        burst(r.left + r.width / 2, r.top + r.height / 2, 16,
          { speed: 66, r: 2.2, life: 0.8, color: ink(.5) })
        node.style.opacity = '0'
        node.style.transition = 'opacity .45s ease-out'
        requestAnimationFrame(function () { node.style.opacity = '1' })
        setTimeout(function () {
          try { node.style.transition = ''; node.style.opacity = '' } catch (e) { /* 节点没了 */ }
        }, 620)
      }

      // 把原位那只鲸鱼还回去（带一下淡入和泡），那行被卷走的字也跟着**从波浪里拼回来**。
      // 从侧边栏起手时被一起带走的中间那只也在这会儿回来 —— 它跟那行字本来就是同一块里的。
      function restoreWhale() {
        var node = held.node
        var twin = held.heroNode
        var prev = held.prevVis
        var twinPrev = held.heroPrev
        held.node = null
        held.heroNode = null
        held.prevVis = ''
        held.heroPrev = ''
        unhideNode(node, prev)
        unhideNode(twin, twinPrev)
        startReassemble()
        // 界面回来了，焦点也该还回去了（游戏期间它被我们抢到跑道上）
        restoreFocus()
        fadeIn(node)
        fadeIn(twin)
      }

      // 掉出下边框 → 化作水花 → 变回原来那只图标
      function vanishToIcon() {
        held.falling = false
        held.spin = 0
        ui.carry.classList.remove('wr-live')
        burst(held.rx, window.innerHeight - 6, 14, {
          speed: 90, up: 120, r: 2, life: 0.7, lift: 26, color: ink(.42),
        })
        if (held.fromGame) {
          // 撞死这条路：跑道还亮着结算那屏（分数得让人看清），**先别急着把图标和字还回来**
          // —— 跑道就摆在它们那条 Y 轴上，早一步回来就是鲸鱼、标题、水线叠成一团。
          // 等结算收走的那一刻再一起回来，正好是"水面退去、界面回来"。
          held.fromGame = false
          cancelRetract()
          retractTimer = setTimeout(function () {
            retractTimer = 0
            retractRunway()
            // 水面先退，图标和字再回来 —— 错开一拍，别让两件事糊在一起
            restoreTimer = setTimeout(function () { restoreTimer = 0; restoreWhale() }, 240)
          }, 820)
          return
        }
        restoreWhale()
      }

      function quit() {
        cancelRetract()
        if (!held.active && !held.falling && !running) {
          retractRunway(); endShatter()
          // 撞死那条路上图标可能还押着没还（在等结算收走），别把它落下
          if (held.node) restoreWhale()
          else startReassemble()
          return
        }
        held.active = false
        held.falling = false
        held.spin = 0
        held.fromGame = false
        running = false
        ui.carry.classList.remove('wr-live')
        ui.runway.classList.remove('wr-shown', 'wr-armed', 'wr-over-show', 'wr-playing')
        endShatter()
        startReassemble()
        restoreBrought()
        held.over = false
        // 这里**不能**直接 stopLoop()：标题可能正在拼回来，得让循环把它演完。
        // 真没活干了，tick 末尾那条空闲判断会自己停。
        restoreFocus()
      }

      function restoreFocus() {
        var f = savedFocus
        savedFocus = null
        var a = document.activeElement
        var stuck = !!(a && a.closest && a.closest('#whale-run-root'))
        if (f && f.isConnected) {
          try {
            if (f.matches && f.matches(EDITABLE)) { f.focus({ preventScroll: true }); return }
          } catch (e) { /* 输入框自己会处理 */ }
        }
        // 焦点还留在我们这层上（跑道上）必须摘掉 —— 不然界面回来了、用户敲字却没人接。
        if (!stuck) return
        var inp = document.querySelector(SEL_INPUT)
        try {
          if (inp) inp.focus({ preventScroll: true })
          else if (a && a.blur) a.blur()
        } catch (e) { /* ignore */ }
      }

      // ---------- 循环 ----------

      function startLoop() {
        if (rafId) return
        lastTs = 0
        rafId = requestAnimationFrame(tick)
      }

      function stopLoop() {
        if (!rafId) return
        cancelAnimationFrame(rafId)
        rafId = 0
      }

      // ---------- 主循环 ----------

      function syncFx() {
        var dpr = window.devicePixelRatio || 1
        var w = window.innerWidth || document.documentElement.clientWidth
        var h = window.innerHeight || document.documentElement.clientHeight
        if (ui.fx.width !== Math.round(w * dpr) || ui.fx.height !== Math.round(h * dpr)) {
          ui.fx.width = Math.round(w * dpr)
          ui.fx.height = Math.round(h * dpr)
          ui.fx.style.width = w + 'px'
          ui.fx.style.height = h + 'px'
        }
        fx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
        fx2d.clearRect(0, 0, w, h)
      }

      // 弹簧跟随：omega 决定"跟得多紧"，zeta<1 给一点点过冲 —— 这点过冲就是手感。
      var springAcc = 0
      function stepCarrySpring(dt) {
        springAcc += dt
        var h = 1 / 120
        var guard = 0
        var omega = 20, zeta = 0.62
        while (springAcc >= h && guard++ < 24) {
          springAcc -= h
          var ax = omega * omega * (held.x - held.rx) - 2 * zeta * omega * held.vx
          var ay = omega * omega * (held.y - held.ry) - 2 * zeta * omega * held.vy
          held.vx += ax * h
          held.vy += ay * h
          held.rx += held.vx * h
          held.ry += held.vy * h
        }
        // 滞后别夸张到脱手
        var ddx = held.rx - held.x
        var ddy = held.ry - held.y
        var d = Math.sqrt(ddx * ddx + ddy * ddy)
        if (d > 120) {
          var s = 120 / d
          held.rx = held.x + ddx * s
          held.ry = held.y + ddy * s
          held.vx *= 0.5
          held.vy *= 0.5
        }
        var tgt = Math.max(-0.5, Math.min(0.5, held.vx * 0.00035 + held.vy * 0.00022))
        held.tilt += (tgt - held.tilt) * 0.22
      }

      function stepFalling(dt) {
        held.fallVy += 2400 * dt
        held.ry += held.fallVy * dt
        held.rx += held.vx * dt
        held.vx *= (1 - Math.min(0.4, 1.2 * dt))
        // 被丢出去的那只是一路翻着滚的，放到空处那只只是歪着往下掉
        if (held.spin) held.tilt += held.spin * dt
        else held.tilt += (0.55 - held.tilt) * Math.min(1, 4 * dt)
        // 碰到下边框就算"到头了"
        if (held.ry - held.size * 0.5 > (window.innerHeight || 800)) vanishToIcon()
      }

      function tick(ts) {
        rafId = requestAnimationFrame(tick)
        var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0
        lastTs = ts

        // 被藏起来的那两只可能被 React 换掉，逐帧比对身份
        if (held.active || held.falling || running) {
          var live = liveSourceNode(held.source || 'hero')
          if (live !== held.node) {
            unhideNode(held.node, held.prevVis)
            held.node = live
            held.prevVis = live ? hideNode(live) : ''
          }
          // 从侧边栏起手时被一起带走的中间那只也是 React 管的，同样得盯
          if (held.source !== 'hero') {
            var twin = liveSourceNode('hero')
            if (twin !== held.heroNode) {
              unhideNode(held.heroNode, held.heroPrev)
              held.heroNode = twin
              held.heroPrev = twin ? hideNode(twin) : ''
            }
          }
        }

        // 弹层避让 + 主题跟随（约 10Hz，比任何 observer 都省事：
        // 用户随时可能在设置里切浅/深，切完这一帧就得跟着换）
        measureTick++
        if (measureTick % 6 === 0) {
          applyTheme()
          var modal = !!document.querySelector(MODAL)
          if (modal !== rootHidden) {
            rootHidden = modal
            ui.root.hidden = modal
          }
        }

        if (!ui.root.hidden) {
          syncFx()
          stepFx(dt)
          stepShatter(ts)
          if (held.active) {
            stepCarrySpring(dt)
            spawnTrail(dt)
          } else if (held.falling) {
            stepFalling(dt)
          }
          paintFx()

          var rect = layoutRunway()
          var size = rect ? syncCanvas(rect) : null
          if (size) {
            var intro = Math.max(0, Math.exp(-(ts - runwayIn) / 900))
            var geom = { w: size.w, h: size.h, t: ts / 1000, intro: intro }
            // 结算期间（running 已经落了）场景要冻在那儿 —— 不能切回"空水面"，
            // 不然障碍物和 GAME OVER 那屏会一起消失。
            if (engine && !held.active && (running || engine.st.phase === 'over')) {
              if (running && document.visibilityState !== 'hidden') engine.step(dt)
              ui.score.textContent = String(engine.st.score)
              // 引擎说"掉出画布了"，就把鲸鱼交给覆盖层接着往下掉
              if (engine.st.out && !engine.st.thrown && rect) throwWhaleOut(rect)
              paintScene(ctx2d, engine, art, engine.st, geom)
            } else if (engine && !held.active && !held.falling) {
              // 注意也排除了 held.active：再摘一次的时候若还画着上一局冻住的场景，
              // 用户拖着鲸鱼就会看见上局的障碍物和 GAME OVER 停在原地。
              paintScene(ctx2d, engine, art, engine.st, geom)
            } else {
              paintEmpty(ctx2d, size, ts / 1000, intro)
            }
          }
          if (held.active || held.falling) drawCarry(ts)
        }

        // 手头没事、粒子也飞完了，才停循环
        if (!held.active && !held.falling && !running && !held.vfx.length && !held.trail.length && !shatterFx) {
          stopLoop()
        }
      }

      var emptyDist = 0
      function paintEmpty(ctx, size, t, intro) {
        ctx.clearRect(0, 0, size.w, size.h)
        // 没开局的时候也是同一片水面，别突然变成一块板
        paintWater(ctx, size.w, size.h, size.h - FLOOR_H, 0, t, emptyDist, intro)
        ctx.save()
        ctx.globalAlpha = 0.13
        ctx.strokeStyle = THEME.light ? '#000000' : '#ffffff'
        ctx.lineWidth = 1
        for (var i = 0; i < 5; i++) {
          var bx = ((i * 173 + t * 16) % (size.w + 60)) - 30
          var byy = (size.h - FLOOR_H) * (0.22 + (i * 0.17) % 0.6)
          ctx.beginPath()
          ctx.arc(bx, byy, 1.2 + (i % 3) * 0.8, 0, 6.2832)
          ctx.stroke()
        }
        ctx.restore()
      }

      function drawCarry(ts) {
        if (!carry2d || !art || !fish) return
        var box = CARRY_BOX
        carry2d.clearRect(0, 0, box, box)
        var age = ts - held.born
        // 抓起来那一下给个回弹，别硬生生地冒出来
        var pop = 1 + 0.18 * Math.exp(-age / 140)
        var sp = Math.sqrt(held.vx * held.vx + held.vy * held.vy)
        var stretch = Math.min(0.16, sp * 0.00011)
        var bob = held.falling ? 0 : Math.sin(ts / 300) * 1.6
        art.drawWhale(carry2d, box / 2, box / 2 + bob, held.size, {
          rot: held.tilt,
          sx: pop * (1 + stretch),
          sy: pop * (1 - stretch * 0.8),
        })
        ui.carry.style.transform = 'translate3d(' + (held.rx - box / 2) + 'px,' + (held.ry - box / 2) + 'px,0)'
      }

      // ---------- 指针 ----------

      function onPointerDown(ev) {
        if (ev.button !== 0) return
        var t = ev.target
        if (!(t instanceof Element)) return
        if (t.closest('#whale-run-root')) return
        var source = null
        if (t.closest(SEL_HERO)) source = 'hero'
        else if (t.closest(SEL_SIDE)) source = 'sidebar'
        if (!source) return
        refreshFish()
        if (!fish) return
        dragging.source = source
        beginDrag(ev, source)
        try { ev.preventDefault() } catch (e) { /* 某些合成事件不可取消 */ }
      }

      // 松手时算不算"放进跑道"。留一点外扩，别让手感太苛刻。
      function overRunway(x, y) {
        if (!ui.runway.classList.contains('wr-shown')) return false
        var r = ui.runway.getBoundingClientRect()
        var pad = 16
        return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
      }

      function onPointerMove(ev) {
        if (!dragging.on || ev.pointerId !== dragging.pid) return
        var dx = ev.clientX - dragging.sx
        var dy = ev.clientY - dragging.sy
        if (!dragging.moved) {
          if (dx * dx + dy * dy < DRAG_SLOP * DRAG_SLOP) return
          dragging.moved = true
          startCarry()
        }
        if (!held.active) return
        held.x = ev.clientX
        held.y = ev.clientY
        held.over = overRunway(ev.clientX, ev.clientY)
        ui.runway.classList.toggle('wr-armed', held.over)
      }

      function onPointerUp(ev) {
        if (!dragging.on || (ev.pointerId !== undefined && ev.pointerId !== dragging.pid)) return
        var moved = dragging.moved
        var x = ev.clientX, y = ev.clientY
        dragging.on = false
        dragging.moved = false
        dragging.pid = null
        if (!moved) return
        if (held.active) {
          held.x = x; held.y = y
          held.over = overRunway(x, y)
          endCarry(x, y)
        }
      }

      function onPointerCancel() {
        if (!dragging.on) return
        dragging.on = false
        dragging.moved = false
        if (held.active) {
          // 被系统打断（右键/失焦之类）时 `held.over` 还是最后一次 move 的旧值 ——
          // 按**眼睛看见的位置**重算一次，别拿旧值决定这一下算不算落在跑道上
          held.over = overRunway(held.rx, held.ry)
          endCarry(-1, -1)
        }
      }

      // ---------- 键盘 ----------

      function onKeyDown(ev) {
        if (ev.defaultPrevented) return
        // 撞死之后鲸鱼已经飞出去了（running 落了），但这段时间里空格还得能再来一局。
        // 窗口到"结算收走"为止：收干净之后界面已经回到原样，再按空格就不该凭空开一局了。
        var over = !!(engine && engine.st.phase === 'over' && !held.active &&
          (running || held.falling || retractTimer))
        if (!running && !held.active && !over) return
        if (ev.key === 'Escape' || ev.key === 'Esc') {
          ev.preventDefault()
          ev.stopPropagation()
          quit()
          return
        }
        if (regionOf(ev) !== 'page') return
        if (!running && over) {
          var kr = ev.key
          if (kr === ' ' || kr === 'Spacebar' || ev.code === 'Space' || kr === 'Enter') {
            ev.preventDefault()
            restart()
          }
          return
        }
        if (!running || !engine) return
        var k = ev.key
        if (k === ' ' || k === 'Spacebar' || ev.code === 'Space' || k === 'ArrowUp' || k === 'w' || k === 'W') {
          ev.preventDefault()
          if (engine.st.phase === 'over') {
            restart()
          } else if (!ev.repeat) {
            if (engine.jump()) sound.jump()
          }
          return
        }
        if (k === 'ArrowDown' || k === 's' || k === 'S') {
          ev.preventDefault()
          engine.setDive(true)
          return
        }
        if (k === 'Enter' && engine.st.phase === 'over') {
          ev.preventDefault()
          restart()
        }
      }

      function onKeyUp(ev) {
        if (!running || !engine) return
        var k = ev.key
        if (k === ' ' || k === 'Spacebar' || ev.code === 'Space' || k === 'ArrowUp' || k === 'w' || k === 'W') {
          if (regionOf(ev) === 'page') engine.releaseJump()
          return
        }
        if (k === 'ArrowDown' || k === 's' || k === 'S') {
          if (regionOf(ev) === 'page') engine.setDive(false)
        }
      }

      function restart() {
        if (!engine) return
        // 撞死之后那只已经飞出去、图标也回来了 —— 再来一局得把这一摊先收干净：
        // 下坠取消、待收跑道的定时器撤掉、图标重新藏起来（它又"被带走"了）。
        cancelRetract()
        held.falling = false
        held.spin = 0
        held.fromGame = false
        ui.carry.classList.remove('wr-live')
        ui.runway.classList.remove('wr-over-show')
        ui.runway.classList.add('wr-shown', 'wr-playing')
        if (!held.active && !held.node) {
          var n = liveSourceNode(held.source || 'hero')
          if (n) { held.node = n; held.prevVis = hideNode(n) }
        }
        hideHeroTwin()
        // 重建引擎：这样 setSeed 之后重开一局才会真的用上新种子
        if (lastSize) makeEngine(lastSize.w, lastSize.h)
        // 还是"掉进来"：从它刚才撞死的那一带上方落回跑道，别凭空出现在起点
        var fx = Math.max(0, Math.min((lastSize ? lastSize.w : 400) - engine.whaleW, diedX))
        engine.start(fx, lastSize ? lastSize.h : RUNWAY_H)
        if (held.node) startShatter()   // 鲸鱼又离开了，那行字跟着再碎一次（拼字中途会被 startShatter 自己收干净）
        running = true
        ui.score.textContent = '0'
        // 这一局的焦点等收场时要还给谁：上一次可能已经还给输入框了，
        // 也可能还停在跑道上（那是我们自己的节点，不能当"用户原来的焦点"用）。
        if (!savedFocus || !savedFocus.isConnected ||
            (savedFocus.closest && savedFocus.closest('#whale-run-root'))) {
          savedFocus = document.querySelector(SEL_INPUT)
        }
        // ⚠️ 必须自己把循环拉起来：撞死那条路走完之后循环会彻底停下（running/fx 全部收干），
        // 这会儿再开一局，没人去 push 引擎 —— 之前 running 一直挂着才没暴露这个问题。
        startLoop()
        try { ui.runway.focus({ preventScroll: true }) } catch (e) { /* ignore */ }
      }

      // ---------- 组装 ----------

      ctx.effect(function () {
        document.body.appendChild(ui.root)
        ensureStyle()
        applyTheme()
        return function () {
          stopLoop()
          disarmSwallow()
          cancelRetract()
          // 拆插件的时候可能正藏着两只东西：原位那只鲸鱼、还有那句标题 —— 都得还回去
          endShatter()
          restoreHeadline()
          restoreBrought()
          held.active = false
          held.falling = false
          running = false
          held.trail.length = 0
          held.vfx.length = 0
          sound.close()
          try { ui.root.remove() } catch (e) { /* ignore */ }
        }
      }, 'whale-run:overlay')

      ctx.effect(function () {
        window.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('pointermove', onPointerMove, true)
        window.addEventListener('pointerup', onPointerUp, true)
        window.addEventListener('pointercancel', onPointerCancel, true)
        window.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('keyup', onKeyUp, true)
        window.addEventListener('blur', onBlur, true)
        document.addEventListener('visibilitychange', onVisibility, true)
        ui.close.addEventListener('click', function (e) { e.stopPropagation(); quit() })
        ui.mute.addEventListener('click', function (e) {
          e.stopPropagation()
          var m = sound.toggle()
          ui.mute.style.opacity = m ? '0.4' : '1'
        })
        ui.runway.addEventListener('pointerdown', function (e) {
          if (e.target === ui.canvas) {
            e.preventDefault()
            if (engine && engine.st.phase === 'over') restart()
            else if (engine && running) { if (engine.jump()) sound.jump() }
          }
        })
        // dsh 切主题就是把 body 上的 token 整块换掉（深色那条就是 data-ds-dark-theme 属性），
        // 所以盯 body 的属性就够。渲染循环闲着的时候（跑道收着）它照样能让颜色跟上。
        var themeObs = new MutationObserver(function () { applyTheme() })
        themeObs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
        // token 也有可能被写在 <html> 上（dsh 是把主题快照"投影到 document"），一并盯着
        themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme'] })
        var mq = window.matchMedia('(prefers-color-scheme: dark)')
        var onMq = function () { applyTheme() }
        if (mq.addEventListener) mq.addEventListener('change', onMq)
        else if (mq.addListener) mq.addListener(onMq)
        refreshFish()
        if (!fish) log('no whale found on this screen; drag source inactive')
        return function () {
          themeObs.disconnect()
          if (mq.removeEventListener) mq.removeEventListener('change', onMq)
          else if (mq.removeListener) mq.removeListener(onMq)
          window.removeEventListener('pointerdown', onPointerDown, true)
          window.removeEventListener('pointermove', onPointerMove, true)
          window.removeEventListener('pointerup', onPointerUp, true)
          window.removeEventListener('pointercancel', onPointerCancel, true)
          window.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('keyup', onKeyUp, true)
          window.removeEventListener('blur', onBlur, true)
          document.removeEventListener('visibilitychange', onVisibility, true)
          stopLoop()
        }
      }, 'whale-run:listeners')

      function onBlur() { lastTs = 0 }
      function onVisibility() {
        lastTs = 0
        if (document.visibilityState === 'hidden' && running) { /* tick 里会跳过步进 */ }
      }

      // 调试口（离线 harness 与真机验收都靠它）
      var api = {
        get state() { return engine ? engine.st.phase : null },
        get running() { return running },
        get carrying() { return held.active },
        get falling() { return held.falling },
        get carryingSize() { return held.size },
        get carryingY() { return held.ry },
        get carryingX() { return held.rx },
        get carryingTilt() { return held.tilt },
        get carryingLag() { return Math.round(Math.sqrt((held.rx - held.x) * (held.rx - held.x) + (held.ry - held.y) * (held.ry - held.y))) },
        get trailCount() { return held.trail.length },
        get vfxCount() { return held.vfx.length },
        get shattering() { return !!shatterFx },
        get shatterDir() { return shatterFx ? shatterFx.dir : 0 },
        get hiddenTexts() { return hiddenNodes.length },
        get whaleY() { return engine ? Math.round(engine.st.y) : null },
        get whaleAirborne() { return engine ? !engine.st.grounded : null },
        get whaleX() { return engine ? engine.st.wx : null },
        get whaleRot() { return engine ? engine.st.rot : 0 },
        get thrown() { return engine ? !!engine.st.thrown : false },
        get retractPending() { return !!retractTimer },
        get entering() { return engine ? engine.st.entering : null },
        get score() { return engine ? engine.st.score : 0 },
        get best() { return loadNum(STORE_BEST, 0) },
        get engine() { return engine },
        /** 当前主题判定 + root 上的那个属性，两边必须一致（不一致就是"白字白底"） */
        get theme() { return { light: THEME.light, attr: ui.root.hasAttribute('data-wr-light') } },
        get inkColor() { return ink(1) },
        detectTheme: function () { return detectLight() },
        headline: function () {
          var ns = collectHeroText()
          if (!ns.length) return null
          return { text: ns[0].textContent.trim(), hidden: ns[0].style.visibility === 'hidden', count: ns.length }
        },
        heroTexts: function () {
          return collectHeroText().map(function (n) {
            return { text: n.textContent.trim(), hidden: n.style.visibility === 'hidden' }
          })
        },
        quit: quit,
        restart: restart,
        dropNow: function () {
          if (!held.active) return false
          held.over = true
          endCarry(held.x, held.y)
          return true
        },
        /** 松手（按当前位置决定收下还是飞回去），等价于真的 pointerup */
        release: function () {
          if (!held.active) return false
          endCarry(held.x, held.y)
          return true
        },
        grab: function (source) {
          var src = source || (document.querySelector(SEL_HERO) ? 'hero' : 'sidebar')
          var host = document.querySelector(src === 'hero' ? SEL_HERO : SEL_SIDE)
          if (!host) return false
          var r = host.getBoundingClientRect()
          dragging.source = src
          dragging.on = true
          dragging.pid = -1
          dragging.moved = true
          dragging.sx = r.left + r.width / 2
          dragging.sy = r.top + r.height / 2
          refreshFish()
          startCarry()
          return true
        },
        moveTo: function (x, y) {
          if (!held.active) return false
          held.x = x; held.y = y
          var r = ui.runway.getBoundingClientRect()
          held.over = x >= r.left - 18 && x <= r.right + 18 && y >= r.top - 18 && y <= r.bottom + 18
          ui.runway.classList.toggle('wr-armed', !!held.over)
          return true
        },
        setSeed: function (n) { seedOverride = n === null || n === undefined ? null : (n >>> 0) },
        key: function (name, down) {
          var fake = { key: name, code: name === ' ' ? 'Space' : name, defaultPrevented: false, repeat: false, stopPropagation: function () {}, preventDefault: function () {}, composedPath: function () { return [document.body] } }
          if (down === false) onKeyUp(fake)
          else onKeyDown(fake)
        },
        _internals: {
          ui: ui, held: held, dragging: dragging,
          get art() { return art },
          refish: function () { return refreshFish() },
          rect: function () { return ui.runway.getBoundingClientRect() },
        },
      }
      window.__whaleRun = api

      ctx.effect(function () {
        return function () { if (window.__whaleRun === api) { try { delete window.__whaleRun } catch (e) { window.__whaleRun = undefined } } }
      }, 'whale-run:debug')
    }

    // ============================================================ §12 exports

    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
