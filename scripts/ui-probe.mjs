/**
 * 用 Chrome DevTools 协议点界面（只在开发/自测时用，不进产物）。
 *
 * 为什么要有它：Tauri 窗口里用 mouse_event 点按钮，窗口被别的程序盖住时
 * 点不进去（SetForegroundWindow 常被系统拒绝）。浏览器版走 CDP，点击是
 * 直接投递给页面的，不受窗口叠放影响，正好用来验"按钮到底有没有接上事件"。
 *
 * 用法：node scripts/ui-probe.mjs [url] [--shot out.png] [--pickup N]
 *   默认 http://localhost:5175/（先 npm run dev）。
 *   --shot 截图（配合 --pickup 可截弱起时的小节线）。
 * 退出码 0 = 全部通过；1 = 有失败（会打印哪一条）。
 */
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 取参数值，同时避免把 --pickup 后面的数字当成页面 URL */
const argv = process.argv.slice(2)
const argValue = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
const URL_ = positional[0] ?? 'http://127.0.0.1:5175/'
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
        .find((b) => {
          const label = (b.getAttribute('aria-label') || '').trim()
          const txt = (b.textContent || '').trim()
          return txt.includes(${JSON.stringify(text)}) || label === ${JSON.stringify(text)}
        })
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

  /** 带修饰键的点击：modifiers 1=Alt / 2=Ctrl / 8=Shift（用户 m05672 的 Alt 临时绘制） */
  async clickAtMod(x, y, modifiers) {
    const base = { x, y, button: 'left', clickCount: 1, modifiers }
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    await sleep(200)
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
  async pressKey(code, key = code, vk = 0, modifiers = 0) {
    const base = { code, key, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
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

  /* 右栏内三个页签（调节 / 分析 / 设置，用户 m02483）：读高亮页签判断当前在哪一页 */
  const sideViewNow = () =>
    cdp.eval(`(() => {
      const b = document.querySelector('.side-tabs button.on')
      const s = b ? (b.textContent || '').trim() : ''
      return s === '分析' ? 'analysis' : s === '设置' ? 'settings' : 'edit'
    })()`)
  const setSideView = async (view) => {
    for (let i = 0; i < 4; i++) {
      if ((await sideViewNow()) === view) return true
      const label = view === 'edit' ? '调节' : view === 'analysis' ? '分析' : '设置'
      await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('.side-tabs button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)})
        if (b) b.click()
      })()`)
      await sleep(220)
    }
    return (await sideViewNow()) === view
  }

  /* ── 顶栏悬浮提示：快（120ms）且"名称在前、说明在后"（用户 m02483） ── */
  const tipPos = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.toolbar button')].find((x) => (x.getAttribute('aria-label') || '') === '按键与鼠标操作')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (tipPos) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tipPos.x, y: tipPos.y, button: 'none', buttons: 0 })
  }
  await sleep(320) /* 原生 title 要约 1 秒后才弹；320ms 就出现说明是我们自己的提示 */
  const tip = await cdp.eval(`(() => {
    const el = document.querySelector('.tb-tip')
    if (!el) return null
    return {
      name: el.querySelector('.tb-tip-name')?.textContent || '',
      desc: el.querySelector('.tb-tip-desc')?.textContent || '',
      firstClass: el.firstElementChild?.className || '',
    }
  })()`)
  check('顶栏悬浮提示很快出现（320ms 内，不等原生 title）', !!tip, JSON.stringify(tip))
  check(
    '提示第一行是按钮名称、第二行是功能说明',
    !!tip && tip.name === '按键与鼠标操作' && tip.firstClass === 'tb-tip-name' && tip.desc.includes('快捷键'),
    JSON.stringify(tip),
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 420, button: 'none', buttons: 0 })
  await sleep(260)
  check('鼠标移开后提示立刻消失', await cdp.eval(`!document.querySelector('.tb-tip')`))

  /* ── 右栏控件也有同样的提示（用户 m02483） ── */
  check(
    '「调节」页里有调号列表和生成参数',
    await cdp.eval(`(() => {
      const t = document.querySelector('.side').textContent || ''
      const hasKeySelect = [...document.querySelectorAll('.side select')].some((s) =>
        [...s.options].some((o) => /大调/.test(o.textContent || '')),
      )
      return hasKeySelect && t.includes('调性分析') && t.includes('生成参数')
    })()`),
  )
  check(
    '三个页签都带图标',
    await cdp.eval(`(() => {
      const tabs = [...document.querySelectorAll('.side-tabs button')]
      return tabs.length === 3 && tabs.every((b) => !!b.querySelector('svg'))
    })()`),
  )
  check('右栏能切到「分析」页', await setSideView('analysis'))
  check(
    '「分析」页里有节奏与谐波（调号已挪到调节页）',
    await cdp.eval(`(() => {
      const t = document.querySelector('.side').textContent || ''
      return t.includes('节奏与谐波') && !t.includes('调性分析')
    })()`),
  )
  const sideTipPos = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.side button')].find((x) => (x.textContent || '').trim() === '节奏分析')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (sideTipPos) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sideTipPos.x, y: sideTipPos.y, button: 'none', buttons: 0 })
  }
  await sleep(320)
  const sideTip = await cdp.eval(`(() => {
    const el = document.querySelector('.tb-tip')
    if (!el) return null
    return { name: el.querySelector('.tb-tip-name')?.textContent || '', desc: el.querySelector('.tb-tip-desc')?.textContent || '' }
  })()`)
  check(
    '右栏按钮悬浮也弹名称+说明的提示',
    !!sideTip && sideTip.name === '节奏分析' && sideTip.desc.includes('拍点'),
    JSON.stringify(sideTip),
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 420, button: 'none', buttons: 0 })
  await sleep(200)
  await setSideView('edit')
  const chevInfo = await cdp.eval(`(() => {
    const el = document.querySelector('.side .group-head .chev')
    if (!el) return null
    const head = el.closest('.group-head')
    return { font: parseFloat(getComputedStyle(el).fontSize), headFont: parseFloat(getComputedStyle(head).fontSize) }
  })()`)
  check(
    '分组小三角够大（字号 ≥ 文字字号）',
    !!chevInfo && chevInfo.font >= 14 && chevInfo.font >= chevInfo.headFont,
    JSON.stringify(chevInfo),
  )
  const openBtnCls = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.toolbar button')].find((x) => (x.getAttribute('aria-label') || '') === '打开音频')
    return b ? b.className : null
  })()`)
  check('「打开音频」不再常高亮（去掉 primary）', !!openBtnCls && !openBtnCls.includes('primary'), String(openBtnCls))

  /* ── 吸附下拉从顶栏挪到右栏（用户 m02483） ── */
  const snapPlace = await cdp.eval(`(() => {
    const sideSel = [...document.querySelectorAll('.side select')].find((s) => [...s.options].some((o) => o.value === 'grid'))
    return {
      inBar: !!document.querySelector('.toolbar select'),
      side: !!sideSel,
      value: sideSel ? sideSel.value : null,
    }
  })()`)
  check('吸附下拉在右栏、顶栏不再有它', snapPlace.side && !snapPlace.inBar, JSON.stringify(snapPlace))
  const snapChanged = await cdp.eval(`(() => {
    const sel = [...document.querySelectorAll('.side select')].find((s) => [...s.options].some((o) => o.value === 'grid'))
    if (!sel) return null
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(sel, 'beat')
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return window.__bp.getState().snap
  })()`)
  check('右栏改吸附能写回状态', snapChanged === 'beat', String(snapChanged))
  await cdp.eval(`window.__bp.getState().setSnap('grid')`)
  await sleep(120)

  /* ── 画布上方那条"音符表 + 操作说明"已撤掉（用户 m02483：省空间） ── */
  check('音符表顶部不再占一条说明栏', await cdp.eval(`!document.querySelector('.pane-head')`))

  const segOn = (label) =>
    cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.seg button')].find((x) => ((x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')).includes(${JSON.stringify(label)}))
      return !!b && b.classList.contains('on')
    })()`)

  check('默认是选择模式（只试听，不会误画）', await segOn('选择'))
  check('点「绘制」能切到绘制模式', (await cdp.clickText('绘制')) && (await segOn('绘制')))
  check('点「选择」能切回选择模式', (await cdp.clickText('选择')) && (await segOn('选择')))

  const flagOn = (label) =>
    cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => ((x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')).trim().startsWith(${JSON.stringify(label)}))
      return !!b && b.classList.contains('on')
    })()`)
  check('「自动翻页」默认开着', await flagOn('自动翻页'))
  await cdp.clickText('自动翻页')
  check('点一下能关掉「自动翻页」', !(await flagOn('自动翻页')))
  await cdp.clickText('自动翻页')
  check('再点一下能开回来', await flagOn('自动翻页'))

  const loopDisabled = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => ((x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')).trim().startsWith('重复区间'))
    return !!b && b.disabled
  })()`)
  check('还没画重复区间时「重复区间」是灰的', loopDisabled)

  const disabled = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => ((x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')).includes('导出'))
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

  /* 顶栏「分析」按钮：用户 m00741 就是说点它没反应，这里至少守住入口在、有音频后能点 */
  const analyzeBtn = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.toolbar button')].find((x) => (x.getAttribute('aria-label') || '') === '分析')
    return b ? { disabled: b.disabled, title: b.title } : null
  })()`)
  check('顶栏有「分析」按钮（有音频时能点）', !!analyzeBtn && analyzeBtn.disabled === false, JSON.stringify(analyzeBtn))

  /* 方案（用户 m01794）：两个入口在；「保存方案」点了要真的写出一份 .bp.json。
   * 浏览器里没有磁盘路径，存到 localStorage 兜底（跟桌面壳的写文件走同一个序列化）。 */
  const projectBtns = await cdp.eval(`(() => {
    const q = (label) => [...document.querySelectorAll('.toolbar button')].find((x) => (x.getAttribute('aria-label') || '') === label)
    const save = q('保存方案')
    const open = q('打开方案')
    return { save: !!save, open: !!open, saveDisabled: save ? save.disabled : null }
  })()`)
  check('顶栏有「保存方案」「打开方案」按钮', projectBtns.save && projectBtns.open, JSON.stringify(projectBtns))
  check('没有音频路径时「保存方案」是灰的', projectBtns.saveDisabled === true)

  /* ── 两种保存（用户 m02483）：随时保存只写缓存，Ctrl+S 才写 .bp.json ──
   * 放在「保存方案」用例之前跑：那一条会留下"已存"时间，这里要验"只缓存、没已存"。 */
  const cacheOnly = await cdp.eval(`(async () => {
    const bp = window.__bp
    const path = '/tmp/cache-only.wav'
    localStorage.removeItem('bp.cache')
    localStorage.removeItem('bp.project:' + path + '.bp.json')
    bp.setState({ filePath: path, fileName: 'cache-only.wav' })
    /* 随便改一个参数：1.2 秒后应该只写缓存 */
    bp.getState().setGain(1.1)
    await new Promise((r) => setTimeout(r, 1800))
    const cacheText = localStorage.getItem('bp.cache')
    const projText = localStorage.getItem('bp.project:' + path + '.bp.json')
    const status = document.querySelector('.status')?.textContent || ''
    const cache = cacheText ? JSON.parse(cacheText) : null
    const out = {
      cache: !!cache,
      cachePath: cache ? cache.audio.path : null,
      cacheGain: cache ? cache.settings.gain : null,
      fileExists: !!projText,
      statusCache: status.includes('缓存'),
      statusSaved: status.includes('已存'),
    }
    bp.getState().setGain(1)
    return out
  })()`)
  check(
    '随时保存只写本机缓存、不生成 .bp.json',
    cacheOnly.cache &&
      cacheOnly.cachePath === '/tmp/cache-only.wav' &&
      Math.abs(cacheOnly.cacheGain - 1.1) < 1e-6 &&
      cacheOnly.fileExists === false,
    JSON.stringify(cacheOnly),
  )
  check(
    '状态栏这时只显示「缓存」、不显示「已存」',
    cacheOnly.statusCache === true && cacheOnly.statusSaved === false,
    JSON.stringify(cacheOnly),
  )

  await cdp.eval(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`)
  await cdp.pressKey('KeyS', 's', 83, 2) /* Ctrl+S */
  await sleep(400)
  const ctrlSaved = await cdp.eval(`(() => {
    const path = '/tmp/cache-only.wav'
    const text = localStorage.getItem('bp.project:' + path + '.bp.json')
    const status = document.querySelector('.status')?.textContent || ''
    const store = window.__bp.getState()
    window.__bp.setState({ filePath: null })
    return {
      saved: !!text,
      notes: text ? JSON.parse(text).notes.length : -1,
      stateNotes: store.notes.length,
      statusSaved: status.includes('已存'),
    }
  })()`)
  check(
    'Ctrl+S 才真正写出 .bp.json',
    ctrlSaved.saved && ctrlSaved.notes === ctrlSaved.stateNotes && ctrlSaved.statusSaved,
    JSON.stringify(ctrlSaved),
  )

  /* ── 保存状态：改了内容 → 橙点 + 保存按钮橙边；存盘 → 绿点（用户 m02483） ── */
  const readSaveState = () =>
    cdp.eval(`(() => {
      const dot = document.querySelector('.status .save-state')
      const btn = [...document.querySelectorAll('.toolbar button')].find((x) => (x.getAttribute('aria-label') || '') === '保存方案')
      return {
        cls: dot ? dot.className : null,
        text: dot ? (dot.textContent || '').trim() : null,
        btn: btn ? btn.className : null,
      }
    })()`)
  await cdp.eval(`(() => {
    const bp = window.__bp
    bp.setState({ filePath: '/tmp/dirty-test.wav', fileName: 'dirty-test.wav' })
    bp.getState().setTitle('dirty test')
  })()`)
  await sleep(300)
  const dirtyNow = await readSaveState()
  check(
    '有修改未保存：状态栏橙点「未保存」+ 保存按钮描橙边',
    dirtyNow.cls?.includes('dirty') && dirtyNow.text === '未保存' && dirtyNow.btn?.includes('dirty'),
    JSON.stringify(dirtyNow),
  )
  await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.toolbar button')].find((x) => (x.getAttribute('aria-label') || '') === '保存方案')
    if (b) b.click()
  })()`)
  await sleep(500)
  const cleanNow = await readSaveState()
  check(
    '存盘后：状态栏绿点「已保存」、保存按钮不再描橙边',
    cleanNow.cls?.includes('clean') && cleanNow.text === '已保存' && !cleanNow.btn?.includes('dirty'),
    JSON.stringify(cleanNow),
  )
  await cdp.eval(`(() => {
    window.__bp.getState().setTitle('爱扒谱导出')
    window.__bp.setState({ filePath: null })
  })()`)
  await sleep(200)

  const savedProj = await cdp.eval(`(async () => {
    const bp = window.__bp
    bp.setState({ filePath: '/tmp/probe.wav', fileName: 'probe.wav' })
    await new Promise((r) => setTimeout(r, 120))
    const b = [...document.querySelectorAll('.toolbar button')].find((x) => (x.getAttribute('aria-label') || '') === '保存方案')
    if (!b) return { err: 'no-button' }
    b.click()
    await new Promise((r) => setTimeout(r, 300))
    const text = localStorage.getItem('bp.project:/tmp/probe.wav.bp.json')
    const store = bp.getState()
    const out = {
      disabled: b.disabled,
      stored: !!text,
      storedNotes: text ? JSON.parse(text).notes.length : -1,
      stateNotes: store.notes.length,
    }
    bp.setState({ filePath: null })
    return out
  })()`)
  check(
    '「保存方案」按下后写出方案，音符数对得上',
    savedProj && savedProj.stored && savedProj.storedNotes === savedProj.stateNotes,
    JSON.stringify(savedProj),
  )

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
    const ROW_H = (window.__bpRoll && window.__bpRoll.rowH) || 14
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
      const ROW_H = (window.__bpRoll && window.__bpRoll.rowH) || 14, KEY_W = 66
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

  /* ── 选择模式下按住 Alt 临时当绘制用（用户 m05672） ── */
  await cdp.eval(`window.__bp.getState().setMode('select')`)
  await sleep(120)
  const altPt = await cdp.eval(`(() => {
    const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    return { x: r.x + r.width * 0.52, y: r.y + r.height * 0.42 }
  })()`)
  const altBefore = await cdp.eval(`window.__bp.getState().notes.length`)
  await cdp.clickAt(altPt.x, altPt.y) // 选择模式下普通点击：不加音
  const altPlain = await cdp.eval(`window.__bp.getState().notes.length`)
  await cdp.clickAtMod(altPt.x, altPt.y, 1) // Alt + 点击：当绘制用
  const altAfter = await cdp.eval(`window.__bp.getState().notes.length`)
  check('选择模式下点空白不加音', altPlain === altBefore, `${altBefore}→${altPlain}`)
  check('选择模式下按住 Alt 点空白就加音', altAfter === altBefore + 1, `${altPlain}→${altAfter}`)
  await cdp.eval(`window.__bp.getState().setMode('draw')`)

  /* ── 选择模式：能拖音符条 / 改时值，但不能画音 / 删音 / 改确认（用户 m02483） ──
   * 绘制模式的行为一条没动：照旧能画、能删、点一下改确认。 */
  await cdp.eval(`window.__bp.getState().setMode('select')`)
  await sleep(150)
  const tmpId = await cdp.eval(`window.__bp.getState().addNote({ midi: 62, startMs: 1200, endMs: 1700 })`)
  await sleep(200)
  const noteBoxSel = (id) =>
    cdp.eval(`(() => {
      const s = window.__bp.getState()
      const n = s.notes.find((x) => x.id === ${JSON.stringify(id)})
      if (!n) return null
      const c = document.querySelector('.pane.roll canvas')
      const r = c.getBoundingClientRect()
      const m = window.__bpRoll || {}
      const ROW_H = m.rowH || 14, RULER_H = m.rulerH || 36, KEY_W = 66
      const span = s.durationMs / s.view.zoom
      const xAt = (ms) => KEY_W + ((ms - s.view.panMs) / span) * (r.width - KEY_W)
      const y = RULER_H + (m.top - n.midi) * ROW_H + ROW_H / 2
      return {
        ox: r.x, oy: r.y, rowH: ROW_H,
        mid: { x: xAt((n.startMs + n.endMs) / 2), y },
        edge: { x: xAt(n.endMs) - 3, y },
      }
    })()`)

  const g1 = await noteBoxSel(tmpId)
  /* 光标：选择模式停在右缘也应该是左右箭头（以前只有绘制模式才给） */
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: g1.ox + g1.edge.x, y: g1.oy + g1.edge.y, button: 'none', buttons: 0,
  })
  await sleep(200)
  const edgeCursorSelect = await cdp.eval(`(() => {
    const c = document.querySelector('.pane.roll canvas')
    return c.style.cursor || getComputedStyle(c).cursor
  })()`)
  check('选择模式停在音符右缘也是左右箭头', edgeCursorSelect === 'ew-resize', edgeCursorSelect)

  await cdp.dragAt(g1.ox + g1.mid.x, g1.oy + g1.mid.y, g1.ox + g1.mid.x, g1.oy + g1.mid.y - g1.rowH, 6)
  await sleep(200)
  const afterSelectMove = await cdp.eval(`(() => {
    const n = window.__bp.getState().notes.find((x) => x.id === ${JSON.stringify(tmpId)})
    return n ? { midi: n.midi, startMs: n.startMs, endMs: n.endMs } : null
  })()`)
  check(
    '选择模式下拖着音符条能改音高',
    !!afterSelectMove && afterSelectMove.midi === 63,
    JSON.stringify(afterSelectMove),
  )

  const g2 = await noteBoxSel(tmpId)
  await cdp.dragAt(g2.ox + g2.edge.x, g2.oy + g2.edge.y, g2.ox + g2.edge.x + 40, g2.oy + g2.edge.y, 6)
  await sleep(200)
  const afterSelectResize = await cdp.eval(`(() => {
    const n = window.__bp.getState().notes.find((x) => x.id === ${JSON.stringify(tmpId)})
    return n ? { startMs: n.startMs, endMs: n.endMs } : null
  })()`)
  check(
    '选择模式下拖右缘能改时值',
    !!afterSelectResize && afterSelectMove && afterSelectResize.endMs > afterSelectMove.endMs + 20 &&
      afterSelectResize.startMs === afterSelectMove.startMs,
    `${JSON.stringify(afterSelectMove)} → ${JSON.stringify(afterSelectResize)}`,
  )

  /* 选择模式右键 = 不删 */
  const g3 = await noteBoxSel(tmpId)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: g3.ox + g3.mid.x, y: g3.oy + g3.mid.y, button: 'right', clickCount: 1, buttons: 2,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: g3.ox + g3.mid.x, y: g3.oy + g3.mid.y, button: 'right', clickCount: 1, buttons: 0,
  })
  await sleep(250)
  const aliveAfterRight = await cdp.eval(`window.__bp.getState().notes.some((x) => x.id === ${JSON.stringify(tmpId)})`)
  check('选择模式右键不会删音符', aliveAfterRight === true, String(aliveAfterRight))

  /* 选择模式点一下再按 Delete = 不删 */
  await cdp.clickAt(g3.ox + g3.mid.x, g3.oy + g3.mid.y)
  await cdp.pressKey('Delete', 'Delete', 46)
  await sleep(200)
  const aliveAfterDel = await cdp.eval(`window.__bp.getState().notes.some((x) => x.id === ${JSON.stringify(tmpId)})`)
  check('选择模式按 Delete 不删音符', aliveAfterDel === true, String(aliveAfterDel))

  /* 绘制模式右键 = 删（原有行为保持不变） */
  await cdp.eval(`window.__bp.getState().setMode('draw')`)
  await sleep(150)
  const g4 = await noteBoxSel(tmpId)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: g4.ox + g4.mid.x, y: g4.oy + g4.mid.y, button: 'right', clickCount: 1, buttons: 2,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: g4.ox + g4.mid.x, y: g4.oy + g4.mid.y, button: 'right', clickCount: 1, buttons: 0,
  })
  await sleep(250)
  const aliveAfterDrawRight = await cdp.eval(`window.__bp.getState().notes.some((x) => x.id === ${JSON.stringify(tmpId)})`)
  check('绘制模式右键仍然能删音符', aliveAfterDrawRight === false, String(aliveAfterDrawRight))
  /* 后面几个用例原来就在绘制模式下跑，这里保持原状态 */
  await cdp.eval(`window.__bp.getState().setMode('draw')`)
  await sleep(100)

  // 全选按钮：现在有音符了，它应该是可点的
  await cdp.clickText('全选')
  const allConf = await cdp.eval(`(() => {
    const n = window.__bp.getState().notes
    return n.length > 0 && n.every((x) => x.confirmed)
  })()`)
  check('点「全选」把所有音标成确认', allConf)

  /* 全不选 / 回到初稿都是"清谱"操作（用户 m02483）：先弹确认，并且留可恢复的快照。
   * 恢复快照要靠 buildProject，浏览器里得有 filePath 才建得出来。 */
  await cdp.eval(`window.__bp.setState({ filePath: '/tmp/probe.wav', fileName: 'probe.wav' })`)
  await cdp.clickText('全不选')
  await sleep(220)
  const askShown = await cdp.eval(`(() => {
    const m = document.querySelector('.modal-confirm')
    return m ? { title: m.querySelector('.modal-head strong')?.textContent || '', ok: m.querySelector('.modal-foot .primary')?.textContent || '' } : null
  })()`)
  check('点「全不选」先弹确认框', !!askShown && askShown.ok === '取消全部确认', JSON.stringify(askShown))
  check('确认框还开着时，音符没被清', await cdp.eval(`window.__bp.getState().notes.every((x) => x.confirmed)`))

  await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.modal-confirm .modal-foot button')].find((x) => (x.textContent || '').trim() === '取消')
    if (b) b.click()
  })()`)
  await sleep(200)
  const afterCancel = await cdp.eval(`({ conf: window.__bp.getState().notes.every((x) => x.confirmed), modal: !!document.querySelector('.modal-confirm') })`)
  check('点「取消」关掉确认框、确认状态不变', afterCancel.conf && !afterCancel.modal, JSON.stringify(afterCancel))

  await cdp.clickText('全不选')
  await sleep(180)
  await cdp.eval(`(() => { const b = document.querySelector('.modal-confirm .modal-foot .primary'); if (b) b.click() })()`)
  await sleep(260)
  const noneConf = await cdp.eval(`window.__bp.getState().notes.every((x) => !x.confirmed)`)
  check('点「全不选」能清回来', noneConf)
  check('清完之后状态栏有「恢复」入口', await cdp.eval(`!!document.querySelector('.status .link-btn')`))

  await cdp.eval(`document.querySelector('.status .link-btn').click()`)
  await sleep(220)
  const recoverAsk = await cdp.eval(`(() => { const m = document.querySelector('.modal-confirm'); return m ? m.querySelector('.modal-head strong')?.textContent : null })()`)
  check('点「恢复」也先确认', recoverAsk === '恢复上一次的谱？', String(recoverAsk))
  await cdp.eval(`(() => { const b = document.querySelector('.modal-confirm .modal-foot .primary'); if (b) b.click() })()`)
  await sleep(350)
  const recovered = await cdp.eval(`({
    all: window.__bp.getState().notes.every((x) => x.confirmed),
    link: !!document.querySelector('.status .link-btn'),
  })`)
  check('恢复后所有音又变回确认、恢复入口收起', recovered.all && !recovered.link, JSON.stringify(recovered))

  /* 回到初稿：确认框在，取消不动音符 */
  const beforeReset = await cdp.eval(`window.__bp.getState().notes.length`)
  await cdp.clickText('回到初稿')
  await sleep(220)
  const resetAsk = await cdp.eval(`(() => { const m = document.querySelector('.modal-confirm'); return m ? m.querySelector('.modal-head strong')?.textContent : null })()`)
  check('点「回到初稿」也先弹确认框', resetAsk === '丢掉手工改动，回到分析初稿？', String(resetAsk))
  await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.modal-confirm .modal-foot button')].find((x) => (x.textContent || '').trim() === '取消')
    if (b) b.click()
  })()`)
  await sleep(200)
  check('取消「回到初稿」后音符还在', (await cdp.eval(`window.__bp.getState().notes.length`)) === beforeReset)
  await cdp.eval(`window.__bp.setState({ filePath: null })`)

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

  // ── Shift+滚轮 = 左右平移；Ctrl+滚轮 = 横向缩放（用户 m06188 取消了 Shift+Alt） ──
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
  const CTRL = 2
  const beforePan = await cdp.eval(`({ ...window.__bp.getState().view })`)
  await wheel(CTRL, -120)
  await sleep(150)
  const afterZoom = await cdp.eval(`({ ...window.__bp.getState().view })`)
  check('Ctrl+滚轮 = 横向放大', afterZoom.zoom > beforePan.zoom, `zoom ${beforePan.zoom}→${afterZoom.zoom}`)
  /* 先放大才有的平移：zoom=1 时整首都在视野里，pan 只能是 0 */
  await wheel(SHIFT, 120)
  await sleep(150)
  const afterPan = await cdp.eval(`({ ...window.__bp.getState().view })`)
  check(
    'Shift+滚轮 = 左右平移（zoom 不变、pan 变大）',
    afterPan.panMs > afterZoom.panMs && afterPan.zoom === afterZoom.zoom,
    `pan ${Math.round(afterZoom.panMs)}→${Math.round(afterPan.panMs)} zoom ${afterPan.zoom}`,
  )

  // ── 键列右上角那把锁：锁上之后滚轮不再换音区（用户 m05515） ──
  const lockPt = await cdp.eval(`(() => {
    const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    return { x: r.x + 52, y: r.y + 18, gx: r.x + r.width * 0.6, gy: r.y + r.height * 0.5 }
  })()`)
  await cdp.eval(`window.__bp.getState().setLockPitch(false)`)
  await sleep(150)
  const topBefore = await cdp.eval(`window.__bpRoll.top`)
  await cdp.eval(`window.__bp.getState().setView({ ...window.__bp.getState().view, panMs: 300 })`)
  await sleep(150)
  const panBefore = await cdp.eval(`window.__bp.getState().view.panMs`)
  await cdp.clickAt(lockPt.x, lockPt.y) // 锁上
  await sleep(200)
  const lockedFlag = await cdp.eval(`window.__bp.getState().lockPitch`)
  await cdp.wheelAt(lockPt.gx, lockPt.gy, 120)
  await sleep(250)
  const topLocked = await cdp.eval(`window.__bpRoll.top`)
  const panLocked = await cdp.eval(`window.__bp.getState().view.panMs`)
  await cdp.clickAt(lockPt.x, lockPt.y) // 开锁
  await sleep(200)
  await cdp.wheelAt(lockPt.gx, lockPt.gy, 120)
  await sleep(250)
  const topFree = await cdp.eval(`window.__bpRoll.top`)
  check(
    '键列右上角的锁能锁住上下滚动（锁住时滚轮改横向平移）',
    lockedFlag === true &&
      topLocked === topBefore &&
      panLocked !== panBefore &&
      topFree !== topBefore,
    `顶行 ${topBefore} → 锁住 ${topLocked}（pan ${Math.round(panBefore)}→${Math.round(panLocked)}）→ 开锁 ${topFree}`,
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

  // ── 光标：选择模式是单手指，绘制模式是一支笔（用户 m02510）──
  const hoverPt = { x: ruler.ox + ruler.x1 + 40, y: ruler.y + 120 }
  const moveAway = async () => {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: hoverPt.x, y: hoverPt.y, button: 'none', buttons: 0,
    })
    await sleep(150)
  }
  await cdp.eval(`window.__bp.getState().setMode('select')`)
  await sleep(150)
  await moveAway()
  const cursorSelect = await cdp.eval(`document.querySelector('.pane.roll canvas').style.cursor`)
  check('选择模式下鼠标是单手指', cursorSelect === 'pointer', cursorSelect || '(空)')

  await cdp.eval(`window.__bp.getState().setMode('draw')`)
  await sleep(150)
  await moveAway()
  const cursorDraw = await cdp.eval(`document.querySelector('.pane.roll canvas').style.cursor`)
  check(
    '绘制模式下鼠标是一支笔',
    cursorDraw.startsWith('url("data:image/svg+xml'),
    cursorDraw ? cursorDraw.slice(0, 46) : '(空)',
  )
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
  await cdp.eval(`document.querySelector('.toolbar .side-toggle').click()`)
  await sleep(200)
  const sideOff = await cdp.eval(`(() => { const el = document.querySelector('.side'); return !el || el.classList.contains('off') })()`)
  const rollWOff = await cdp.eval(`document.querySelector('.pane.roll').getBoundingClientRect().width`)
  await cdp.eval(`document.querySelector('.toolbar .side-toggle').click()`)
  await sleep(200)
  const sideBack = await cdp.eval(`(() => { const el = document.querySelector('.side'); return !!el && !el.classList.contains('off') })()`)
  check('右侧栏默认展开、点图标能收起、再点能展开', sideOn && sideOff && sideBack)
  check('收起右侧栏后主区变宽', rollWOff > rollWOn + 100, `${Math.round(rollWOn)} → ${Math.round(rollWOff)}`)

  /* Ctrl+] = 收起 / 展开右栏（用户 m02483） */
  await cdp.eval(`(() => { const el = document.querySelector('.side'); if (el && el.classList.contains('off')) document.querySelector('.toolbar .side-toggle').click() })()`)
  await sleep(250)
  await cdp.pressKey('BracketRight', ']', 221, 2)
  await sleep(250)
  const hotkeyOff = await cdp.eval(`(() => { const el = document.querySelector('.side'); return !!el && el.classList.contains('off') })()`)
  check('Ctrl+] 能收起右侧栏', hotkeyOff === true, String(hotkeyOff))
  await cdp.pressKey('BracketRight', ']', 221, 2)
  await sleep(250)
  const hotkeyOn = await cdp.eval(`(() => { const el = document.querySelector('.side'); return !!el && !el.classList.contains('off') })()`)
  check('再按 Ctrl+] 能展开右侧栏', hotkeyOn === true, String(hotkeyOn))

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
   * 这两个滑条一开始"看着没效果"，因为绘制 effect 的依赖漏了它们（不会重绘）。
   * 它们现在在「设置」页的「显示」组里（用户 m02483）。 */
  check('右栏能切到「设置」页', await setSideView('settings'))
  check(
    '「设置」页里有显示组、没有生成参数',
    await cdp.eval(`(() => {
      const t = document.querySelector('.side').textContent || ''
      return t.includes('行高') && t.includes('屏宽') && !t.includes('生成参数')
    })()`),
  )
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

  /* ── 右侧栏滑条：鼠标在上面滚轮就调它，且不滚右栏（用户 m05454） ── */
  const wheelBox = await cdp.eval(`(() => {
    const side = document.querySelector('.side')
    const label = [...side.querySelectorAll('label.field')].find((l) => l.textContent.includes('倍率'))
    const el = label && label.querySelector('input[type=range]')
    if (!el) return null
    /* 先把右栏滚下去一点（能滚的话），这样"滚轮不带动右栏"才验得出来；顺序要紧：先滚再取坐标 */
    side.scrollTop = Math.min(60, Math.max(0, side.scrollHeight - side.clientHeight))
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, scrollTop: side.scrollTop }
  })()`)
  const gainBefore = await cdp.eval(`window.__bp.getState().gain`)
  if (wheelBox) await cdp.wheelAt(wheelBox.x, wheelBox.y, 120) // 往下滚 = 减
  await sleep(250)
  const afterWheel = await cdp.eval(`(() => {
    const s = window.__bp.getState()
    return { gain: s.gain, scrollTop: document.querySelector('.side').scrollTop }
  })()`)
  check(
    '右栏滑条能被滚轮调、且不滚动右栏',
    !!wheelBox && afterWheel.gain < gainBefore && afterWheel.scrollTop === wheelBox.scrollTop,
    `gain ${gainBefore}→${afterWheel.gain}、scrollTop ${wheelBox?.scrollTop}→${afterWheel.scrollTop}`,
  )
  await cdp.eval(`window.__bp.getState().setGain(1)`)

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
  await setSideView('edit')

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

  /* ── 滚轮不用先点画布：Ctrl 悬停就能缩放 ── */
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setView({ zoom: 1, panMs: 0 }); s.setLoop(null) })()`)
  await sleep(150)
  await cdp.wheelAt(rollBox.x, rollBox.y, -120, 2)
  await sleep(250)
  const zoomAfterWheel = await cdp.eval(`window.__bp.getState().view.zoom`)
  check('鼠标悬停直接滚（Ctrl）就能缩放', zoomAfterWheel > 1, `zoom=${zoomAfterWheel}`)

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

  /* ── 时间轴 / 键区锁的操作提示（用户 m02483） ── */
  const rulerTip = await cdp.eval(`(() => {
    const el = document.querySelector('.canvas-tip')
    return el ? { name: el.querySelector('strong')?.textContent || '', desc: el.querySelector('span')?.textContent || '' } : null
  })()`)
  check(
    '时间轴上有操作提示（拖圈区间 / 点挪播放头）',
    !!rulerTip && rulerTip.name === '时间轴' && rulerTip.desc.includes('播放区间'),
    JSON.stringify(rulerTip),
  )

  const lockPoint = await cdp.eval(`(() => {
    const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    return { x: r.x + 54, y: r.y + 18 }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lockPoint.x, y: lockPoint.y, button: 'none' })
  await sleep(220)
  const lockTip = await cdp.eval(`(() => {
    const el = document.querySelector('.canvas-tip')
    return el ? { name: el.querySelector('strong')?.textContent || '', desc: el.querySelector('span')?.textContent || '' } : null
  })()`)
  check(
    '键区锁上有操作提示（锁住后滚轮改平移）',
    !!lockTip && lockTip.name.includes('键区锁') && lockTip.desc.includes('滚轮'),
    JSON.stringify(lockTip),
  )

  /* ── 音名·简谱信息牌跟着鼠标走，且不再带"（点一下试听）" ── */
  const badgeAt = (fx, fy) =>
    cdp.eval(`(() => {
      const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
      const el = document.querySelector('.row-badge')
      const cv = document.querySelector('.pane.roll canvas')
      return { left: el ? el.style.left : null, top: el ? el.style.top : null, text: el ? el.textContent : null,
        x: r.x + r.width * ${fx}, y: r.y + r.height * ${fy}, cx: cv.getBoundingClientRect().x, cy: cv.getBoundingClientRect().y }
    })()`)
  const b1 = await badgeAt(0.4, 0.5)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b1.x, y: b1.y, button: 'none' })
  await sleep(200)
  const badge1 = await badgeAt(0.4, 0.5)
  const p2 = await badgeAt(0.66, 0.62)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p2.x, y: p2.y, button: 'none' })
  await sleep(200)
  const badge2 = await badgeAt(0.66, 0.62)
  check(
    '音名·简谱信息牌跟着鼠标走',
    !!badge1.left && !!badge2.left && badge1.left !== badge2.left && badge1.top !== badge2.top,
    `( ${badge1.left},${badge1.top} ) → ( ${badge2.left},${badge2.top} )`,
  )
  check(
    '信息牌里不再有"（点一下试听）"',
    !!badge2.text && badge2.text.includes('·') && !badge2.text.includes('点一下试听'),
    String(badge2.text),
  )

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
    const ROW_H = (window.__bpRoll && window.__bpRoll.rowH) || 14, KEY_W = 66
    const rulerH = typeof m.rulerH === 'number' ? m.rulerH : 36
    const BLACK = new Set([1, 3, 6, 8, 10])
    /* 挑中间附近的白键行：黑键行的左半边本来就不会变色，拿它验不出来 */
    let row = Math.floor((m.rows || 20) / 2)
    for (let i = row; i < (m.rows || 20); i++) {
      if (!BLACK.has((((m.top - i) % 12) + 12) % 12)) { row = i; break }
    }
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
    const ROW_H = (window.__bpRoll && window.__bpRoll.rowH) || 14, KEY_W = 66
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

  /* ── 白键高亮要按 L/J/T 的形状，不是矩形（用户 m05078） ──
   * 取一个 D（两个黑键之间的白键，T 形）：在它竖直中心上方半格处，左边白区应变黄、
   * 右边黑键那块仍是黑的；在本格中心，左右两边都应是黄的。 */
  const shapePt = await cdp.eval(`(() => {
    const c = document.querySelector('.pane.roll canvas')
    const r = c.getBoundingClientRect()
    const m = window.__bpRoll
    const ROW_H = (window.__bpRoll && window.__bpRoll.rowH) || 14
    /* 从顶行往下找一个 D（音级 2） */
    let midi = null
    for (let d = 0; d < (m.rows || 20); d++) {
      const mm = m.top - d
      if (((mm % 12) + 12) % 12 === 2) { midi = mm; break }
    }
    if (midi === null) return null
    const rowTop = m.rulerH + (m.top - midi) * ROW_H
    return {
      midi,
      x: r.x + r.width * 0.5,
      yMid: r.y + rowTop + ROW_H / 2,
      yAbove: r.y + rowTop - ROW_H / 4,
      sx: c.width / parseFloat(c.style.width || String(c.width)),
      sy: c.height / parseFloat(c.style.height || String(c.height)),
      rowTop,
    }
  })()`)
  if (shapePt) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: shapePt.x, y: shapePt.yMid, button: 'none', buttons: 0 })
    await sleep(250)
    const shapePx = await cdp.eval(`(() => {
      const c = document.querySelector('.pane.roll canvas')
      const g = c.getContext('2d')
      const sx = ${shapePt.sx}, sy = ${shapePt.sy}
      const pick = (wx, wy) => { const d = g.getImageData(Math.round(wx * sx), Math.round(wy * sy), 1, 1).data; return [d[0], d[1], d[2]] }
      return {
        armLeft: pick(6, ${shapePt.rowTop} - 3.5),
        armRight: pick(58, ${shapePt.rowTop} - 3.5),
        midLeft: pick(6, ${shapePt.rowTop} + 7),
        midRight: pick(58, ${shapePt.rowTop} + 7),
      }
    })()`)
    const yellowish = (c) => c[0] > 220 && c[1] > 150 && c[1] < 215 && c[2] < 110
    check('白键高亮是 T 形：上半格只有左边变黄（右边是黑键）',
      yellowish(shapePx.armLeft) && !yellowish(shapePx.armRight),
      `左 ${shapePx.armLeft}、右 ${shapePx.armRight}`)
    /* 左边那格在本格中心常常压着简谱数字的字（抗锯齿会把它压暗），所以只断言右侧"脚"是黄的 */
    check('白键高亮是 T 形：本格右侧那截也变黄',
      yellowish(shapePx.midRight),
      `左 ${shapePx.midLeft}（可能压着数字）、右 ${shapePx.midRight}`)
  } else {
    check('白键高亮是 T 形：上半格只有左边变黄（右边是黑键）', false, '没找到 D 行')
    check('白键高亮是 T 形：本格右侧那截也变黄', false, '没找到 D 行')
  }
  /* ── 新画的音 = 最小绘制格（十六分音符 = 1/4 拍，用户 m04380） ── */
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setMode('draw'); s.setLoop(null); s.setLoopOn(false); s.setBpm(120); s.setView({ zoom: 1, panMs: 0 }) })()`)
  await sleep(200)
  const gridPt = await cdp.eval(`(() => {
    const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    const m = window.__bpRoll || {}
    const rulerH = typeof m.rulerH === 'number' ? m.rulerH : 36
    const ROW_H = (window.__bpRoll && window.__bpRoll.rowH) || 14
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
    const ROW_H = (window.__bpRoll && window.__bpRoll.rowH) || 14
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
    const ROW_H = (window.__bpRoll && window.__bpRoll.rowH) || 14
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

  /* ── 音符右缘光标 / 上下拖改音高 / 方向键改音高 / 撤销（用户 m05780、m05736） ── */
  const noteId = await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.setMode('draw')
    const id = s.addNote({ midi: 64, startMs: 1000, endMs: 1600 })
    s.endEdit()
    return id
  })()`)
  await sleep(200)
  const noteGeo = await cdp.eval(`(() => {
    const st = window.__bp.getState()
    const m = window.__bpRoll
    const r = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    const n = st.notes.find((x) => x.id === ${JSON.stringify(noteId)})
    const span = st.durationMs / st.view.zoom
    const xOf = (ms) => r.x + m.left + ((ms - st.view.panMs) / span) * (r.width - m.left)
    const yOf = (midi) => r.y + m.rulerH + (m.top - midi) * 14 + 7
    return { x0: xOf(n.startMs), x1: xOf(n.endMs), y: yOf(n.midi), midi: n.midi }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: noteGeo.x1 - 3,
    y: noteGeo.y,
    button: 'none',
    buttons: 0,
  })
  await sleep(200)
  const edgeCursor = await cdp.eval(`document.querySelector('.pane.roll canvas').style.cursor`)
  check('鼠标停在音符右缘时是左右箭头', edgeCursor === 'ew-resize', edgeCursor)

  await cdp.dragAt(noteGeo.x0 + 20, noteGeo.y, noteGeo.x0 + 20, noteGeo.y - 28, 6) // 往上拖两行
  await sleep(200)
  const draggedMidi = await cdp.eval(
    `window.__bp.getState().notes.find((n) => n.id === ${JSON.stringify(noteId)})?.midi`,
  )
  check('上下拖音符改音高', draggedMidi === noteGeo.midi + 2, `${noteGeo.midi}→${draggedMidi}`)

  await cdp.clickAt(noteGeo.x0 + 20, noteGeo.y - 28) // 选中它（不拖 = 切确认，但选中是副作用）
  await cdp.pressKey('ArrowUp', 'ArrowUp', 38)
  const midiAfterKey = await cdp.eval(
    `window.__bp.getState().notes.find((n) => n.id === ${JSON.stringify(noteId)})?.midi`,
  )
  check('方向键上 = 升半音', midiAfterKey === draggedMidi + 1, `${draggedMidi}→${midiAfterKey}`)

  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    code: 'KeyZ',
    key: 'z',
    modifiers: 2,
    windowsVirtualKeyCode: 90,
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    code: 'KeyZ',
    key: 'z',
    modifiers: 2,
    windowsVirtualKeyCode: 90,
  })
  await sleep(250)
  const undoAfterKey = await cdp.eval(
    `window.__bp.getState().notes.find((n) => n.id === ${JSON.stringify(noteId)})?.midi`,
  )
  check('Ctrl+Z 撤销方向键那一步', undoAfterKey === draggedMidi, `${midiAfterKey}→${undoAfterKey}`)

  /* 工具条上的撤销按钮：有历史时可点，点一下真的回退 */
  const beforeBtn = await cdp.eval(`window.__bp.getState().notes.length`)
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.addNote({ midi: 55, startMs: 2400, endMs: 2600 }); s.endEdit() })()`)
  await cdp.clickText('撤销')
  await sleep(200)
  const afterBtn = await cdp.eval(`window.__bp.getState().notes.length`)
  check('工具条的撤销按钮能回退一步', afterBtn === beforeBtn, `${beforeBtn + 1}→${afterBtn}`)
  await cdp.eval(`window.__bp.setState({ history: [] })`)
  await sleep(150)
  const undoDisabled = await cdp.eval(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').trim() === '撤销' || x.textContent.trim() === '撤销'); return !!b && b.disabled })()`,
  )
  check('没有历史时撤销按钮是灰的', undoDisabled === true, String(undoDisabled))
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setMode('select') })()`)
  await sleep(150)

  /* ── 撤销 / 重做（用户 m05893：撤销提到 200 步，并加重做） ── */
  await cdp.eval(`window.__bp.setState({ notes: [], history: [], future: [], selectedId: null })`)
  await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.addNote({ midi: 62, startMs: 0, endMs: 250 })
    s.addNote({ midi: 64, startMs: 250, endMs: 500 })
  })()`)
  await sleep(200)
  await cdp.clickText('撤销')
  await sleep(200)
  const undoCaseN = await cdp.eval(`({ n: window.__bp.getState().notes.length, f: window.__bp.getState().future.length })`)
  check('点「撤销」少一个音、并且进了重做栈', undoCaseN.n === 1 && undoCaseN.f === 1, JSON.stringify(undoCaseN))
  await cdp.clickText('重做')
  await sleep(200)
  const redoCaseN = await cdp.eval(`({ n: window.__bp.getState().notes.length, f: window.__bp.getState().future.length })`)
  check('点「重做」把音补回来、重做栈清空', redoCaseN.n === 2 && redoCaseN.f === 0, JSON.stringify(redoCaseN))

  /* ── 回开头 / Ctrl+左右跳小节 ── */
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setLoop(null); s.setLoopOn(false); s.setCurrentMs(1700) })()`)
  await sleep(120)
  await cdp.clickText('回到开头')
  await sleep(200)
  const atStart = await cdp.eval(`window.__bp.getState().currentMs`)
  check('点「回到开头」播放头回 0', atStart < 60, String(Math.round(atStart)))

  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setLoop({ startMs: 800, endMs: 2400 }); s.setLoopOn(true); s.setCurrentMs(2000) })()`)
  await sleep(120)
  await cdp.clickText('回到开头')
  await sleep(200)
  const atLoopStart = await cdp.eval(`window.__bp.getState().currentMs`)
  check('有播放区时「回到开头」回区间开头', Math.abs(atLoopStart - 800) < 60, String(Math.round(atLoopStart)))

  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setLoop(null); s.setLoopOn(false); s.setBpm(120); s.setBeatsPerBar(4); s.setFirstBeatMs(0); s.setCurrentMs(100) })()`)
  await sleep(120)
  /* 一小节 = 4 拍 @120bpm = 2000ms；从第 0 小节往后跳应落在 2000ms */
  await cdp.pressKey('ArrowRight', 'ArrowRight', 39, 2)
  await sleep(220)
  const afterBarJump = await cdp.eval(`window.__bp.getState().currentMs`)
  check('Ctrl+→ 往后跳一个小节', Math.abs(afterBarJump - 2000) < 90, String(Math.round(afterBarJump)))
  await cdp.pressKey('ArrowLeft', 'ArrowLeft', 37, 2)
  await sleep(220)
  const afterBarBack = await cdp.eval(`window.__bp.getState().currentMs`)
  check('Ctrl+← 往回跳一个小节', Math.abs(afterBarBack - 0) < 90, String(Math.round(afterBarBack)))

  /* 弱起 1 拍：第 1 小节只有 1 拍（0…500ms），第 2 小节从 500ms 起。
     从 100ms 按 Ctrl+→ 应落在 500ms，而不是整小节的 2000ms（adj-pickup）。 */
  await cdp.eval(`(() => { const s = window.__bp.getState(); s.setPickupBeats(1); s.setCurrentMs(100) })()`)
  await sleep(120)
  await cdp.pressKey('ArrowRight', 'ArrowRight', 39, 2)
  await sleep(220)
  const afterPickupJump = await cdp.eval(`window.__bp.getState().currentMs`)
  check('弱起 1 拍时 Ctrl+→ 跳到第 2 小节起点', Math.abs(afterPickupJump - 500) < 90, String(Math.round(afterPickupJump)))
  await cdp.eval(`window.__bp.getState().setPickupBeats(0)`)
  await sleep(120)

  /* ── 同音高、同一时刻两个音：上下错开，点上半 / 下半要能分别选中、分别删（用户 m00741） ── */
  const laneSetup = async () => cdp.eval(`(() => {
    const bp = window.__bp, st = bp.getState()
    st.setLoaded({ fileName: 'probe.wav', filePath: null, durationMs: 4000 })
    const frames = 200, bins = 88
    st.setAnalysis({
      durationMs: 4000, sampleRate: 44100,
      spectrum: { frames, hopMs: 20, sampleRate: 44100, data: new Float32Array(frames * bins), frameRms: new Float32Array(frames).fill(0.1) },
      notes: [
        { id: 'dup0', midi: 67, startMs: 1000, endMs: 1500, velocity: 0.8, confirmed: false },
        { id: 'dup1', midi: 67, startMs: 1000, endMs: 1500, velocity: 0.8, confirmed: false },
      ],
      bpm: 120, firstBeatMs: 0,
      keyCandidates: [{ tonic: 0, share: 1 }],
    })
    st.setAllConfirmed(true)
    st.setView({ zoom: 1, panMs: 0 })
    /* 删音只在绘制模式（用户 m02483）；这里原来靠选择模式删，现在按新规矩切绘制 */
    st.setMode('draw')
    return bp.getState().notes.length
  })()`)
  const laneCount = await laneSetup()
  check('同一音高同一时刻的两个音都在（假分析）', laneCount === 2, String(laneCount))
  /* 点的 y 落在行内 1/4（上半 → 车道 0）或 3/4（下半 → 车道 1）；x 取两个音的中点 */
  const lanePoint = async (frac) => cdp.eval(`(() => {
    const s = window.__bp.getState()
    const m = window.__bpRoll || {}
    const ROW_H = (window.__bpRoll && window.__bpRoll.rowH) || 14, KEY_W = 66
    const RULER_H = typeof m.rulerH === 'number' ? m.rulerH : 36
    const top = typeof m.top === 'number' ? m.top : 76
    const c = document.querySelector('.pane.roll canvas')
    const r = c.getBoundingClientRect()
    const span = s.durationMs / s.view.zoom
    const x = KEY_W + ((1250 - s.view.panMs) / span) * (r.width - KEY_W)
    const y = RULER_H + (top - 67) * ROW_H + ROW_H * ${frac}
    return { x: r.x + x, y: r.y + y }
  })()`)
  const pTop = await lanePoint(0.25)
  await cdp.clickAt(pTop.x, pTop.y)
  await sleep(160)
  await cdp.pressKey('Delete', 'Delete', 46)
  await sleep(200)
  const leftTop = await cdp.eval(`window.__bp.getState().notes.map((n) => n.id)`)
  check(
    '点重叠音的上半再删 → 删的是上面那条（dup0）',
    Array.isArray(leftTop) && leftTop.length === 1 && leftTop[0] === 'dup1',
    JSON.stringify(leftTop),
  )

  await laneSetup()
  const pBot = await lanePoint(0.75)
  await cdp.clickAt(pBot.x, pBot.y)
  await sleep(160)
  await cdp.pressKey('Delete', 'Delete', 46)
  await sleep(200)
  const leftBot = await cdp.eval(`window.__bp.getState().notes.map((n) => n.id)`)
  check(
    '点重叠音的下半再删 → 删的是下面那条（dup1）',
    Array.isArray(leftBot) && leftBot.length === 1 && leftBot[0] === 'dup0',
    JSON.stringify(leftBot),
  )

  /* ── 顶栏：文件组在最前、播放居中、右侧图标不画框（用户 m02483 第 5/6/7 条） ── */
  const tb = await cdp.eval(`(() => {
    const bar = document.querySelector('.toolbar')
    const left = bar.querySelector('.tb-left')
    const right = bar.querySelector('.tb-right')
    const byLabel = (root, label) => [...root.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === label)
    const groups = left ? [...left.querySelectorAll(':scope > span.tgroup')] : []
    const fileGroup = groups[0]
    const br = bar.getBoundingClientRect()
    const play = bar.querySelector('.play-btn')
    const pr = play ? play.getBoundingClientRect() : null
    const utils = [...bar.querySelectorAll('.tb-util .icon-btn')].map((b) => {
      const cs = getComputedStyle(b)
      return { borderColor: cs.borderTopColor, bg: cs.backgroundColor }
    })
    return {
      left: !!left,
      right: !!right,
      fileFirst: !!fileGroup && !!byLabel(fileGroup, '打开音频') && !!byLabel(fileGroup, '打开方案') &&
        !!byLabel(fileGroup, '保存方案') && !!byLabel(fileGroup, '导出 .jps'),
      scoreGroup: !!byLabel(left || bar, '分析') && !!byLabel(left || bar, '和弦分析'),
      playW: pr ? pr.width : 0,
      playDx: pr ? Math.abs(pr.x + pr.width / 2 - (br.x + br.width / 2)) : 999,
      utilCount: utils.length,
      utilBordered: utils.filter((u) => u.borderColor !== 'rgba(0, 0, 0, 0)').length,
      utilFilled: utils.filter((u) => u.bg !== 'rgba(0, 0, 0, 0)').length,
      utilOrder: [...bar.querySelectorAll('.tb-util .icon-btn')].map((b) => b.getAttribute('aria-label')),
    }
  })()`)
  check('顶栏分左右两簇，播放键单独在中间', tb.left && tb.right, JSON.stringify(tb))
  check('文件操作组排在第一位（打开音频/打开方案/保存方案/导出）', tb.fileFirst)
  check('判音/谱音组里有「分析」「和弦分析」', tb.scoreGroup)
  check(
    '播放键比图标按钮大、在顶栏正中',
    tb.playW >= 44 && tb.playDx <= 2,
    `宽 ${tb.playW}、偏移 ${tb.playDx.toFixed(1)}px`,
  )
  check(
    '右侧两颗图标按钮（帮助 + 侧栏）不画外框线',
    tb.utilCount === 2 && tb.utilBordered === 0 && tb.utilFilled === 0,
    JSON.stringify(tb),
  )
  check(
    '右上角只剩帮助 + 侧栏两颗图标',
    Array.isArray(tb.utilOrder) &&
      tb.utilOrder[0] === '按键与鼠标操作' &&
      /右侧栏/.test(tb.utilOrder[1] || ''),
    JSON.stringify(tb.utilOrder),
  )

  /* ── 行高滑条 / 屏宽滑条（用户 m02483 第 1、2 条）：在「设置」页的「显示」组里 ── */
  await setSideView('settings')
  const rowSlider = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.side input[type=range]')].find((x) => x.min === '10' && x.max === '26')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, value: Number(el.value), rollH: window.__bpRoll.rowH }
  })()`)
  check(
    '「显示」里有行高滑条（10–26px，默认 14）',
    !!rowSlider && rowSlider.value === 14 && rowSlider.rollH === 14,
    JSON.stringify(rowSlider),
  )
  if (rowSlider) await cdp.wheelAt(rowSlider.x, rowSlider.y, 120) /* 往下滚 = 变矮一格 */
  await sleep(250)
  const afterRowH = await cdp.eval(`({
    rowH: window.__bp.getState().rowH,
    rollH: window.__bpRoll.rowH,
    saved: localStorage.getItem('bp.rowH'),
  })`)
  check(
    '滚轮调行高：表格与键盘格跟着变',
    afterRowH.rowH < 14 && afterRowH.rollH === afterRowH.rowH,
    JSON.stringify(afterRowH),
  )
  check('行高记进 localStorage（重开能恢复）', afterRowH.saved === String(afterRowH.rowH), String(afterRowH.saved))
  await cdp.eval(`window.__bp.getState().setRowH(14)`)
  await sleep(150)

  const pageSlider = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.side input[type=range]')].find((x) => x.min === '2' && x.max === '60')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, value: Number(el.value) }
  })()`)
  check('「显示」里有屏宽滑条（2–60 秒）', !!pageSlider, JSON.stringify(pageSlider))
  const zoomBeforePage = await cdp.eval(`window.__bp.getState().view.zoom`)
  if (pageSlider) await cdp.wheelAt(pageSlider.x, pageSlider.y, 120) /* 往下滚 = 一屏变窄 */
  await sleep(250)
  const afterPage = await cdp.eval(`(() => {
    const s = window.__bp.getState()
    return { pageSec: s.pageSec, zoom: s.view.zoom, span: s.durationMs / s.view.zoom, saved: localStorage.getItem('bp.pageSec') }
  })()`)
  check(
    '滚轮调屏宽：一屏秒数变小、zoom 变大',
    afterPage.pageSec < 20 && afterPage.zoom > zoomBeforePage,
    `pageSec ${afterPage.pageSec}s、zoom ${zoomBeforePage}→${afterPage.zoom}`,
  )
  check(
    '屏宽换算自洽：一屏正好 pageSec 秒',
    Math.abs(afterPage.span - afterPage.pageSec * 1000) < 60,
    `一屏 ${Math.round(afterPage.span)}ms、pageSec ${afterPage.pageSec}s`,
  )
  check('屏宽记进 localStorage（重开能恢复）', afterPage.saved === String(afterPage.pageSec), String(afterPage.saved))

  /* ── 所有滑条都能"鼠标悬浮滚轮"调（用户 m02483 追加要求） ──
   * 逐条滚一下：值必须真的变；行高那条还要试"指着整行文字滚"（命中区放宽到 label.field）。 */
  const sliders = await cdp.eval(`(() => {
    return [...document.querySelectorAll('.side input[type=range]')].filter((el) => !el.disabled).map((el) => {
      const r = el.getBoundingClientRect()
      const lab = el.closest('label.field')
      const lr = lab ? lab.getBoundingClientRect() : r
      const labelText = lab ? (lab.textContent || '').trim().slice(0, 6) : ''
      return {
        key: (lab ? (lab.textContent || '').trim().slice(0, 2) : String(el.min)),
        value: Number(el.value), min: Number(el.min), max: Number(el.max),
        track: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
        label: { x: lr.x + 18, y: lr.y + lr.height / 2 },
      }
    })
  })()`)
  const sliderBefore = sliders.map((s) => s.value)
  for (const s of sliders) {
    /* 值已经在顶就往回滚，否则往上滚（滚轮向下 = 减一格） */
    const deltaY = s.value >= s.max ? 120 : -120
    await cdp.wheelAt(s.track.x, s.track.y, deltaY)
    await sleep(150)
  }
  const sliderAfter = await cdp.eval(`[...document.querySelectorAll('.side input[type=range]')].filter((el) => !el.disabled).map((el) => Number(el.value))`)
  const stuck = sliders.map((s, i) => (sliderAfter[i] === sliderBefore[i] ? s.key : null)).filter(Boolean)
  check(
    `设置页 ${sliders.length} 条滑条全都能悬浮滚轮调`,
    sliders.length >= 4 && stuck.length === 0,
    `没动：${stuck.join('、') || '无'}（前：${sliderBefore.join(',')}）`,
  )

  /* 分析页里那条「去谐波」滑条也要能滚 */
  await setSideView('analysis')
  const harmSlider = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.side input[type=range]')].find((x) => x.min === '0' && x.max === '1')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, before: Number(el.value) }
  })()`)
  if (harmSlider) await cdp.wheelAt(harmSlider.x, harmSlider.y, harmSlider.before >= 1 ? 120 : -120)
  await sleep(220)
  const harmAfter = await cdp.eval(`window.__bp.getState().suppress`)
  check(
    '分析页的「去谐波」滑条也能悬浮滚轮调',
    !!harmSlider && harmAfter !== harmSlider.before,
    `${harmSlider?.before} → ${harmAfter}`,
  )

  /* 行高那条：鼠标指在"行高 14px"这行文字上滚，也要能调（命中区是整行） */
  await setSideView('settings')
  const rowLabelWheel = await cdp.eval(`(() => {
    const el = document.querySelector('.side input[type=range][min="10"][max="26"]')
    if (!el) return null
    const lab = el.closest('label.field')
    const r = lab.getBoundingClientRect()
    return { x: r.x + 16, y: r.y + r.height / 2, before: Number(el.value) }
  })()`)
  if (rowLabelWheel) {
    await cdp.wheelAt(rowLabelWheel.x, rowLabelWheel.y, rowLabelWheel.before >= 26 ? 120 : -120)
    await sleep(200)
  }
  const rowAfterLabelWheel = await cdp.eval(`(() => {
    const el = document.querySelector('.side input[type=range][min="10"][max="26"]')
    return el ? Number(el.value) : null
  })()`)
  check(
    '指着「行高」这行文字滚轮也能调（不用精确对准轨道）',
    !!rowLabelWheel && rowAfterLabelWheel !== rowLabelWheel.before,
    `${rowLabelWheel?.before} → ${rowAfterLabelWheel}`,
  )
  /* 收尾：把滑条调回默认，别影响后面的用例 */
  await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.setRowH(14)
    s.setPageSec(20)
    s.setGain(1)
    s.setContrast(1.4)
    s.setSuppress(0)
  })()`)
  await sleep(200)
  await setSideView('edit')

  /* ── 表格顶行记在 store / localStorage（用户 m02483 第 4 条） ── */
  const topInfo = await cdp.eval(`(() => {
    const c = document.querySelector('.pane.roll canvas').getBoundingClientRect()
    return { top: window.__bpRoll.top, stored: window.__bp.getState().topMidi, x: c.x + c.width * 0.5, y: c.y + c.height * 0.5 }
  })()`)
  await cdp.wheelAt(topInfo.x, topInfo.y, 120)
  await sleep(250)
  const afterTop = await cdp.eval(`({
    top: window.__bpRoll.top,
    stored: window.__bp.getState().topMidi,
    saved: localStorage.getItem('bp.topMidi'),
  })`)
  check(
    '滚轮上下换音区后，第一行音高记进 store',
    afterTop.top !== topInfo.top && afterTop.stored === afterTop.top,
    `顶行 ${topInfo.top}→${afterTop.top}、store ${afterTop.stored}`,
  )
  check('第一行音高落 localStorage（重开恢复）', afterTop.saved === String(afterTop.top), String(afterTop.saved))

  /* ── 和弦分析按钮（用户 m02483 第 3 条，noteDigger 复刻） ──
   * 造一段真的"C 大三和弦 2 秒 → F 大三和弦 2 秒"的音频，用应用自己的 computeSpectrum
   * 算频谱后灌进 store，再点按钮 —— 这样验的是按钮 → worker → detectChords → 画布这条真链路。 */
  const chordSetup = await cdp.eval(`(async () => {
    const { computeSpectrum } = await import('/src/analysis/spectrum.ts')
    const SR = 44100
    const block = (freqs, ms) => {
      const n = Math.round((ms / 1000) * SR)
      const out = new Float32Array(n)
      const fade = Math.round(0.01 * SR)
      for (let i = 0; i < n; i++) {
        const t = i / SR
        let v = 0
        for (const f of freqs) v += Math.sin(2 * Math.PI * f * t)
        v /= freqs.length
        let g = 1
        if (i < fade) g = i / fade
        else if (i > n - fade) g = (n - i) / fade
        out[i] = v * 0.7 * g
      }
      return out
    }
    const a = block([261.63, 329.63, 392.0], 2000)
    const b = block([349.23, 440.0, 523.25], 2000)
    const samples = new Float32Array(a.length + b.length)
    samples.set(a, 0)
    samples.set(b, a.length)
    const spectrum = computeSpectrum(samples, SR, {})
    const bp = window.__bp
    bp.getState().setLoaded({ fileName: 'chords.wav', filePath: null, durationMs: 4000 })
    bp.getState().setAnalysis({
      durationMs: 4000,
      sampleRate: SR,
      spectrum,
      notes: [],
      bpm: 120,
      firstBeatMs: 0,
      keyCandidates: [{ tonic: 0, share: 1 }],
    })
    return { frames: spectrum.frames, hopMs: spectrum.hopMs }
  })()`)
  check('造出 4 秒的 C→F 和弦音频（频谱就绪）', !!chordSetup && chordSetup.frames > 60, JSON.stringify(chordSetup))

  const clickedChord = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.toolbar button')].find((x) => (x.getAttribute('aria-label') || '') === '和弦分析')
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  })()`)
  await sleep(1800)
  await setSideView('settings')
  const chordAfter = await cdp.eval(`(() => {
    const s = window.__bp.getState()
    const at = (ms) => (s.chords.find((c) => c.startMs <= ms && ms < c.endMs) || {}).name
    const b = [...document.querySelectorAll('.toolbar button')].find((x) => (x.getAttribute('aria-label') || '') === '和弦分析')
    const box = [...document.querySelectorAll('.side input[type=checkbox]')].find((x) => x.closest('label') && x.closest('label').textContent.includes('显示和弦'))
    /* 和弦带真的画上去了：取表格左下角（带子里）一个像素 */
    const c = document.querySelector('.pane.roll canvas')
    const r = c.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const px = c.getContext('2d').getImageData(Math.round((66 + 8) * dpr), Math.round((r.height - 8) * dpr), 1, 1).data
    return {
      n: s.chords.length,
      names: s.chords.filter((x) => x.name !== 'N').map((x) => x.name),
      first: at(800),
      second: at(2800),
      on: !!b && b.classList.contains('on'),
      showChords: s.showChords,
      hasToggle: !!box && !box.disabled,
      err: s.error,
      pixel: [px[0], px[1], px[2]],
    }
  })()`)
  check('点「和弦分析」：C 大三和弦判成 C', chordAfter.first === 'C', JSON.stringify(chordAfter.names))
  check('点「和弦分析」：F 大三和弦判成 F', chordAfter.second === 'F', `${chordAfter.second}（${JSON.stringify(chordAfter.names)}）`)
  check(
    '和弦按钮亮起、面板里有「显示和弦」开关、没有报错',
    clickedChord === 'ok' && chordAfter.on && chordAfter.hasToggle && chordAfter.showChords && !chordAfter.err,
    JSON.stringify({ on: chordAfter.on, toggle: chordAfter.hasToggle, err: chordAfter.err }),
  )
  check(
    '和弦带画在表格底部（左下角那块是紫的）',
    chordAfter.pixel[2] > 55 && chordAfter.pixel[2] > chordAfter.pixel[0],
    JSON.stringify(chordAfter.pixel),
  )
  await cdp.eval(`window.__bp.getState().setChords([])`)
  await cdp.eval(`window.__bp.getState().setPageSec(20)`)
  await cdp.eval(`window.__bp.getState().setTopMidi(${topInfo.top})`)
  await setSideView('edit')
  await sleep(150)

  /* ── 帮助弹层（顶栏键盘图标） ── */
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('.toolbar .icon-btn')].find((b) => (b.getAttribute('aria-label') || '').includes('按键'))
    if (btn) btn.click()
  })()`)
  await sleep(250)
  const helpOpen = await cdp.eval(`!!document.querySelector('.modal-backdrop .modal')`)
  check('点顶栏键盘图标能打开帮助弹层', helpOpen === true, String(helpOpen))
  const helpRows = await cdp.eval(`document.querySelectorAll('.modal .help-row').length`)
  check('帮助弹层里列了按键条目', helpRows > 10, String(helpRows))
  await cdp.pressKey('Escape', 'Escape', 27)
  await sleep(250)
  const helpClosed = await cdp.eval(`!document.querySelector('.modal-backdrop')`)
  check('Esc 能关掉帮助弹层', helpClosed === true, String(helpClosed))

  /* ── 右栏滑条值到顶时填充到头 ── */
  await setSideView('settings')
  await cdp.eval(`window.__bp.getState().setGain(5)`)
  await sleep(200)
  const gainFill = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.side input[type=range]')].find((x) => x.max === '5')
    return el ? getComputedStyle(el).getPropertyValue('--fill').trim() : 'none'
  })()`)
  check('倍率滑条拉满时填充到头（--fill=100%）', gainFill === '100.0%', gainFill)
  await setSideView('edit')
  const errs = await cdp.eval(`window.__bpErrors || 0`)
  check('页面没有运行时错误', !errs, errs ? String(errs) : '')

  /* ── 刷新后恢复：行高 / 屏宽 / 第一行音高（用户 m02483 第 1、2、4 条） ──
   * 这三项是"看谱习惯"，存在 localStorage；刷新一次就该原样回来。
   * 放在最后跑：刷新会把前面的假分析清掉。 */
  await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.setRowH(18)
    s.setPageSec(12)
    s.setTopMidi(72)
  })()`)
  await sleep(400)
  await cdp.send('Page.reload', { ignoreCache: false })
  let restored = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try {
      restored = await cdp.eval(`(() => {
        if (!document.querySelector('.toolbar') || !window.__bpRoll) return null
        const s = window.__bp.getState()
        return { rowH: s.rowH, pageSec: s.pageSec, top: window.__bpRoll.top, stored: s.topMidi }
      })()`)
    } catch {
      restored = null /* 刷新瞬间执行上下文被销毁，下一轮再来 */
    }
    if (restored) break
  }
  check(
    '刷新后行高 / 屏宽 / 第一行音高都恢复',
    !!restored && restored.rowH === 18 && restored.pageSec === 12 && restored.stored === 72 && restored.top === 72,
    JSON.stringify(restored),
  )
  /* 收尾：把三项调回默认，免得截图/后续跑挂在这个状态上 */
  await cdp.eval(`(() => {
    const s = window.__bp.getState()
    s.setRowH(14)
    s.setPageSec(20)
    s.setTopMidi(96)
  })()`)
  await sleep(250)

  /* --shot <path>：把当前界面截一张干净图
     （顺手灌回一份假的频谱与两个音、全标确认、圈一段区间，谱面才有内容可看）
     --pickup N：截图时把弱起设成 N 拍，用来核对小节线位置 */
  const shotPath = argValue('--shot')
  if (shotPath) {
    const pickupN = Math.max(0, Number(argValue('--pickup')) || 0)
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
      s.setPickupBeats(${pickupN})
      s.setLoop({ startMs: 500, endMs: 2500 })
      s.setLoopOn(true)
    })()`)
    await sleep(600)
    /* 截图辅助：--chords 画一条假和弦带、--rowh N 换行高、--page N 换一屏秒数，
     * 用来肉眼核对新加的显示项（用户 m02483） */
    if (argv.includes('--chords')) {
      await cdp.eval(`window.__bp.getState().setChords([
        { startMs: 0, endMs: 1000, name: 'C' },
        { startMs: 1000, endMs: 2000, name: 'Am' },
        { startMs: 2000, endMs: 3000, name: 'F' },
        { startMs: 3000, endMs: 4000, name: 'G7' },
      ])`)
      await cdp.eval(`window.__bp.getState().setShowChords(true)`)
      await sleep(250)
    }
    const shotRowH = Number(argValue('--rowh'))
    if (Number.isFinite(shotRowH) && shotRowH > 0) {
      await cdp.eval(`window.__bp.getState().setRowH(${shotRowH})`)
      await sleep(250)
    }
    const shotPage = Number(argValue('--page'))
    if (Number.isFinite(shotPage) && shotPage > 0) {
      await cdp.eval(`window.__bp.getState().setPageSec(${shotPage})`)
      await sleep(250)
    }
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(shotPath, Buffer.from(png.data, 'base64'))
    check('截图已保存', true, shotPath)
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
