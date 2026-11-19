/**
 * 用 Chrome DevTools 协议点界面（只在开发/自测时用，不进产物）。
 *
 * 为什么要有它：Tauri 窗口里用 mouse_event 点按钮，窗口被别的程序盖住时
 * 点不进去（SetForegroundWindow 常被系统拒绝）。浏览器版走 CDP，点击是
 * 直接投递给页面的，不受窗口叠放影响，正好用来验"按钮到底有没有接上事件"。
 *
 * 用法：node scripts/ui-probe.mjs [url]
 *   默认 http://localhost:5175/（先 npm run dev）。
 * 退出码 0 = 全部通过；1 = 有失败（会打印哪一条）。
 */
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.argv[2] ?? 'http://localhost:5175/'
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
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      const detail = d.exception?.description || d.exception?.value || ''
      throw new Error('[页面抛错] ' + (d.text || 'Uncaught') + ' | ' + detail + ' | expr=' + expression.slice(0, 90))
    }
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

  /* 点的行必须就是鼠标所在的那一行（用户 m04792：点表格会错行，错开两行） */
  const hitRow = await cdp.eval(`(() => {
    const s = window.__bp.getState()
    const m = window.__bpRoll || {}
    const ROW_H = 14
    const RULER_H = typeof m.rulerH === 'number' ? m.rulerH : 36
    const c = document.querySelector('.pane.roll canvas')
    const r = c.getBoundingClientRect()
    const cy = r.height * 0.72
    const want = m.top - Math.floor((cy - RULER_H) / ROW_H)
    const made = s.notes.filter((x) => x.id.startsWith('m'))
    const got = made.length ? made[made.length - 1].midi : null
    return { want, got, dpr: window.devicePixelRatio, cssH: Math.round(r.height), bufH: c.height }
  })()`)
  check('点格子落在鼠标所在的那一行', hitRow.want === hitRow.got,
    `鼠标那一行 ${hitRow.want}、画出来 ${hitRow.got}（css 高 ${hitRow.cssH}、缓冲 ${hitRow.bufH}）`)

  // 精确点一个已知音符：行高/顶行直接从页面里的 __bpRoll 拿（自己估过一次，差一行就点歪）
  const clickNote = async (id) => {
    const box = await cdp.eval(`(() => {
      const ROW_H = 14, KEY_W = 66
      const s = window.__bp.getState()
      const n = s.notes.find((x) => x.id === ${JSON.stringify(id)})
      const c = document.querySelector('.pane.roll canvas')
      const r = c.getBoundingClientRect()
      const m = window.__bpRoll || {}
      const RULER_H = typeof m.rulerH === 'number' ? m.rulerH : 36
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

  // ── 只点一下时间尺 = 取消区间 + 把播放头挪过去（用户 m03936 第 4 条）──
  await cdp.eval('window.__bp.getState().setCurrentMs(0)')
  await cdp.clickAt(ruler.ox + ruler.x1, ruler.y)
  await sleep(200)
  const cleared = await cdp.eval(`(() => { const s = window.__bp.getState(); return { loop: s.loop, on: s.loopOn, ms: s.currentMs } })()`)
  check('点一下时间尺 → 取消播放区间', cleared.loop === null && cleared.on === false, JSON.stringify(cleared.loop))
  check('点一下时间尺 → 播放头挪到点击处', Math.abs(cleared.ms - 800) < 60, String(Math.round(cleared.ms)))

  // ── 时间尺变高了（1.5 倍，方便点）──
  const rulerH = await cdp.eval(`window.__bpRoll?.rulerH ?? 0`)
  check('时间尺高度已是 36', rulerH === 36, String(rulerH))

  // ── 拖时间尺时光标变左右箭头（按下不松，读一下光标，再松开）──
  await cdp.eval('window.__bp.getState().setLoop(null)')
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: ruler.ox + ruler.x1, y: ruler.y, button: 'left', clickCount: 1, buttons: 1,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: ruler.ox + ruler.x1 + 40, y: ruler.y, button: 'left', buttons: 1,
  })
  await sleep(120)
  const cursorDuringDrag = await cdp.eval(`(() => {
    const c = document.querySelector('.pane.roll canvas')
    return c.style.cursor || getComputedStyle(c).cursor
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: ruler.ox + ruler.x1 + 40, y: ruler.y, button: 'left', clickCount: 1,
  })
  check('时间尺上按住划动时，光标是左右箭头', cursorDuringDrag === 'ew-resize', cursorDuringDrag)

  // ── 绘制模式下光标也是普通箭头（用户 m04626），不再用十字 ──
  await cdp.eval(`window.__bp.getState().setMode('draw')`)
  await sleep(150)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: ruler.ox + ruler.x1 + 40, y: ruler.y + 120, button: 'none', buttons: 0,
  })
  await sleep(150)
  const cursorDraw = await cdp.eval(`document.querySelector('.pane.roll canvas').style.cursor`)
  check('绘制模式下鼠标是普通箭头', cursorDraw === 'default', cursorDraw || '(空)')
  await cdp.eval(`window.__bp.getState().setMode('select')`)
  await sleep(100)
  // ── 绘制模式下，新音的起点必须是"光标所在那一格"（不是最近的格点，否则偏右一格）──
  const cellBox = await cdp.eval(`(() => {
    const c = document.querySelector('.pane.roll canvas')
    const r = c.getBoundingClientRect()
    const s = window.__bp.getState()
    const KEY_W = 66, RULER_H = 36, ROW_H = 14
    const m = window.__bpRoll
    const span = s.durationMs / s.view.zoom
    const beat = 60000 / s.bpm
    const xOf = (ms) => KEY_W + ((ms - s.view.panMs) / span) * (r.width - KEY_W)
    /* 点在某个 1 拍格子的 70% 处：如果按"最近格点"会跑到下一格，按"所在格"应留在本格 */
    const ms = s.firstBeatMs + beat * 1.7
    return { ox: r.x, oy: r.y, x: xOf(ms), y: RULER_H + (m.top - 60) * ROW_H + ROW_H / 2, ms, beat }
  })()`)
  await cdp.eval('window.__bp.getState().setMode("draw")')
  const beforeIds = await cdp.eval(`window.__bp.getState().notes.map((n) => n.id)`)
  await cdp.clickAt(cellBox.ox + cellBox.x, cellBox.oy + cellBox.y)
  await sleep(220)
  const created = await cdp.eval(`(() => {
    const list = window.__bp.getState().notes
    const before = ${JSON.stringify(beforeIds)}
    const fresh = list.filter((n) => !before.includes(n.id))
    return fresh.length ? { midi: fresh[0].midi, startMs: fresh[0].startMs } : null
  })()`)
  check(
    '绘制模式下新音落在光标所在的那一格（不是偏右一格）',
    !!created && created.midi === 60 && created.startMs <= cellBox.ms + 1 && created.startMs > cellBox.ms - cellBox.beat - 1,
    JSON.stringify(created),
  )
  await cdp.eval('window.__bp.getState().setMode("select")')

  // ── 右侧栏开关（收起时主区要真正占满，别留 280px 空白）──
  const sideOn = await cdp.eval(`(() => { const el = document.querySelector('.side'); return !!el && !el.classList.contains('off') })()`)
  const rollWOn = await cdp.eval(`document.querySelector('.pane.roll').getBoundingClientRect().width`)
  await cdp.eval(`document.querySelector('.icon-btn').click()`)
  await sleep(200)
  const sideOff = await cdp.eval(`(() => { const el = document.querySelector('.side'); return !el || el.classList.contains('off') })()`)
  const rollWOff = await cdp.eval(`document.querySelector('.pane.roll').getBoundingClientRect().width`)
  await cdp.eval(`document.querySelector('.icon-btn').click()`)
  await sleep(200)
  const sideBack = await cdp.eval(`(() => { const el = document.querySelector('.side'); return !!el && !el.classList.contains('off') })()`)
  check('右侧栏默认展开、点图标能收起、再点能展开', sideOn && sideOff && sideBack)
  check('收起右侧栏后主区变宽', rollWOff > rollWOn + 100, `${Math.round(rollWOn)} → ${Math.round(rollWOff)}`)

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

  /* ── 焦点在「播放」按钮上按空格：只能切换一次 ──
   * 之前只 preventDefault，按钮自己的空格激活仍会再 click 一次 ⇒ 一次空格切两遍，
   * 用户看到的就是"空格好像跳跃播放"。改成捕获阶段 + stopPropagation 后才对。 */
  await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.setLoop(null)
    s.setLoopOn(false)
    if (s.playing) s.setPlaying(false)
  })()`)
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('.toolbar button')].find((b) => /播放|暂停/.test(b.textContent || ''))
    btn?.focus()
    return document.activeElement?.tagName + ':' + (document.activeElement?.textContent || '')
  })()`)
  await cdp.pressKey('Space', ' ', 32)
  await sleep(320)
  const toggledOnce = await cdp.eval(`window.__bp.getState().playing`)
  await sleep(420)
  const stillPlaying = await cdp.eval(`window.__bp.getState().playing`)
  check('焦点在播放按钮上时，一次空格只切换一次', toggledOnce === true && stillPlaying === true,
    `playing=${toggledOnce}→${stillPlaying}`)
  await cdp.pressKey('Space', ' ', 32)
  await sleep(250)
  const stoppedAgain = await cdp.eval(`window.__bp.getState().playing`)
  check('焦点在播放按钮上时，再按一次能停', stoppedAgain === false, String(stoppedAgain))

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

  /* ── 时点线要跟着当前时点走 ──
   * 注意：headless Chrome 没有音频设备，按空格虽然 playing 变 true，
   * currentTime 却不动（实测 0 → 0）。所以这里不去驱动真实播放，
   * 而是按"每帧 tick 会写 currentMs"的口径直接写时点，验画布上的红线跟不跟。 */
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setLoop(null); s.setLoopOn(false); s.setView({ zoom: 1, panMs: 0 }); window.__bp.setState({ playing: false }); s.setCurrentMs(0) })()`)
  await sleep(400)
  /* 不要"扫整行找第一个红色" —— 热力图里红色是最热的一格，会抢在播放头前面。
     改成按当前时点算出期望列，再看那一列上下两处是不是红的（播放头是整条竖线）。 */
  const playheadAt = `(() => {
    const s = window.__bp.getState()
    const m = window.__bpRoll
    const cv = document.querySelector('.pane.roll canvas')
    if (!cv || !m) return { err: 'no canvas/metrics' }
    const g = cv.getContext('2d')
    const dpr = cv.width / parseFloat(cv.style.width || String(cv.width)) || 1
    const span = s.durationMs / s.view.zoom
    const px = m.left + ((s.currentMs - s.view.panMs) / span) * (m.w - m.left)
    const col = Math.max(0, Math.min(cv.width - 1, Math.round(px * dpr)))
    /* 线宽 1.5px，落在像素边界上会被抗锯齿摊到相邻两列，所以 ±1 列都算 */
    const reddish = (rowFrac) => {
      const y = Math.round(cv.height * rowFrac)
      const d = g.getImageData(Math.max(0, col - 1), y, 3, 1).data
      for (let k = 0; k < 3; k++) {
        const r = d[k * 4], gg = d[k * 4 + 1], b = d[k * 4 + 2]
        if (r > 140 && gg < 150 && b < 170) return true
      }
      return false
    }
    return { px: Math.round(px), hitTop: reddish(0.2), hitBottom: reddish(0.8), ms: Math.round(s.currentMs) }
  })()`

  await cdp.eval(`window.__bp.getState().setCurrentMs(window.__bp.getState().durationMs * 0.2)`)
  await sleep(350)
  const line1 = await cdp.eval(playheadAt)
  await cdp.eval(`window.__bp.getState().setCurrentMs(window.__bp.getState().durationMs * 0.6)`)
  await sleep(350)
  const line2 = await cdp.eval(playheadAt)
  check('当前时点变，红线跟着走', line1.hitTop && line1.hitBottom && line2.hitTop && line2.hitBottom && line2.px > line1.px + 20,
    `x ${line1.px}→${line2.px}（${line1.ms}ms→${line2.ms}ms，红=${line1.hitTop}/${line1.hitBottom}→${line2.hitTop}/${line2.hitBottom}）`)

  /* ── 真播一遍：按空格要能开始、时点与红线一起走、再按要能停 ──
   * 合成音模式的时点用 performance.now() 推，headless 里也能走（音频模式要靠音频时钟，没设备不行）。 */
  await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.setPlayMode('synth')
    s.setLoop(null)
    s.setLoopOn(false)
    s.setCurrentMs(0)
    window.__bp.setState({ playing: false })
  })()`)
  await sleep(250)
  await cdp.pressKey('Space', ' ', 32)
  await sleep(700)
  const run1 = await cdp.eval(playheadAt).then(async (a) => ({ a, st: await cdp.eval(`(() => { const s = window.__bp.getState(); return { playing: s.playing, ms: Math.round(s.currentMs) } })()`) }))
  await sleep(700)
  const run2 = await cdp.eval(playheadAt).then(async (a) => ({ a, st: await cdp.eval(`(() => { const s = window.__bp.getState(); return { playing: s.playing, ms: Math.round(s.currentMs) } })()`) }))
  check('按空格能开始播放（时点往前走）', run2.st.playing && run2.st.ms > run1.st.ms + 200,
    `${run1.st.ms}ms → ${run2.st.ms}ms，playing=${run2.st.playing}`)
  check('播放时红线跟着走', run2.a.px > run1.a.px + 5, `x ${run1.a.px}→${run2.a.px}`)
  await cdp.pressKey('Space', ' ', 32)
  await sleep(300)
  const stopA = await cdp.eval(`(() => { const s = window.__bp.getState(); return { playing: s.playing, ms: Math.round(s.currentMs) } })()`)
  await sleep(600)
  const stopB = await cdp.eval(`(() => { const s = window.__bp.getState(); return { playing: s.playing, ms: Math.round(s.currentMs) } })()`)
  check('再按空格能停下来（时点不再动）', !stopB.playing && Math.abs(stopB.ms - stopA.ms) < 80,
    `playing=${stopB.playing}，${stopA.ms}ms → ${stopB.ms}ms`)
  await cdp.eval(`window.__bp.getState().setCurrentMs(0)`)
  await sleep(150)

  /* ── 自动翻页：时点线碰到右边缘才翻 ──
   * 翻页逻辑要求整首比一屏（20 秒）长，所以先把时长临时摆成 60 秒；
   * 用 store 直接设 playing + currentMs，不去等真实播放。 */
  await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.setLoaded({ fileName: 'probe-long.wav', filePath: null, durationMs: 60000 })
    s.setAutoPage(true)
    s.setView({ zoom: 2, panMs: 0 })
    s.setCurrentMs(0)
    window.__bp.setState({ playing: true })
  })()`)
  await sleep(250)
  await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.setCurrentMs(s.durationMs / s.view.zoom * 0.9)   // 还差一截到边：不该翻
  })()`)
  await sleep(250)
  const panMid = await cdp.eval(`window.__bp.getState().view.panMs`)
  check('时点线还没到右边缘时不翻页', Math.abs(panMid) < 1, `panMs=${Math.round(panMid)}`)

  await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.setCurrentMs(s.view.panMs + s.durationMs / s.view.zoom - 0.5)   // 贴住右边缘：该翻
  })()`)
  await sleep(300)
  const panEdge = await cdp.eval(`window.__bp.getState().view.panMs`)
  check('时点线碰到右边缘就翻页', panEdge > 1, `panMs=${Math.round(panEdge)}`)
  await cdp.eval(`(() => {
    const s = window.__bp.getState()
    window.__bp.setState({ playing: false })
    s.setView({ zoom: 1, panMs: 0 })
    s.setCurrentMs(0)
    s.setLoaded({ fileName: 'probe.wav', filePath: null, durationMs: 4000 })
  })()`)
  await sleep(150)

  /* ── 按钢琴键：按下那一格要高亮成黄（用户 m04380） ── */
  const keyPt = await cdp.eval(`(() => {
    const m = window.__bpRoll || {}
    const cv = document.querySelector('.pane.roll canvas')
    const r = cv.getBoundingClientRect()
    const ROW_H = 14, KEY_W = 66
    const rulerH = typeof m.rulerH === 'number' ? m.rulerH : 36
    /* 挑中间那一行，避开时间尺 */
    const row = Math.floor((m.rows || 20) / 2)
    return { x: r.x + KEY_W * 0.35, y: r.y + rulerH + row * ROW_H + ROW_H / 2, wx: KEY_W * 0.35, wy: rulerH + row * ROW_H + ROW_H / 2 }
  })()`)
  const keyPixel = `(() => {
    const cv = document.querySelector('.pane.roll canvas')
    const g = cv.getContext('2d')
    const sx = cv.width / parseFloat(cv.style.width || String(cv.width))
    const sy = cv.height / parseFloat(cv.style.height || String(cv.height))
    const d = g.getImageData(Math.round(${keyPt.wx} * sx), Math.round(${keyPt.wy} * sy), 1, 1).data
    return [d[0], d[1], d[2]]
  })()`
  const beforeKey = await cdp.eval(keyPixel)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: keyPt.x, y: keyPt.y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(250)
  const duringKey = await cdp.eval(keyPixel)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: keyPt.x, y: keyPt.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
  const afterKey = await cdp.eval(keyPixel)
  const yellowish = (c) => c[0] > 190 && c[1] > 140 && c[2] < 140
  check('按下钢琴键时该格高亮成黄色，松手恢复',
    !yellowish(beforeKey) && yellowish(duringKey) && !yellowish(afterKey),
    `${beforeKey} → ${duringKey} → ${afterKey}`)

  /* ── 黑键：按下时只有黑键那块变黄，左边仍是白的（用户 m04987 第五条，对照图 4） ── */
  const blackPt = await cdp.eval(`(() => {
    const m = window.__bpRoll || {}
    const cv = document.querySelector('.pane.roll canvas')
    const r = cv.getBoundingClientRect()
    const ROW_H = 14, KEY_W = 66
    const BLACK = new Set([1, 3, 6, 8, 10])
    const rulerH = typeof m.rulerH === 'number' ? m.rulerH : 36
    for (let row = 3; row < (m.rows || 20) - 3; row++) {
      const midi = m.top - row
      if (!BLACK.has(((midi % 12) + 12) % 12)) continue
      const wy = rulerH + row * ROW_H + ROW_H / 2
      return { x: r.x + KEY_W * 0.85, y: r.y + wy, wy, bx: KEY_W * 0.85, lx: 5 }
    }
    return null
  })()`)
  if (blackPt) {
    const readAt = (wx) => `(() => {
      const cv = document.querySelector('.pane.roll canvas')
      const g = cv.getContext('2d')
      const sx = cv.width / parseFloat(cv.style.width || String(cv.width))
      const sy = cv.height / parseFloat(cv.style.height || String(cv.height))
      const d = g.getImageData(Math.round(${wx} * sx), Math.round(${blackPt.wy} * sy), 1, 1).data
      return [d[0], d[1], d[2]]
    })()`
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: blackPt.x, y: blackPt.y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(250)
    const blockDuring = await cdp.eval(readAt(blackPt.bx))
    const leftDuring = await cdp.eval(readAt(blackPt.lx))
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: blackPt.x, y: blackPt.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(200)
    check('按黑键：黑键那块变黄、左边白区不变', yellowish(blockDuring) && !yellowish(leftDuring),
      `黑键块 ${blockDuring}、左侧 ${leftDuring}`)
  } else {
    check('按黑键：黑键那块变黄、左边白区不变', false, '没找到黑键行')
  }

  /* ── 新画的音 = 最小绘制格（十六分音符 = 1/4 拍，用户 m04380） ── */
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setMode('draw'); s.setLoop(null); s.setLoopOn(false); s.setBpm(120); s.setView({ zoom: 1, panMs: 0 }) })()`)
  await sleep(200)
  const gridPt = await cdp.eval(`(() => {
    const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    const m = window.__bpRoll || {}
    const rulerH = typeof m.rulerH === 'number' ? m.rulerH : 36
    const ROW_H = 14
    return { x: r.x + r.width * 0.55, y: r.y + rulerH + Math.floor((m.rows || 20) * 0.3) * ROW_H + ROW_H / 2 }
  })()`)
  const countBefore = await cdp.eval(`window.__bp.getState().notes.length`)
  await cdp.clickAt(gridPt.x, gridPt.y)
  await sleep(250)
  const madeNote = await cdp.eval(`(() => {
    const n = window.__bp.getState().notes
    const last = n[n.length - 1]
    return { grew: n.length === ${countBefore} + 1, len: Math.round(last.endMs - last.startMs) }
  })()`)
  check('新画的音只有最小格那么长（1/16 拍 = 31ms @120bpm）', madeNote.grew && Math.abs(madeNote.len - 31) <= 6,
    `长度 ${madeNote.len}ms，个数${countBefore}→${madeNote.grew ? '多一个' : '没变'}`)

  /* ── 点哪一格就画哪一格（用户 m04674）：起点要落在鼠标所在的最小格里 ── */
  const cellProbe = await cdp.eval(`(() => {
    const s = window.__bp.getState()
    const m = window.__bpRoll
    const cv = document.querySelector('.pane.roll canvas')
    const r = cv.getBoundingClientRect()
    const RULER_H = typeof m.rulerH === 'number' ? m.rulerH : 36
    const ROW_H = 14
    const x = r.x + r.width * 0.62
    const want = s.view.panMs + ((x - r.x - m.left) / (m.w - m.left)) * (s.durationMs / s.view.zoom)
    return { x, y: r.y + RULER_H + Math.floor((m.rows || 20) * 0.55) * ROW_H + ROW_H / 2, want, cell: 60000 / s.bpm / 16 }
  })()`)
  const nBefore2 = await cdp.eval(`window.__bp.getState().notes.length`)
  await cdp.clickAt(cellProbe.x, cellProbe.y)
  await sleep(250)
  const cellOut = await cdp.eval(`(() => {
    const n = window.__bp.getState().notes
    const last = n[n.length - 1]
    return { grew: n.length === ${nBefore2} + 1, start: last.startMs }
  })()`)
  const cellOff = Math.abs(cellOut.start - cellProbe.want)
  check('新音的起点落在鼠标所在的那一格', cellOut.grew && cellOff <= cellProbe.cell,
    `鼠标 ${Math.round(cellProbe.want)}ms、音符起点 ${Math.round(cellOut.start)}ms、差 ${Math.round(cellOff)}ms（一格 ${cellProbe.cell.toFixed(1)}ms）`)

  /* ── 按住横向拖 = 同一个音延长，不是画出一串音（用户 m04674） ── */
  /* 先把音符清空，免得按在已有音符上变成"移动" */
  await cdp.eval(`window.__bp.setState({ notes: [] })`)
  await sleep(150)
  const dragBox = await cdp.eval(`(() => {
    const s = window.__bp.getState()
    const m = window.__bpRoll
    const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    const RULER_H = typeof m.rulerH === 'number' ? m.rulerH : 36
    const ROW_H = 14
    const y = r.y + RULER_H + Math.floor((m.rows || 20) * 0.7) * ROW_H + ROW_H / 2
    return { x1: r.x + r.width * 0.3, x2: r.x + r.width * 0.45, y, before: s.notes.length }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragBox.x1, y: dragBox.y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(90)
  for (let i = 1; i <= 5; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: dragBox.x1 + ((dragBox.x2 - dragBox.x1) * i) / 5, y: dragBox.y, button: 'left', buttons: 1,
    })
    await sleep(60)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragBox.x2, y: dragBox.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
  const dragOut = await cdp.eval(`(() => {
    const n = window.__bp.getState().notes
    const last = n[n.length - 1]
    return { grew: n.length === ${dragBox.before} + 1, len: Math.round(last.endMs - last.startMs) }
  })()`)
  check('按住横拖只出一个音，长度跟着拖', dragOut.grew && dragOut.len > 300,
    `个数 ${dragBox.before}→${dragOut.grew ? '多一个' : '没对'}，长度 ${dragOut.len}ms`)
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setMode('select') })()`)
  await sleep(150)

  const errs = await cdp.eval(`window.__bpErrors || 0`)
  check('页面没有运行时错误', !errs, errs ? String(errs) : '')

  /* --shot <path>：把当前界面截一张干净图
     （顺手灌回一份假的频谱与两个音、全标确认、圈一段区间，谱面才有内容可看） */
  const shotAt = process.argv.indexOf('--shot')
  if (shotAt > 0 && process.argv[shotAt + 1]) {
    await cdp.eval(`(() => {
      const st = window.__bp
      const s = st.getState()
      s.setLoaded({ fileName: 'probe.wav', filePath: null, durationMs: 4000 })
      const frames = 200, bins = 88
      const data = new Float32Array(frames * bins)
      for (let i = 0; i < frames; i++) {
        for (let b = 0; b < bins; b++) {
          /* 造点"有音高线"的样子：每个八度附近亮一些，再加一点噪声 */
          const near = Math.abs(((b % 12) - 3)) < 1.5 ? 0.8 : 0.15
          data[i * bins + b] = near * (0.5 + 0.5 * Math.sin(i / 9)) + Math.random() * 0.08
        }
      }
      s.setAnalysis({
        durationMs: 4000, sampleRate: 44100,
        spectrum: { frames, hopMs: 20, sampleRate: 44100, data, frameRms: new Float32Array(frames).fill(0.3) },
        notes: [
          { id: 'a1', midi: 60, startMs: 200, endMs: 900, velocity: 0.8, confirmed: false },
          { id: 'a2', midi: 64, startMs: 1000, endMs: 1700, velocity: 0.8, confirmed: false },
          { id: 'a3', midi: 67, startMs: 1800, endMs: 2600, velocity: 0.8, confirmed: false },
          { id: 'a4', midi: 72, startMs: 2700, endMs: 3400, velocity: 0.8, confirmed: false },
        ],
        bpm: 120, firstBeatMs: 0,
        keyCandidates: [
          { tonic: 0, share: 0.24 }, { tonic: 7, share: 0.17 }, { tonic: 5, share: 0.13 },
          { tonic: 3, share: 0.09 }, { tonic: 8, share: 0.08 }, { tonic: 4, share: 0.07 },
        ],
      })
      st.setState({ tonic: 0 })
      s.setView({ zoom: 1, panMs: 0 })
      s.setCurrentMs(800)
      s.setAllConfirmed(true)
      s.setLoop({ startMs: 500, endMs: 2500 })
      s.setLoopOn(true)
    })()`)
    await sleep(600)
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(process.argv[shotAt + 1], Buffer.from(png.data, 'base64'))
    check('截图已保存', true, process.argv[shotAt + 1])
  }
} catch (e) {
  check('探测过程本身出错', false, (e && e.stack) || String(e))
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
