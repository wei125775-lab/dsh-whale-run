/* whale-run 离线 harness 的驱动。
 *
 * 做的事：materialize 插件 → 造一个假 ctx 调 apply → 暴露 window.__harness
 * 给 CDP 脚本驱动。假 ctx 的 effect() 会把清理函数收起来，方便验"卸载干净"。
 */
(function () {
  'use strict'

  var PKG = '@dph/dsh-whale-run'
  var disposers = []
  var applied = 0

  function hashParams() {
    var out = {}
    var h = String(location.hash || '').replace(/^#/, '')
    if (!h) return out
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=')
      if (i < 0) out[kv] = '1'
      else out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1))
    })
    return out
  }

  function fakeCtx() {
    return {
      effect: function (fn, name) {
        var d = fn()
        disposers.push({ name: name, fn: typeof d === 'function' ? d : function () {} })
        return d
      },
      on: function () { return function () {} },
      logger: console,
      slots: { inject: function () {}, register: function () {} },
    }
  }

  function applyOnce() {
    var mod = window.__ModuleLoader__.materialize(PKG)
    if (typeof mod.apply !== 'function') throw new Error('plugin exports no apply()')
    mod.apply(fakeCtx())
    applied++
    return mod
  }

  function disposeAll() {
    while (disposers.length) {
      var d = disposers.pop()
      try { d.fn() } catch (e) { window.__errors.push('dispose ' + d.name + ': ' + e.message) }
    }
  }

  window.__harness = {
    PKG: PKG,
    params: hashParams(),
    get api() { return window.__whaleRun },
    get applied() { return applied },
    get disposerCount() { return disposers.length },
    apply: applyOnce,
    dispose: disposeAll,
    /** apply → dispose → apply 一轮，验重复挂载是否干净 */
    reapply: function () { disposeAll(); return applyOnce() },

    // ---- 给断言用的观察点 ----
    roots: function () { return document.querySelectorAll('#whale-run-root').length },
    pluginStyles: function () { return document.querySelectorAll('style[data-plugin="' + PKG + '"]').length },
    heroSvg: function () { return document.querySelector('[data-slot="conversation.hero.brand.mark"] svg') },
    sideSvg: function () { return document.querySelector('[data-slot="sidebar.brand.mark"] svg') },
    heroHidden: function () {
      var s = window.__harness.heroSvg()
      return !!s && s.style.visibility === 'hidden'
    },
    sideHidden: function () {
      var s = window.__harness.sideSvg()
      return !!s && s.style.visibility === 'hidden'
    },
    runway: function () { return document.querySelector('.wr-runway') },
    runwayShown: function () {
      var r = window.__harness.runway()
      return !!r && r.classList.contains('wr-shown')
    },
    runwayRect: function () {
      var r = window.__harness.runway()
      return r ? r.getBoundingClientRect().toJSON() : null
    },
    cardRect: function () {
      var c = document.querySelector('[data-composer-card]')
      return c ? c.getBoundingClientRect().toJSON() : null
    },
    carryLive: function () {
      var c = document.querySelector('.wr-carry')
      return !!c && c.classList.contains('wr-live')
    },
    carryBox: function () {
      var c = document.querySelector('.wr-carry')
      return c ? c.getBoundingClientRect().toJSON() : null
    },
    overlayHidden: function () {
      var r = document.getElementById('whale-run-root')
      return !r || r.hidden
    },
    newSessionClicks: function () { return window.__newSessionClicks || 0 },
    errors: function () { return window.__errors.slice() },
    focusTag: function () {
      var a = document.activeElement
      return a ? (a.tagName + (a.className ? '.' + String(a.className).split(' ')[0] : '')) : 'none'
    },
    headline: function () { return window.__whaleRun ? window.__whaleRun.headline() : null },
    shatterSpans: function () { return document.querySelectorAll('.wr-shatter span').length },
    shatterVisible: function () {
      var s = document.querySelector('.wr-shatter span')
      if (!s) return null
      return { opacity: Number(getComputedStyle(s).opacity), transform: getComputedStyle(s).transform }
    },
    fxStats: function () { return window.__harness._stats('.wr-fx') },
    carryStats: function () { return window.__harness._stats('.wr-carry') },
    hintOpacity: function () {
      var h = document.querySelector('.wr-hint')
      return h ? Number(getComputedStyle(h).opacity) : null
    },
    /** 把 canvas 的像素统计出来，用来判断"到底画了东西没有" */
    canvasStats: function () { return window.__harness._stats('.wr-canvas') },
    _stats: function (sel) {
      var c = document.querySelector(sel)
      if (!c) return null
      var g = c.getContext('2d')
      var d = g.getImageData(0, 0, c.width, c.height).data
      var sum = 0, nonEmpty = 0, min = 255, max = 0
      for (var i = 0; i < d.length; i += 4) {
        var v = (d[i] + d[i + 1] + d[i + 2]) / 3
        sum += v
        if (d[i + 3] > 8) nonEmpty++
        if (v < min) min = v
        if (v > max) max = v
      }
      var n = d.length / 4
      return { mean: +(sum / n).toFixed(2), coverage: +(nonEmpty / n).toFixed(3), min: min, max: max }
    },
  }

  // 种子的设置要发生在 drop 之前，所以在这里就设好
  if (window.__harness.params.seed) {
    window.__harness.pendingSeed = Number(window.__harness.params.seed)
  }

  applyOnce()
  if (window.__harness.pendingSeed && window.__whaleRun) {
    window.__whaleRun.setSeed(window.__harness.pendingSeed)
  }

  document.getElementById('harnessLog').textContent =
    'harness ready · disposers=' + disposers.length + ' · whale=' + (window.__whaleRun ? 'yes' : 'no')

  window.__harnessReady = true
})()
