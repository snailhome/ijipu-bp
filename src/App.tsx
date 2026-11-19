/**
 * App.tsx — 爱扒谱的主界面
 *
 * 布局（用户 m01788 之后的形态）：上面工具条；中间左边「音符表 + 简谱流线谱」占满，
 * 右边「调性 + 生成参数 + jps 源码」。
 *
 * 独立的频谱面板已经撤掉 —— 频谱能量直接铺在音符表的格子里当热力图，
 * 把纵向空间全让给"音高 × 时间"的表格（对照 noteDigger 的信息密度）。
 *
 * 数据流：打开音频 → worker 分析 → store 出 grid/jps → 画布与预览都读 store。
 * 播放两种模式（原音频 / 合成音）共用播放头；Tab 随时切换；空格播放；反引号切点击模式。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { keyColor, keyDisplayName } from './analysis/pitchNames'
import { loadAudioFromPath, pickAndLoadAudio, type LoadedAudio } from './audio/decode'
import { play, setAudioBuffer, stop, audition, type PlayMode } from './audio/player'
import { COPY } from './brand/copy'
import { APP_VERSION } from './brand/version'
import { invoke, isTauriShell } from './brand/env'
import { PAGE_MS, useBp } from './model/store'
import { spanMs } from './ui/timeAxis'
import type { AnalyzeResult, LoopRange, SnapMode } from './model/types'
import { NoteRoll } from './ui/NoteRoll'
import { StripPreview } from './ui/StripPreview'

/** range 滑条的"已填充"比例（CSS 里 --fill 决定渐变停在哪；值到顶时颜色真的顶到尽头） */
function fillStyle(pct: number): Record<string, string> {
  const v = Math.max(0, Math.min(100, pct))
  return { ['--fill']: v.toFixed(1) + '%' }
}

/** 帮助面板的内容（用户 m05893：顶栏键盘图标点开就能查按键 / 快捷键 / 鼠标操作） */
const HELP_SECTIONS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: '播放',
    rows: [
      ['空格', '播放 / 暂停；圈了播放区就在区间里循环'],
      ['Tab', '原音频 / 合成音 互换'],
      ['L', '重复区间开关'],
      ['Home', '回开头（没选播放区回曲子开头，选了回播放区开头）'],
      ['Ctrl + ← / →', '退 / 进一个小节'],
    ],
  },
  {
    title: '编辑',
    rows: [
      ['` 反引号', '绘制 / 选择 互换（默认选择）'],
      ['按住 Alt', '选择模式下临时当绘制用，松开恢复'],
      ['拖空白处', '画一个音（起点落在光标那一格，按住往右拖加长）'],
      ['拖音符中间', '上下改音高、左右改位置'],
      ['拖音符右缘', '改时值（光标会变左右箭头）'],
      ['点已有音符', '确认 / 取消确认（只有确认过的音才会导出）'],
      ['↑ / ↓', '选中的音符升 / 降半音（Shift 一个八度）'],
      ['Delete / Backspace', '删掉选中的音符；右键点音符也能删'],
      ['Ctrl + Z', '撤销（最多 200 步，一次拖动算一步）'],
      ['Ctrl + Shift + Z / Ctrl + Y', '重做'],
      ['Ctrl + A', '全选确认'],
    ],
  },
  {
    title: '鼠标与视野',
    rows: [
      ['滚轮', '上下换音区（键列上的锁锁住后改成左右平移）'],
      ['Shift + 滚轮', '左右平移'],
      ['Shift + Alt + 滚轮', '横向缩放（Ctrl + 滚轮也行）'],
      ['拖时间尺', '框播放区间；点一下 = 取消区间并挪播放头'],
      ['拖区间两端握柄', '改区间起止'],
      ['右栏滑条上滚轮', '微调这条滑条（按住 Shift 五倍步长）'],
      ['点钢琴键', '试听该音高'],
    ],
  },
]
const KEY_CHOICES = Array.from({ length: 12 }, (_, i) => i)
const SNAP_CHOICES: Array<{ v: SnapMode; label: string }> = [
  { v: 'off', label: COPY.snapOff },
  { v: 'grid', label: COPY.snapGrid },
  { v: 'beat', label: COPY.snapBeat },
  { v: 'bar', label: COPY.snapBar },
]

export default function App() {
  const fileName = useBp((s) => s.fileName)
  const durationMs = useBp((s) => s.durationMs)
  const analysis = useBp((s) => s.analysis)
  const busy = useBp((s) => s.busy)
  const error = useBp((s) => s.error)
  const playing = useBp((s) => s.playing)
  const currentMs = useBp((s) => s.currentMs)
  const playMode = useBp((s) => s.playMode)
  const pitchMode = useBp((s) => s.pitchMode)
  const mode = useBp((s) => s.mode)
  const snap = useBp((s) => s.snap)
  const view = useBp((s) => s.view)
  const loop = useBp((s) => s.loop)
  const loopOn = useBp((s) => s.loopOn)
  const autoPage = useBp((s) => s.autoPage)
  const lockPitch = useBp((s) => s.lockPitch)
  const historyLen = useBp((s) => s.history.length)
  const futureLen = useBp((s) => s.future.length)
  const gain = useBp((s) => s.gain)
  const contrast = useBp((s) => s.contrast)
  const suppress = useBp((s) => s.suppress)
  const autoNotes = useBp((s) => s.autoNotes)
  const rhythm = useBp((s) => s.rhythm)
  const tonic = useBp((s) => s.tonic)
  const bpm = useBp((s) => s.bpm)
  const beatsPerBar = useBp((s) => s.beatsPerBar)
  const firstBeatMs = useBp((s) => s.firstBeatMs)
  const title = useBp((s) => s.title)
  const jps = useBp((s) => s.jps)
  const grid = useBp((s) => s.grid)
  const notes = useBp((s) => s.notes)

  const set = useBp
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  /* 帮助弹层：Esc 关掉（点外面关在 backdrop 的 onClick 里） */
  useEffect(() => {
    if (!helpOpen) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        setHelpOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [helpOpen])
  /* 右侧栏（调性/参数/显示/源码）能不能收起来——宽屏看谱时把它关掉能多出一大块 */
  const [showSide, setShowSide] = useState(true)
  /* 调性分析那一组能不能折起来（调号选择挪进组里了） */
  const [keyOpen, setKeyOpen] = useState(true)
  const workerRef = useRef<Worker | null>(null)
  /* 分析用过的样本留着：调'去谐波'要把同一段音频重跑一遍，不能重新选文件 */
  const samplesRef = useRef<{ samples: Float32Array; sampleRate: number } | null>(null)
  const sideRef = useRef<HTMLDivElement | null>(null)

  /* 右侧栏里所有滑条：鼠标在上面滚轮就能调，而且那一刻不滚动右栏（用户 m05454）。
   * React 的 onWheel 是 passive 的，preventDefault 拦不住滚动，所以这里挂原生监听。
   * 直接写 el.value 会被 React 的 value tracker 认为"没变"，得用原生 setter 再派发 input 事件。 */
  useEffect(() => {
    const host = sideRef.current
    if (!host) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    const onWheel = (ev: WheelEvent) => {
      const el = (ev.target as HTMLElement | null)?.closest?.('input[type="range"]') as HTMLInputElement | null
      if (!el) return
      ev.preventDefault() // 只调滑条，不滚右栏
      const step = Number(el.step) || 1
      const min = Number(el.min)
      const max = Number(el.max)
      const dir = ev.deltaY > 0 ? -1 : 1
      const next = Math.min(max, Math.max(min, Number(el.value) + dir * step * (ev.shiftKey ? 5 : 1)))
      if (next === Number(el.value)) return
      if (setter) setter.call(el, String(next))
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [showSide])

  const confirmedCount = useMemo(() => notes.filter((n) => n.confirmed).length, [notes])
  const warnings = useBp((s) => s.warnings)

  /* ---------- 分析 worker ---------- */
  useEffect(() => {
    const w = new Worker(new URL('./worker/analyze.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<{ ok: boolean; result?: AnalyzeResult; error?: string }>) => {
      const msg = e.data
      if (msg.ok && msg.result) {
        set.getState().setAnalysis(msg.result)
        set.getState().setBusy(null)
        setNotice(`分析完成：BPM ${msg.result.bpm}，${msg.result.notes.length > 0 ? `自动填入 ${msg.result.notes.length} 个音` : `没自动填音（在表格里点着画）`}`)
      } else {
        set.getState().setError(msg.error ?? '分析失败')
        set.getState().setBusy(null)
      }
    }
    w.onerror = () => {
      set.getState().setError('分析线程出错')
      set.getState().setBusy(null)
    }
    workerRef.current = w
    return () => {
      w.terminate()
      workerRef.current = null
    }
  }, [set])

  /* ---------- 打开音频 ---------- */
  /** 装载 + 起分析：选文件和"启动参数带文件"都走这一条，避免两套逻辑 */
  const applyLoaded = useCallback(
    (loaded: LoadedAudio) => {
      const st = set.getState()
      stop()
      st.setPlaying(false)
      st.setLoaded({ fileName: loaded.name, filePath: loaded.path, durationMs: loaded.durationMs })
      setAudioBuffer(loaded.buffer)
      st.setBusy(COPY.analyzing)
      const w = workerRef.current
      if (!w) throw new Error('分析线程没起来')
      /* 存一份副本：worker 拿走的是 transfer 过去的 buffer，主线程这边就没数据了 */
      samplesRef.current = {
        samples: new Float32Array(loaded.samples),
        sampleRate: loaded.sampleRate,
      }
      w.postMessage(
        {
          samples: loaded.samples,
          sampleRate: loaded.sampleRate,
          suppress: st.suppress,
          beatsPerBar: st.beatsPerBar,
          notes: st.autoNotes,
        },
        [loaded.samples.buffer as ArrayBuffer],
      )
    },
    [set],
  )

  const openAudio = useCallback(async () => {
    const st = set.getState()
    st.setError(null)
    setNotice(null)
    st.setBusy('正在读文件…')
    try {
      const loaded = await pickAndLoadAudio()
      if (!loaded) {
        st.setBusy(null)
        return
      }
      applyLoaded(loaded)
    } catch (e) {
      st.setError(e instanceof Error ? e.message : String(e))
      st.setBusy(null)
    }
  }, [applyLoaded, set])

  /* ---------- 启动参数里的音频（桌面壳：双击 / 命令行） ---------- */
  useEffect(() => {
    if (!isTauriShell()) return
    let cancelled = false
    void (async () => {
      try {
        const path = (await invoke<string | null>('bp_initial_audio')) ?? null
        if (!path || cancelled) return
        const loaded = await loadAudioFromPath(path)
        if (!loaded || cancelled) return
        set.getState().setError(null)
        applyLoaded(loaded)
      } catch (e) {
        set.getState().setError(e instanceof Error ? e.message : String(e))
        set.getState().setBusy(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyLoaded, set])

  /* ---------- 去谐波：把同一段音频带着新的强度重跑一遍 ---------- */
  const applySuppress = useCallback(
    (v: number) => {
      const st = set.getState()
      st.setSuppress(v)
      const buf = samplesRef.current
      const w = workerRef.current
      if (!buf || !w) return
      st.setBusy(COPY.analyzing)
      const copy = new Float32Array(buf.samples)
      w.postMessage(
        { samples: copy, sampleRate: buf.sampleRate, suppress: v, beatsPerBar: st.beatsPerBar, notes: st.autoNotes },
        [copy.buffer as ArrayBuffer],
      )
    },
    [set],
  )
  /* ---------- 播放 ----------
   * 注意"先置 playing 再 await"：`play()` 里有 await（AudioContext.resume / 合成器 ready）。
   * 如果等 await 完才 setPlaying(true)，用户在这几十毫秒里连按两次空格，第二次看到的
   * 还是 playing=false，会再启动一路播放 —— 两路 tick 同时存在，stop() 又只管得到最新的
   * raf 变量，表现就是"播了就停不下来 / 越按越乱"。 */
  const startPlay = useCallback(async (fromMs: number, m: PlayMode) => {
    const st = set.getState()
    if (!st.analysis) return
    set.getState().setPlaying(true)
    const ok = await play(fromMs, m, st.notes, st.durationMs, {
      onTick: (ms) => set.getState().setCurrentMs(ms),
      onEnd: () => set.getState().setPlaying(false),
    })
    /* play() 返回 false = 这一路在 await 期间被 stop()/另一次 play() 顶掉了，别再动状态 */
    if (!ok) return
  }, [set])

  const togglePlay = useCallback(() => {
    const st = set.getState()
    if (st.playing) {
      stop()
      st.setPlaying(false)
      return
    }
    if (!st.analysis) return
    /* 圈了播放区间就从区间开头放（用户：画完区间按播放，应该在区间里循环听，而不是从头放） */
    let from = st.currentMs >= st.durationMs ? 0 : st.currentMs
    if (st.loopOn && st.loop) {
      const inside = from >= st.loop.startMs - 5 && from < st.loop.endMs - 5
      if (!inside) from = st.loop.startMs
    }
    void startPlay(from, st.playMode)
  }, [set, startPlay])

  const switchMode = useCallback(
    (m: PlayMode) => {
      const st = set.getState()
      st.setPlayMode(m)
      if (st.playing) {
        stop()
        void startPlay(st.currentMs, m)
      }
    },
    [set, startPlay],
  )

  const seek = useCallback(
    (ms: number) => {
      const st = set.getState()
      st.setCurrentMs(ms)
      if (st.playing) {
        stop()
        void startPlay(ms, st.playMode)
      }
    },
    [set, startPlay],
  )

  /* 回开头：没选播放区就回曲子开头，选了播放区就回播放区开头（用户 m05893） */
  const goStart = useCallback(() => {
    const st = set.getState()
    seek(st.loopOn && st.loop ? st.loop.startMs : 0)
  }, [seek, set])

  /* Ctrl+左右：按小节跳（用户 m05893） */
  const jumpBar = useCallback(
    (dir: -1 | 1) => {
      const st = set.getState()
      const barMs = (60000 / Math.max(1, st.bpm)) * Math.max(1, st.beatsPerBar)
      const idx = Math.floor((st.currentMs - st.firstBeatMs) / barMs)
      const target = Math.max(
        0,
        Math.min(st.durationMs, st.firstBeatMs + (idx + dir) * barMs),
      )
      seek(target)
    },
    [seek, set],
  )


  /* ---------- 重复区间：播放到区间末尾就跳回区间开头 ---------- */
  useEffect(() => {
    if (!playing || !loopOn || !loop) return
    if (currentMs < loop.endMs - 12) return
    stop()
    set.getState().setCurrentMs(loop.startMs)
    void startPlay(loop.startMs, playMode)
  }, [currentMs, playing, loopOn, loop, playMode, set, startPlay])

  /* ---------- 自动翻页：播放头碰到右边缘才翻一页 ----------
   * 用户 2026-11-18 的口径：时点线走到视界边上就翻页（不是提前 82% 就推）。
   * 整首都在视野里时（zoom=1）根本没得推，所以开关一打开就先切到一屏 20 秒。
   * 翻页后把播放头放在左边 6% 的位置，前面留出一点"刚过去"的上下文。
   *
   * 注意（adj 级教训）：这个 effect 的依赖里有 view，而它自己又会 setView ——
   * 只要有一次 setView 传进去的值和当前值一样，状态对象仍是新引用、effect 会重跑，
   * 就变成死循环（React 会报 "Maximum update depth exceeded" 并整页白屏）。
   * 所以每次 setView 之前先比一遍数，没变化就直接 return；整首比一屏还短时干脆不动。 */
  useEffect(() => {
    if (!playing || !autoPage || !durationMs) return
    /* 整首比一屏（20 秒）还短：翻页没有意义，也不许在这里 setView（会自激） */
    if (durationMs <= PAGE_MS) return
    const span = spanMs(view, durationMs)
    if (span >= durationMs - 1) {
      const pageMs = Math.min(durationMs, PAGE_MS)
      const zoom = durationMs / Math.max(1, pageMs)
      const panMs = Math.max(0, Math.min(durationMs - pageMs, currentMs - pageMs * 0.2))
      if (Math.abs(view.zoom - zoom) < 1e-6 && Math.abs(view.panMs - panMs) < 1) return
      set.getState().setView({ zoom, panMs })
      return
    }
    /* 右边缘再留 1 像素的余量：线一贴边就翻，别等它真的画出去 */
    const rightEdge = view.panMs + span - 1
    if (currentMs >= rightEdge || currentMs < view.panMs) {
      const panMs = Math.max(0, currentMs - span * 0.06)
      if (Math.abs(panMs - view.panMs) < 1) return
      set.getState().setView({ zoom: view.zoom, panMs })
    }
  }, [currentMs, playing, autoPage, durationMs, view, set])

  /** 删音符：顺手把选中态清掉（否则 Delete 会去删一个已经不存在的 id） */
  const removeNote = useCallback((id: string) => {
    useBp.getState().removeNote(id)
    setSelectedId((cur) => (cur === id ? null : cur))
  }, [])

  /* ---------- 热键 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      /* 只有"要打字"的控件才吞掉热键；滑条/复选框/按钮上的空格照样能启停播放 */
      const typing =
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes((el as HTMLInputElement).type))
      if (typing) return
      const st = set.getState()
      if (e.code === 'Space') {
        /* 关键：按钮/滑条上有焦点时，空格还会触发它们自己的激活（按钮 = 再来一次 click），
         * 结果一次空格切换两遍 —— 用户看到的"空格好像跳跃播放"就是这么来的。
         * 用捕获阶段 + stopPropagation 把事件截在窗口这一层，控件收不到。 */
        e.preventDefault()
        e.stopPropagation()
        togglePlay()
      } else if (e.code === 'Tab') {
        e.preventDefault()
        switchMode(st.playMode === 'audio' ? 'synth' : 'audio')
      } else if (e.code === 'Backquote') {
        /* 反引号：绘制 / 选择 互换（跟 noteDigger 的铅笔/箭头一个意思） */
        e.preventDefault()
        st.setMode(st.mode === 'draw' ? 'select' : 'draw')
      } else if (e.code === 'KeyL') {
        st.setLoopOn(!st.loopOn)
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (selectedId) {
          e.preventDefault()
          removeNote(selectedId)
        }
      } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        /* Ctrl+Shift+Z 跟 Ctrl+Y 一样是重做 */
        e.preventDefault()
        st.redo()
      } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        st.undo()
      } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        st.redo()
      } else if (e.code === 'Home') {
        e.preventDefault()
        goStart()
      } else if (e.code === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        jumpBar(-1)
      } else if (e.code === 'ArrowRight' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        jumpBar(1)
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        /* 选中音符上下改音高（Shift 一个八度，用户 m05736 第 1 条） */
        if (!selectedId) return
        const cur = st.notes.find((n) => n.id === selectedId)
        if (!cur) return
        e.preventDefault()
        const step = e.shiftKey ? 12 : 1
        st.patchNote(selectedId, { midi: cur.midi + (e.code === 'ArrowUp' ? step : -step) })
      } else if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        st.setAllConfirmed(true)
      }
    }
    window.addEventListener('keydown', onKey, true) // 捕获阶段：先于控件自己的默认行为
    return () => window.removeEventListener('keydown', onKey, true)
  }, [goStart, jumpBar, removeNote, selectedId, set, switchMode, togglePlay])

  /* ---------- 导出 ---------- */
  const exportJps = useCallback(async () => {
    const st = set.getState()
    const name = `${st.title || '爱扒谱导出'}.jps`
    if (isTauriShell()) {
      const saved = await invoke<string | null>('bp_save_jps', { suggested: name, text: st.jps })
      setNotice(saved ? `已保存：${saved}` : null)
      return
    }
    const blob = new Blob([st.jps], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
    setNotice(`已下载：${name}`)
  }, [set])

  const candidates = analysis?.keyCandidates.slice(0, 6) ?? []
  const setLoop = useCallback(
    (r: LoopRange | null) => {
      const s = set.getState()
      s.setLoop(r)
      /* 划出区间就自动开循环；取消区间（时间尺上点一下）顺手把循环关掉，
       * 否则一个空区间会一直挡着播放（用户 m03936 第 4 条）。 */
      s.setLoopOn(!!r)
    },
    [set],
  )

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">
          {/* 顶栏图标 = 品牌图标（Logo-bp.png；窗口/任务栏图标由 src-tauri/icons 决定） */}
          <img className="brand-logo" src="/icons/Logo-bp.png" alt={COPY.appName} />
          <span className="brand-text">
            {COPY.appName}
            <small>
              {COPY.appNameEn} {APP_VERSION}
            </small>
          </span>
        </span>
        <button className="primary" onClick={() => void openAudio()} disabled={!!busy}>
          {COPY.openAudio}
        </button>
        <button onClick={togglePlay} disabled={!analysis}>
          {playing ? COPY.pause : COPY.play}
        </button>
        <div className="seg" title={COPY.abTip}>
          <button className={playMode === 'audio' ? 'on' : ''} onClick={() => switchMode('audio')}>
            {COPY.sourceAudio}
          </button>
          <button className={playMode === 'synth' ? 'on' : ''} onClick={() => switchMode('synth')}>
            {COPY.sourceSynth}
          </button>
        </div>

        <div className="seg" title={mode === 'draw' ? COPY.modeDrawTip : COPY.modeSelectTip}>
          <button
            className={mode === 'draw' ? 'on' : ''}
            onClick={() => useBp.getState().setMode('draw')}
          >
            {COPY.modeDraw} `
          </button>
          <button
            className={mode === 'select' ? 'on' : ''}
            onClick={() => useBp.getState().setMode('select')}
          >
            {COPY.modeSelect} `
          </button>
        </div>

        <label className="field" title="画音/拖音时吸附到哪一格">
          {COPY.snapLabel}
          <select value={snap} onChange={(e) => useBp.getState().setSnap(e.target.value as SnapMode)}>
            {SNAP_CHOICES.map((c) => (
              <option key={c.v} value={c.v}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <button
          className={loopOn ? 'on' : ''}
          onClick={() => useBp.getState().setLoopOn(!loopOn)}
          title={COPY.loopTip}
          disabled={!loop}
        >
          {COPY.loop}
        </button>
        <button
          className={autoPage ? 'on' : ''}
          onClick={() => useBp.getState().setAutoPage(!autoPage)}
          title={COPY.autoPageTip}
        >
          {COPY.autoPage}
        </button>

        <div className="spacer" />

        <div className="seg" title="表格里写字用音名还是简谱数字（换调号数字跟着变）">
          <button className={pitchMode === 'name' ? 'on' : ''} onClick={() => useBp.getState().setPitchMode('name')}>
            {COPY.pitchName}
          </button>
          <button
            className={pitchMode === 'number' ? 'on' : ''}
            onClick={() => useBp.getState().setPitchMode('number')}
          >
            {COPY.pitchNumber}
          </button>
        </div>
        <button
          onClick={() => useBp.getState().undo()}
          disabled={historyLen === 0}
          title={COPY.undoTip}
        >
          {COPY.undo}
        </button>
        <button
          onClick={() => useBp.getState().redo()}
          disabled={futureLen === 0}
          title={COPY.redoTip}
        >
          {COPY.redo}
        </button>
        <button onClick={goStart} title={COPY.goStartTip}>
          {COPY.goStart}
        </button>
        <button onClick={() => useBp.getState().setAllConfirmed(true)} disabled={!notes.length} title={COPY.confirmAllTip}>
          {COPY.confirmAll}
        </button>
        <button onClick={() => useBp.getState().setAllConfirmed(false)} disabled={!notes.length}>
          {COPY.clearAll}
        </button>
        <button
          onClick={() => {
            useBp.getState().resetNotes()
            setSelectedId(null)
          }}
          disabled={!analysis}
          title={COPY.resetDraftTip}
        >
          {COPY.resetDraft}
        </button>
        <button onClick={() => void exportJps()} disabled={confirmedCount === 0} title="只导出你确认过的音">
          {COPY.exportJps}
        </button>
        {/* 帮助：按键 / 快捷键 / 鼠标操作（用户 m05893） */}
        <button
          className={helpOpen ? 'icon-btn on' : 'icon-btn'}
          onClick={() => setHelpOpen(true)}
          title="按键与鼠标操作"
          aria-label="按键与鼠标操作"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="4" width="13" height="8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="3.4" y="6" width="1.6" height="1.6" fill="currentColor" />
            <rect x="6" y="6" width="1.6" height="1.6" fill="currentColor" />
            <rect x="8.6" y="6" width="1.6" height="1.6" fill="currentColor" />
            <rect x="11.2" y="6" width="1.6" height="1.6" fill="currentColor" />
            <rect x="4.6" y="9" width="6.8" height="1.5" rx="0.5" fill="currentColor" />
          </svg>
        </button>
        {/* 右侧栏开关：图标与 iJipu BP 的兄弟项目「爱出片」用同一个
            （public/icons/右侧边栏.svg，靠 CSS mask 上色，打开=亮、收起=灰） */}
        <button
          className={showSide ? 'icon-btn side-toggle' : 'icon-btn side-toggle off'}
          onClick={() => setShowSide((v) => !v)}
          title={showSide ? '收起右侧栏' : '展开右侧栏'}
          aria-label={showSide ? '收起右侧栏' : '展开右侧栏'}
        >
          <span className="side-toggle-icon" />
        </button>
      </div>

      <div className={showSide ? "body" : "body noside"}>
        <div className="main">
          <NoteRoll
            notes={notes}
            spectrum={analysis?.spectrum ?? null}
            durationMs={durationMs}
            bpm={bpm}
            beatsPerBar={beatsPerBar}
            firstBeatMs={firstBeatMs}
            pitchMode={pitchMode}
            tonic={tonic}
            mode={mode}
            snap={snap}
            view={view}
            loop={loop}
            loopOn={loopOn}
            gain={gain}
            contrast={contrast}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onSeek={seek}
            onAudition={(midi) => void audition(midi)}
            onAdd={(n) => useBp.getState().addNote(n)}
            onPatch={(id, patch) => useBp.getState().patchNote(id, patch)}
            onRemove={removeNote}
            onToggleConfirmed={(id) => useBp.getState().toggleConfirmed(id)}
            onBeginEdit={() => useBp.getState().beginEdit()}
            onEndEdit={() => useBp.getState().endEdit()}
            lockPitch={lockPitch}
            onToggleLock={() => useBp.getState().setLockPitch(!lockPitch)}
            onView={(v) => useBp.getState().setView(v)}
            onLoop={setLoop}
            playMs={currentMs}
          />
          <StripPreview
            grid={grid}
            bpm={bpm}
            beatsPerBar={beatsPerBar}
            firstBeatMs={firstBeatMs}
            durationMs={durationMs}
            view={view}
            playMs={currentMs}
            tonic={tonic}
            onSeek={seek}
          />
        </div>

        <div className={showSide ? "side" : "side off"} ref={sideRef}>
          <label className="check" title="关着：分析只出频谱/节奏/调性，音符全靠自己在表格里点">
            <input
              type="checkbox"
              checked={autoNotes}
              onChange={(e) => useBp.getState().setAutoNotes(e.target.checked)}
            />
            分析后自动填入音符
          </label>

          <div>
            <button className="group-head" onClick={() => setKeyOpen((v) => !v)} aria-expanded={keyOpen}>
              <span className="chev">{keyOpen ? '▾' : '▸'}</span>
              <span>{COPY.keyPanelTitle}</span>
            </button>
            {keyOpen && (
              <div className="group-body">
                <label className="field" style={{ marginBottom: 8 }}>
                  {COPY.keyLabel}
                  <select value={tonic} onChange={(e) => useBp.getState().setTonic(Number(e.target.value))}>
                    {KEY_CHOICES.map((k) => (
                      <option key={k} value={k}>
                        {keyDisplayName(k)} 大调
                      </option>
                    ))}
                  </select>
                </label>
                <div className="keys">
                  {candidates.map((c) => (
                    <div
                      key={c.tonic}
                      className={`key-row${c.tonic === tonic ? ' on' : ''}`}
                      onClick={() => useBp.getState().setTonic(c.tonic)}
                      title="点一下就把调号定成它"
                    >
                      <span className="key-name">{keyDisplayName(c.tonic)}</span>
                      <span className="bar">
                        <i
                          style={{
                            width: `${Math.max(2, c.share * 100)}%`,
                            background: keyColor(c.tonic),
                          }}
                        />
                      </span>
                      <span className="key-share">{(c.share * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  {COPY.keyPanelHint}
                </div>
              </div>
            )}
          </div>

          <div>
            <h3>{COPY.rhythmTitle}</h3>
            <div className="row-gap">
              <button onClick={() => useBp.getState().runRhythm()} disabled={!analysis}>
                {COPY.rhythmBtn}
              </button>
              <span className="hint">
                {rhythm
                  ? `BPM ${rhythm.bpm} · 拍点 ${rhythm.beatCount} 个 · 可信度 ${(rhythm.confidence * 100).toFixed(0)}%`
                  : COPY.rhythmHint}
              </span>
            </div>
            <div className="row-gap" style={{ marginTop: 8 }}>
              <label className="field" style={{ flex: 1 }}>
                {COPY.harmonicLabel}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={suppress}
                  onChange={(e) => useBp.getState().setSuppress(Number(e.target.value))}
                  onPointerUp={(e) => applySuppress(Number((e.target as HTMLInputElement).value))}
                  onKeyUp={(e) => applySuppress(Number((e.currentTarget as HTMLInputElement).value))}
                  style={{ width: 120, ...fillStyle(suppress * 100) }}
                />
                <span className="mono">{suppress.toFixed(2)}</span>
              </label>
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              {COPY.harmonicHint}
            </div>
          </div>

          <div>
            <h3>生成参数</h3>
            <div style={{ display: 'grid', gap: 6 }}>
              <label className="field">
                标题
                <input
                  style={{ width: 150 }}
                  value={title}
                  onChange={(e) => useBp.getState().setTitle(e.target.value)}
                />
              </label>
              <label className="field">
                {COPY.bpmLabel}
                <input
                  type="number"
                  value={Math.round(bpm)}
                  min={20}
                  max={300}
                  onChange={(e) => useBp.getState().setBpm(Number(e.target.value))}
                />
              </label>
              <label className="field">
                {COPY.meterLabel}
                <input
                  type="number"
                  value={beatsPerBar}
                  min={1}
                  max={12}
                  onChange={(e) => useBp.getState().setBeatsPerBar(Number(e.target.value))}
                />
                / 4
              </label>
              <label className="field">
                {COPY.firstBeatLabel}
                <input
                  type="number"
                  value={Math.round(firstBeatMs)}
                  step={10}
                  onChange={(e) => useBp.getState().setFirstBeatMs(Number(e.target.value))}
                />
                ms
              </label>
              <div className="hint">改哪一项都只重算"拍轴"，原始秒轴不动。</div>
            </div>
          </div>

          <div>
            <h3>显示</h3>
            <div style={{ display: 'grid', gap: 6 }}>
              <label className="field">
                倍率
                <input
                  type="range"
                  min={0.2}
                  max={5}
                  step={0.1}
                  value={gain}
                  onChange={(e) => useBp.getState().setGain(Number(e.target.value))}
                  style={{ width: 140, ...fillStyle(((gain - 0.2) / 4.8) * 100) }}
                />
                <span className="hint" style={{ width: 30, textAlign: 'right' }}>
                  {gain.toFixed(1)}
                </span>
              </label>
              <label className="field">
                对比
                <input
                  type="range"
                  min={0.3}
                  max={3}
                  step={0.05}
                  value={contrast}
                  onChange={(e) => useBp.getState().setContrast(Number(e.target.value))}
                  style={{ width: 140, ...fillStyle(((contrast - 0.3) / 2.7) * 100) }}
                />
                <span className="hint" style={{ width: 30, textAlign: 'right' }}>
                  {contrast.toFixed(2)}
                </span>
              </label>
              <div className="hint">口径同 noteDigger：颜色深度 = 值 ^ 对比 × 倍率。</div>
            </div>
          </div>

          {warnings.length > 0 && (
            <div>
              <h3>{COPY.warnings}</h3>
              <div className="warn">
                {warnings.slice(0, 6).map((w, i) => (
                  <div key={i}>· {w}</div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h3>{COPY.jpsTitle}</h3>
            <pre className="src">{jps || '（还没确认音符）'}</pre>
          </div>
        </div>
      </div>

      {/* 帮助弹层：点外面或按 Esc 关掉 */}
      {helpOpen && (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="按键与鼠标操作">
            <div className="modal-head">
              <strong>按键 · 快捷键 · 鼠标</strong>
              <button className="icon-btn" onClick={() => setHelpOpen(false)} title="关闭（Esc）" aria-label="关闭">
                ×
              </button>
            </div>
            <div className="modal-body">
              {HELP_SECTIONS.map((sec) => (
                <section key={sec.title}>
                  <h4>{sec.title}</h4>
                  {sec.rows.map(([keys, what]) => (
                    <div className="help-row" key={keys}>
                      <span className="help-keys">{keys}</span>
                      <span className="help-what">{what}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="status">
        <span>{fileName ?? COPY.empty}</span>
        <span>{durationMs ? `${(durationMs / 1000).toFixed(1)}s` : ''}</span>
        <span>
          {analysis ? `确认 ${confirmedCount} / 共 ${notes.length} 个音` : ''}
        </span>
        <span>{busy ?? ''}</span>
        <span className="spacer" />
        {error && <span className="err">{error}</span>}
        {notice && <span className="hint">{notice}</span>}
        <span className="hint">空格播放 · Tab 原音/合成 · ` 绘制/选择 · L 循环 · Shift+滚轮平移 · Shift+Alt+滚轮缩放</span>
      </div>
    </div>
  )
}
