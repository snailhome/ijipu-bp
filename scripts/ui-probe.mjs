/**
 * 用 Chrome DevTools 协议点界面（只在开发/自测时用，不进产物）。
 *
 * 为什么要有它：Tauri 窗口里用 mouse_event 点按钮，窗口被别的程序盖住时
 * 点不进去（SetForegroundWindow 常被系统拒绝）。浏览器版走 CDP，点击是
 * 直接投递给页面的，不受窗口叠放影响，正好用来验"按钮到底有没有接上事件"。
 *
 * 用法：node scripts/ui-probe.mjs [url]
 *   默认 http://localhost:5174/（先 npm run dev）。
 * 退出码 0 = 全部通过；1 = 有失败（会打印哪一条）。
 */
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.argv[2] ?? 'http://localhost:5174/'
const PORT = 9333
const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return await r.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('Chrome 调试端口没起来')
}

/** 极简 CDP 客户端：发命令、等同 id 的回包 */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.waiting = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id)
        this.waiting.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面里跑一段表达式，返回值直接给回来 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  /** 按可见文字点一个按钮（返回是否点到了） */
  async clickText(text) {
    const box = await this.eval(`(() => {
      const el = [...document.querySelectorAll('button, .seg button, select')]
        .find((b) => (b.textContent || '').trim().includes(${JSON.stringify(text)}))
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    if (!box) return false
    await this.clickAt(box.x, box.y)
    return true
  }

  async clickAt(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 }
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
    await sleep(120)
  }

  /** 按住从 (x1,y1) 拖到 (x2,y2)，分几步走，让 React 收到连续 pointermove */
  async dragAt(x1, y1, x2, y2, steps = 6) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: x1,
      y: y1,
      button: 'left',
      clickCount: 1,
    })
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x1 + ((x2 - x1) * i) / steps,
        y: y1 + ((y2 - y1) * i) / steps,
        button: 'left',
        buttons: 1,
      })
      await sleep(40)
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x2,
      y: y2,
      button: 'left',
      clickCount: 1,
    })
    await sleep(120)
  }

  /** 按一下某个键（code 用 DOM 的 code，比如 Space / Backquote） */
  async pressKey(code, key = code, vk = 0) {
    const base = { code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(120)
  }

  /** 在某个坐标上滚一下（modifiers: 1=Alt 2=Ctrl 4=Meta 8=Shift，跟 CDP 一致） */
  async wheelAt(x, y, deltaY, modifiers = 0) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
      modifiers,
    })
    await sleep(120)
  }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const userDataDir = await mkdtemp(join(tmpdir(), 'bp-uiprobe-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,960',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let cdp = null
try {
  await waitDevtools()
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json()
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // 等 React 挂上去（工具条出现）
  let mounted = false
  for (let i = 0; i < 80; i++) {
    mounted = await cdp.eval(`!!document.querySelector('.toolbar')`)
    if (mounted) break
    await sleep(250)
  }
  check('界面挂载（出现 .toolbar）', mounted)
  if (!mounted) throw new Error('界面没起来，后面的点击没意义')

  const segOn = (label) =>
    cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.seg button')].find((x) => (x.textContent || '').includes(${JSON.stringify(label)}))
      return !!b && b.classList.contains('on')
    })()`)

  check('默认是选择模式（只试听，不会误画）', await segOn('选择'))
  check('点「绘制」能切到绘制模式', (await cdp.clickText('绘制')) && (await segOn('绘制')))
  check('点「选择」能切回选择模式', (await cdp.clickText('选择')) && (await segOn('选择')))

  const flagOn = (label) =>
    cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith(${JSON.stringify(label)}))
      return !!b && b.classList.contains('on')
    })()`)
  check('「自动翻页」默认开着', await flagOn('自动翻页'))
  await cdp.clickText('自动翻页')
  check('点一下能关掉「自动翻页」', !(await flagOn('自动翻页')))
  await cdp.clickText('自动翻页')
  check('再点一下能开回来', await flagOn('自动翻页'))

  const loopDisabled = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('重复区间'))
    return !!b && b.disabled
  })()`)
  check('还没画重复区间时「重复区间」是灰的', loopDisabled)

  const disabled = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('导出'))
    return !!b && b.disabled
  })()`)
  check('没有确认音符时「导出」是灰的', disabled)

  const hasRoll = await cdp.eval(`!!document.querySelector('.pane.roll canvas')`)
  check('音符表画布在', hasRoll)

  // ── 造一段假分析结果，验"点画布画音 / 点音符确认"这条最关键的交互 ──
  const injected = await cdp.eval(`(() => {
    const bp = window.__bp
    if (!bp) return 'no-store'
    const st = bp.getState()
    st.setLoaded({ fileName: 'probe.wav', filePath: null, durationMs: 4000 })
    const frames = 200
    const bins = 88
    const data = new Float32Array(frames * bins)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 0.3
    const frameRms = new Float32Array(frames).fill(0.1)
    st.setAnalysis({
      durationMs: 4000,
      sampleRate: 44100,
      spectrum: { frames, hopMs: 20, sampleRate: 44100, data, frameRms },
      notes: [
        { id: 'a1', midi: 60, startMs: 0, endMs: 500, velocity: 0.8, confirmed: false },
        { id: 'a2', midi: 64, startMs: 500, endMs: 1000, velocity: 0.8, confirmed: false },
      ],
      bpm: 120,
      firstBeatMs: 0,
      keyCandidates: [{ tonic: 0, share: 1 }],
    })
    st.setBpm(120)
    st.setFirstBeatMs(0)
    return bp.getState().notes.length
  })()`)
  check('能灌入假分析（2 个未确认音）', injected === 2, String(injected))

  /** 点音符表画布上的一格（客户端坐标由画布矩形换算） */
  const clickRoll = async (fx, fy) => {
    const box = await cdp.eval(`(() => {
      const c = document.querySelector('.pane.roll canvas')
      const r = c.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })()`)
    await cdp.clickAt(box.x + box.w * fx, box.y + box.h * fy)
  }

  // 点画布中间偏下的一块空白 → 应该多出一个"已确认"的音
  // 注意：默认是选择模式（点哪都只试听），这里先切到绘制模式再画
  await cdp.eval('window.__bp.getState().setMode("draw")')
  await sleep(120)
  await clickRoll(0.7, 0.72)
  const afterDraw = await cdp.eval(`(() => {
    const s = window.__bp.getState()
    return { n: s.notes.length, conf: s.notes.filter((x) => x.confirmed).length, jps: s.jps }
  })()`)
  check('绘制模式点空白会加音且直接算确认', afterDraw.n === 3 && afterDraw.conf === 1, JSON.stringify(afterDraw.n + '/' + afterDraw.conf))
  check('加了音之后 jps 里有谱行', /^Q:/m.test(afterDraw.jps), (afterDraw.jps || '').split('\n').filter((l) => l.startsWith('Q:')).join(' | '))

  // 精确点一个已知音符：行高/顶行直接从页面里的 __bpRoll 拿（自己估过一次，差一行就点歪）
  const clickNote = async (id) => {
    const box = await cdp.eval(`(() => {
      const ROW_H = 14, RULER_H = 24, KEY_W = 66
      const s = window.__bp.getState()
      const n = s.notes.find((x) => x.id === ${JSON.stringify(id)})
      const c = document.querySelector('.pane.roll canvas')
      const r = c.getBoundingClientRect()
      const m = window.__bpRoll || {}
      const top = typeof m.top === 'number' ? m.top : 76
      const span = s.durationMs / s.view.zoom
      const ms = (n.startMs + n.endMs) / 2
      const y = RULER_H + (top - n.midi) * ROW_H + ROW_H / 2
      const x = KEY_W + ((ms - s.view.panMs) / span) * (r.width - KEY_W)
      return { x, y } // 相对画布左上角
    })()`)
    const origin = await cdp.eval(`(() => {
      const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
      return { x: r.x, y: r.y }
    })()`)
    await cdp.clickAt(origin.x + box.x, origin.y + box.y)
  }

  await clickNote('a1')
  const a1on = await cdp.eval(`window.__bp.getState().notes.find((x) => x.id === 'a1').confirmed`)
  check('绘制模式点已有音符 → 确认', a1on === true, String(a1on))
  await clickNote('a1')
  const a1off = await cdp.eval(`window.__bp.getState().notes.find((x) => x.id === 'a1').confirmed`)
  check('再点一次 → 取消确认', a1off === false, String(a1off))

  // 切到选择模式，点音符不该再改确认状态
  await cdp.clickText('选择')
  const before = await cdp.eval(`window.__bp.getState().notes.filter((x) => x.confirmed).length`)
  await clickRoll(0.5, 0.5)
  const after = await cdp.eval(`window.__bp.getState().notes.filter((x) => x.confirmed).length`)
  check('选择模式点画布不改确认状态', before === after, before + '→' + after)

  // 全选按钮：现在有音符了，它应该是可点的
  await cdp.clickText('全选')
  const allConf = await cdp.eval(`(() => {
    const n = window.__bp.getState().notes
    return n.length > 0 && n.every((x) => x.confirmed)
  })()`)
  check('点「全选」把所有音标成确认', allConf)

  await cdp.clickText('全不选')
  const noneConf = await cdp.eval(`window.__bp.getState().notes.every((x) => !x.confirmed)`)
  check('点「全不选」能清回来', noneConf)

  // ── 重复区间：造一个 500–2500ms 的区间，拖右握柄，验证能改长短 ──
  const loopBox = await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.setLoop({ startMs: 500, endMs: 2500 })
    s.setLoopOn(true)
    const c = document.querySelector('.pane.roll canvas')
    const r = c.getBoundingClientRect()
    const KEY_W = 66
    const xOf = (ms) => KEY_W + (ms / s.durationMs) * (r.width - KEY_W)
    return { x1: xOf(500), x2: xOf(2500), y: r.y + r.height / 2, ox: r.x, oy: r.y }
  })()`)
  await sleep(200)
  await cdp.dragAt(loopBox.ox + loopBox.x2, loopBox.y, loopBox.ox + loopBox.x2 + 80, loopBox.y)
  const loopNow = await cdp.eval(`window.__bp.getState().loop.endMs`)
  check('拖右握柄能把重复区间拉长', loopNow > 2600, String(Math.round(loopNow)))

  // ── Shift+滚轮 = 左右平移；Shift+Alt+滚轮 = 横向缩放 ──
  const rollCenter = await cdp.eval(`(() => {
    const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    return { x: r.x + r.width * 0.6, y: r.y + r.height * 0.5 }
  })()`)
  const wheel = (modifiers, deltaY) =>
    cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: rollCenter.x,
      y: rollCenter.y,
      deltaX: 0,
      deltaY,
      modifiers,
    })
  const SHIFT = 8
  const ALT = 1
  const beforePan = await cdp.eval(`({ ...window.__bp.getState().view })`)
  await wheel(SHIFT | ALT, -120)
  await sleep(150)
  const afterZoom = await cdp.eval(`({ ...window.__bp.getState().view })`)
  check('Shift+Alt+滚轮 = 横向放大', afterZoom.zoom > beforePan.zoom, `zoom ${beforePan.zoom}→${afterZoom.zoom}`)
  /* 先放大才有的平移：zoom=1 时整首都在视野里，pan 只能是 0 */
  await wheel(SHIFT, 120)
  await sleep(150)
  const afterPan = await cdp.eval(`({ ...window.__bp.getState().view })`)
  check(
    'Shift+滚轮 = 左右平移（zoom 不变、pan 变大）',
    afterPan.panMs > afterZoom.panMs && afterPan.zoom === afterZoom.zoom,
    `pan ${Math.round(afterZoom.panMs)}→${Math.round(afterPan.panMs)} zoom ${afterPan.zoom}`,
  )

  // ── 时间尺：按住拖 = 圈播放区间（不必按 Shift）；点一下 = 只挪播放头 ──
  const ruler = await cdp.eval(`(() => {
    const c = document.querySelector('.pane.roll canvas')
    const r = c.getBoundingClientRect()
    const s = window.__bp.getState()
    const KEY_W = 66
    const span = s.durationMs / s.view.zoom
    const xOf = (ms) => KEY_W + ((ms - s.view.panMs) / span) * (r.width - KEY_W)
    return { ox: r.x, oy: r.y, y: r.y + 8, x1: xOf(800), x2: xOf(2400) }
  })()`)
  await cdp.eval('window.__bp.getState().setLoop(null)')
  await sleep(120)
  await cdp.dragAt(ruler.ox + ruler.x1, ruler.y, ruler.ox + ruler.x2, ruler.y, 8)
  const draggedLoop = await cdp.eval('window.__bp.getState().loop')
  const draggedOn = await cdp.eval('window.__bp.getState().loopOn')
  check(
    '时间尺上按住拖 → 圈出播放区间并自动打开循环',
    !!draggedLoop && draggedLoop.endMs - draggedLoop.startMs > 800 && draggedOn,
    JSON.stringify(draggedLoop),
  )

  // ── 右侧栏开关 ──
  const sideOn = await cdp.eval(`(() => { const el = document.querySelector('.side'); return !!el && !el.classList.contains('off') })()`)
  await cdp.eval(`document.querySelector('.icon-btn').click()`)
  await sleep(150)
  const sideOff = await cdp.eval(`(() => { const el = document.querySelector('.side'); return !el || el.classList.contains('off') })()`)
  await cdp.eval(`document.querySelector('.icon-btn').click()`)
  await sleep(150)
  const sideBack = await cdp.eval(`(() => { const el = document.querySelector('.side'); return !!el && !el.classList.contains('off') })()`)
  check('右侧栏默认展开、点图标能收起、再点能展开', sideOn && sideOff && sideBack)

  // ── 横向滚动条：一直在，放大后 thumb 变窄 ──
  const barWidth = await cdp.eval(`(() => {
    const t = document.querySelector('.hbar > i')
    const track = document.querySelector('.hbar')
    if (!t || !track) return null
    return { thumb: t.getBoundingClientRect().width, track: track.getBoundingClientRect().width }
  })()`)
  check(
    '横向滚动条在，放大后 thumb 比轨道窄',
    !!barWidth && barWidth.thumb < barWidth.track - 4,
    JSON.stringify(barWidth),
  )
  const stripHint = await cdp.eval(
    `(() => { const c = document.querySelector('.pane.strip canvas'); return c ? c.width > 0 : false })()`,
  )
  check('流线谱画布在', stripHint)

  /* ── 倍率/对比真有作用：同一块画布取样，调滑条后颜色必须变 ──
   * 这两个滑条一开始"看着没效果"，因为绘制 effect 的依赖漏了它们（不会重绘）。 */
  const sampleHeat = async () =>
    cdp.eval(`(() => {
      const cv = [...document.querySelectorAll('canvas')].find((c) => c.width > 600 && c.height > 300)
      if (!cv) return -1
      const g = cv.getContext('2d')
      let sum = 0
      let n = 0
      for (let i = 1; i < 12; i++) {
        for (let j = 1; j < 8; j++) {
          const d = g.getImageData(Math.round((cv.width * i) / 12), Math.round((cv.height * j) / 8), 1, 1).data
          sum += d[0] + d[1] + d[2]
          n++
        }
      }
      return Math.round(sum / n)
    })()`)
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setGain(0.25); s.setContrast(1) })()`)
  await sleep(250)
  const dim = await sampleHeat()
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setGain(3); s.setContrast(1) })()`)
  await sleep(250)
  const bright = await sampleHeat()
  check('倍率滑条真能改变热力图深浅', bright > dim + 30, `${dim}→${bright}`)

  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setGain(1.2); s.setContrast(0.3) })()`)
  await sleep(250)
  const lowC = await sampleHeat()
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setGain(1.2); s.setContrast(3) })()`)
  await sleep(250)
  const highC = await sampleHeat()
  check('对比滑条真能改变热力图曲线', lowC !== highC, `${lowC} vs ${highC}`)
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setGain(1); s.setContrast(1.4) })()`)

  /* ── 空格启停 ── 之前焦点落在滑条上时被"输入框不响应热键"挡掉，现在只有真typing才挡 */
  const rollBox = await cdp.eval(`(() => {
    const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    return { x: r.x + r.width * 0.6, y: r.y + r.height * 0.5 }
  })()`)
  await cdp.eval(`window.__bp.getState().setLoop(null)`)
  await cdp.eval(`document.querySelector('.side input[type=range]')?.focus()`)
  await cdp.pressKey('Space', ' ', 32)
  await sleep(300)
  const playingAfterSpace = await cdp.eval(`window.__bp.getState().playing`)
  check('焦点在滑条上时，空格也能开始播放', playingAfterSpace === true, String(playingAfterSpace))
  await cdp.pressKey('Space', ' ', 32)
  await sleep(250)
  const stoppedAfterSpace = await cdp.eval(`window.__bp.getState().playing`)
  check('再按空格能停下', stoppedAfterSpace === false, String(stoppedAfterSpace))

  /* ── 圈了区间，按播放要从区间开头放（不是从头） ── */
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setLoop({ startMs: 800, endMs: 2000 }); s.setLoopOn(true); s.setCurrentMs(0) })()`)
  await sleep(150)
  await cdp.pressKey('Space', ' ', 32)
  await sleep(500)
  const loopStartMs = await cdp.eval(`window.__bp.getState().currentMs`)
  check('画了播放区间后按空格，从区间开头放', loopStartMs >= 780, `currentMs=${Math.round(loopStartMs)}`)
  await cdp.pressKey('Space', ' ', 32)
  await sleep(200)

  /* ── 滚轮不用先点画布：Shift+Alt 悬停就能缩放 ── */
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setView({ zoom: 1, panMs: 0 }); s.setLoop(null) })()`)
  await sleep(150)
  await cdp.wheelAt(rollBox.x, rollBox.y, -120, 8 | 1)
  await sleep(250)
  const zoomAfterWheel = await cdp.eval(`window.__bp.getState().view.zoom`)
  check('鼠标悬停直接滚（Shift+Alt）就能缩放', zoomAfterWheel > 1, `zoom=${zoomAfterWheel}`)

  /* ── 时间尺上不显示悬浮信息牌 ── */
  const rulerPoint = await cdp.eval(`(() => {
    const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    return { x: r.x + r.width * 0.5, y: r.y + 8 }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: rulerPoint.x,
    y: rulerPoint.y,
    button: 'none',
  })
  await sleep(200)
  const badgeOnRuler = await cdp.eval(`!!document.querySelector('.row-badge')`)
  check('时间尺区域不显示"音名·简谱"信息牌', badgeOnRuler === false, String(badgeOnRuler))

  const errs = await cdp.eval(`window.__bpErrors || 0`)
  check('页面没有运行时错误', !errs, errs ? String(errs) : '')

  /* --shot <path>：把当前界面截一张干净图（顺手把音都确认上，谱面才有内容） */
  const shotAt = process.argv.indexOf('--shot')
  if (shotAt > 0 && process.argv[shotAt + 1]) {
    await cdp.eval(`(() => {
      const s = window.__bp.getState()
      s.setAllConfirmed(true)
      s.setLoop({ startMs: 500, endMs: 2500 })
      s.setLoopOn(true)
    })()`)
    await sleep(400)
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(process.argv[shotAt + 1], Buffer.from(png.data, 'base64'))
    check('截图已保存', true, process.argv[shotAt + 1])
  }
} catch (e) {
  check('探测过程本身出错', false, e.message)
} finally {
  try {
    cdp?.ws.close()
  } catch {
    /* 忽略 */
  }
  chrome.kill()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
