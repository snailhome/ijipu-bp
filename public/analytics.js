/**
 * public/analytics.js — 爱扒谱访问计数（跨站上报主站 D1）
 *
 * 爱扒谱是独立 Pages 站点（ijipu-bp.pages.dev），没有自己的 Functions/D1；
 * 它把访问上报给主站 `https://ijipu.pages.dev/api/visit`，写进同一张 visits 表。
 * `path` 固定用 `/bp/` 作为统计标识（不是 bp 站点的真实路由）。
 *
 * 只统计生产环境；visitor 是本域 localStorage 的随机 id，不存 IP / UA。
 */
;(function () {
  try {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '') return
    if (location.protocol !== 'https:' && location.protocol !== 'http:') return

    var id = ''
    try {
      id = localStorage.getItem('bp.visitor') || ''
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
        localStorage.setItem('bp.visitor', id)
      }
    } catch {
      return
    }

    /* 跨域不用 sendBeacon（application/json 会触发预检），fetch 才能可靠走 CORS */
    fetch('https://ijipu.pages.dev/api/visit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/bp/', visitor: id, channel: 'web' }),
      mode: 'cors',
      keepalive: true,
    }).catch(function () {})
  } catch {
    /* 统计失败不影响页面 */
  }
})()
