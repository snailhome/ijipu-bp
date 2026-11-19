/**
 * ui/NoteRoll.tsx — 扒谱主界面：音高 × 时间 的表格（用户 2026-11-18 定的形态）
 *
 * 为什么是"表格"而不是波形条：扒谱是"听原音频 → 定音高/时值 → 听合成音 → 改"的循环，
 * 必须能一眼看出"这个音在第几行（哪一琴格）、多久"，并且**点一下就响**。对照 noteDigger：
 * 左侧钢琴键盘、顶部时间尺（秒 + 小节号）、中间音高×时间网格、音符块。
 *
 * 这一版在上一版基础上加了（用户 m01788 的 1–5 条）：
 *  · 频谱能量直接铺在格子里当热力图（独立的频谱面板撤掉，把地方全给表格）
 *  · 键盘画成真实键形（白键连续、黑键窄条压在两个白键交界上）
 *  · 点某一行 = 播这个音高，并在右上角显示它的音名 + 简谱数字
 *  · 两种点击模式：绘制（画音 / 确认）与选择（只试听），反引号切
 *  · 吸附三档（格点 / 拍 / 小节线）、重复区间（时间尺上 shift 拖）、放大与自动翻页
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BIN_COUNT, MIDI_HIGH, MIDI_LOW, keyJpsName, midiToName, midiToNumber } from '../analysis/pitchNames'
import { displayValue } from '../analysis/spectrum'
import { beatMs, snapMs, snapMsFloor } from '../jps/snap'
import { barStartTick, isBarStartTick } from '../jps/bars'
import { COPY } from '../brand/copy'
import { msToX, pickTickSeconds, spanMs, xToMs } from './timeAxis'
import type { PitchMode, View } from '../model/store'
import type { EditMode, LoopRange, RawNote, SnapMode, Spectrum } from '../model/types'

interface Props {
  notes: RawNote[]
  spectrum: Spectrum | null
  /** 只看人声区（G3–C6）：区外的格子压暗到 0.12，减少伴奏干扰 */
  bandOnly: boolean
  durationMs: number
  bpm: number
  beatsPerBar: number
  /** 弱起拍数：第 1 小节拍线/小节号要按它少画几拍（0 = 整小节） */
  pickupBeats: number
  firstBeatMs: number
  pitchMode: PitchMode
  tonic: number
  mode: EditMode
  snap: SnapMode
  view: View
  loop: LoopRange | null
  loopOn: boolean
  /** 热力图显示倍率（1 = 原样，越大越亮） */
  gain: number
  /** 热力图对比（指数，越大反差越强） */
  contrast: number
  selectedId: string | null
  playMs: number
  onSelect: (id: string | null) => void
  onSeek: (ms: number) => void
  onAudition: (midi: number) => void
  onAdd: (n: { midi: number; startMs: number; endMs: number }) => string
  onPatch: (id: string, patch: Partial<Pick<RawNote, 'midi' | 'startMs' | 'endMs'>>) => void
  onRemove: (id: string) => void
  onToggleConfirmed: (id: string) => void
  /* 一次拖动 = 一步撤销（用户 m05736） */
  onBeginEdit: () => void
  onEndEdit: () => void
  /* 键盘上方那把锁：锁住竖着换音区（用户 m05515） */
  lockPitch: boolean
  onToggleLock: () => void
  onView: (v: View) => void
  onLoop: (r: LoopRange | null) => void
}

const KEY_W = 66
const RULER_H = 36
const ROW_H = 14
const EDGE_PX = 8
const FONT = '10px ui-monospace, Consolas, monospace'

/** 黑键音级（C# D# F# G# A#） */
const BLACK = new Set([1, 3, 6, 8, 10])

/** 调号写法：jps 里的 `$B` 显示成 `bB`（简谱习惯），升号照旧 `#F` */
function keyLabel(tonic: number): string {
  return keyJpsName(tonic).replace('$', 'b')
}

/* ── 热力图配色：暗蓝 → 紫 → 橙 → 白 ── */
/* 冷热：低=蓝，高=红（用户 2026-11-18 指定"红最高、蓝最低"） */
const STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [5, 12, 40]],
  [0.35, [18, 60, 140]],
  [0.55, [26, 120, 190]],
  [0.7, [90, 190, 180]],
  [0.82, [220, 200, 80]],
  [0.9, [245, 150, 50]],
  [0.96, [240, 80, 50]],
  [1.0, [235, 40, 40]],
]

/** 倍率 × 对比：把 0..1 的显示值映射成颜色深度（口径同 noteDigger：pow(v, contrast) * multiple） */
function shade(v: number, gain: number, contrast: number): number {
  return Math.max(0, Math.min(1, Math.pow(Math.max(0, v), contrast) * gain))
}

/** 颜色表：暗蓝 → 紫 → 橙 → 白 */
function heatColor(v: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, v))
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i]
    const [t0, c0] = STOPS[i - 1]
    if (t <= t1) {
      const k = (t - t0) / Math.max(1e-6, t1 - t0)
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ]
    }
  }
  return STOPS[STOPS.length - 1][1]
}

interface Metrics {
  w: number
  h: number
  /** 网格左边界（键盘右侧） */
  left: number
  /** 网格宽度 */
  width: number
  /** 最上面一行对应的 midi */
  top: number
  /** 能显示多少行 */
  rows: number
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'loop'; anchorMs: number; moved: boolean }
  /** 拖重复区间的左/右端；grabMs 记按下时鼠标对应的时间，拖动时整体平移用 */
  | { kind: 'loopEdge'; edge: 'l' | 'r'; startMs: number; endMs: number }
  | { kind: 'loopMove'; grabMs: number; startMs: number; endMs: number }
  | {
      kind: 'move'
      id: string
      grabMs: number
      grabY: number
      midi: number
      startMs: number
      endMs: number
      moved: boolean
    }
  | { kind: 'resize'; id: string; startMs: number }
  | { kind: 'create'; id: string; startMs: number; moved: boolean }
  /** 按在钢琴键上（只用来做高亮，松手就清） */
  | { kind: 'key'; midi: number }

export function NoteRoll(props: Props) {
  const { notes, spectrum, durationMs, view, playMs, mode, bandOnly } = props
  const wrapRef = useRef<HTMLDivElement | null>(null)
  /* 画布自己的容器：尺寸必须按它量，不能按整块面板量（面板里还有标题条和滚动条，
   * 按面板量会让画布被 flex 压扁，点击 y 坐标跟着错行 —— 用户 m04792 第二条） */
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [center, setCenter] = useState(76)
  const [hoverMidi, setHoverMidi] = useState<number | null>(null)
  /* 按下未松的琴键：整格高亮成黄色（用户 m04380） */
  const [pressMidi, setPressMidi] = useState<number | null>(null)
  /* 鼠标在画布里的 y（用来判断要不要显示悬浮信息；时间尺上不显示） */
  const [hoverY, setHoverY] = useState<number | null>(null)
  /* 按住 Alt 临时当绘制模式用（用户 m05672）：选择模式下 Alt 一按就能画，松开回到选择 */
  const [altHeld, setAltHeld] = useState(false)
  const drag = useRef<Drag | null>(null)

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(false)
    }
    const blur = () => setAltHeld(false)
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
    }
  }, [])


  /* 尺寸跟随容器 */
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  /* 频谱归一化：中位数当"噪底"（压到最蓝），99.5 分位当"满格"（最红）。
   * 这样底噪不会糊成一片中间色，倍率/对比才有可调空间。 */
  const norm = useMemo(() => {
    if (!spectrum || spectrum.data.length === 0) return { lo: 0, span: 1 }
    const vals: number[] = []
    const step = Math.max(1, Math.floor(spectrum.data.length / 4096))
    for (let i = 0; i < spectrum.data.length; i += step) vals.push(displayValue(spectrum.data[i]))
    vals.sort((a, b) => a - b)
    const mid = vals[Math.floor(vals.length * 0.5)] ?? 0
    const hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))] ?? 1
    const lo = mid * 0.85
    return { lo, span: hi - lo > 1e-6 ? hi - lo : 1 }
  }, [spectrum])
  const metrics = useMemo<Metrics>(() => {
    const rows = Math.max(8, Math.floor((size.h - RULER_H) / ROW_H))
    let top = Math.min(MIDI_HIGH, Math.round(center + Math.floor(rows / 2)))
    if (top - rows + 1 < MIDI_LOW) top = MIDI_LOW + rows - 1
    return { w: size.w, h: size.h, left: KEY_W, width: Math.max(80, size.w - KEY_W), top, rows }
  }, [size, center])

  /* dev-only：把行高/顶行暴露出去，`npm run probe` 才能算出某个音的像素位置 */
  useEffect(() => {
    if (import.meta.env.DEV) {
      ;(window as unknown as { __bpRoll?: unknown }).__bpRoll = { ...metrics, rulerH: RULER_H }
    }
  }, [metrics])

  const rowTop = useCallback(
    (midi: number) => RULER_H + (metrics.top - midi) * ROW_H,
    [metrics.top],
  )
  const midiAt = useCallback(
    (y: number) => {
      const row = Math.floor((y - RULER_H) / ROW_H)
      return metrics.top - row
    },
    [metrics.top],
  )
  const xAt = useCallback(
    (ms: number) => msToX(ms, view, durationMs, metrics.left, metrics.width),
    [durationMs, metrics.left, metrics.width, view],
  )
  const msAt = useCallback(
    (x: number) => xToMs(x, view, durationMs, metrics.left, metrics.width),
    [durationMs, metrics.left, metrics.width, view],
  )
  const label = useCallback(
    (midi: number) => {
      const n = midiToNumber(midi, props.tonic)
      return props.pitchMode === 'number' ? n.text : midiToName(midi)
    },
    [props.pitchMode, props.tonic],
  )

  /* ── 画 ── */
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || metrics.w <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(metrics.w * dpr)
    cv.height = Math.round(metrics.h * dpr)
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, metrics.w, metrics.h)
    g.fillStyle = '#0d1117'
    g.fillRect(0, 0, metrics.w, metrics.h)

    const bottomMidi = metrics.top - metrics.rows + 1
    const beat = beatMs(props.bpm)

    /* 1) 频谱热力图：以"最小绘制格"（1/16 拍 × 一个半音，用户 m04517）为单位
     *   —— 一格之内同一种颜色（阶梯式，不做线性插值），格子里取该格覆盖帧的最大值。
     *   一格不足 1 像素时才按整数倍合并（否则整曲铺满要画十几万个方块），
     *   平时就老老实实按 1/16 拍一格画，跟音符的最小格对齐。 */
    if (spectrum && props.bpm > 0) {
      const cellMin = beat / 16 /* 与最小绘制格一致：1/16 拍 */
      const w0 = xAt(props.firstBeatMs + cellMin) - xAt(props.firstBeatMs)
      const merge = Math.max(1, Math.ceil(1 / Math.max(0.01, w0)))
      const cellMs = cellMin * merge
      const firstAt = props.firstBeatMs
      const cellW = Math.max(1, xAt(firstAt + cellMs) - xAt(firstAt))
      const k0 = Math.floor((view.panMs - firstAt) / cellMs) - 1
      const k1 = Math.ceil((view.panMs + spanMs(view, durationMs) - firstAt) / cellMs) + 1
      const hop = spectrum.hopMs
      const frames = spectrum.frames
      for (let k = k0; k <= k1; k++) {
        const ms0 = firstAt + k * cellMs
        if (ms0 < 0 || ms0 > durationMs) continue
        const x = xAt(ms0)
        if (x + cellW < metrics.left || x > metrics.w) continue
        const f0 = Math.max(0, Math.floor(ms0 / hop))
        const f1 = Math.min(frames, Math.max(f0 + 1, Math.ceil((ms0 + cellMs) / hop)))
        for (let r = 0; r < metrics.rows; r++) {
          const midi = metrics.top - r
          if (midi < MIDI_LOW) break
          const bin = midi - MIDI_LOW
          let v = 0
          for (let f = f0; f < f1; f++) {
            const s = spectrum.data[f * BIN_COUNT + bin]
            if (s > v) v = s
          }
          const t = shade((displayValue(v) - norm.lo) / norm.span, props.gain, props.contrast)
          if (t <= 0.02) continue
          /* 只看人声区：G3(55)–C6(84) 之外压暗到 0.12，减少伴奏干扰（用户 m06504 的便宜方案） */
          const outOfBand = bandOnly && (midi < 55 || midi > 84)
          const [cr, cg, cb] = heatColor(t)
          g.fillStyle = outOfBand ? `rgba(${cr},${cg},${cb},0.12)` : `rgb(${cr},${cg},${cb})`
          const x0 = Math.max(metrics.left, x)
          const x1 = Math.min(metrics.w, x + cellW)
          if (x1 <= x0) continue
          g.fillRect(x0, RULER_H + r * ROW_H, x1 - x0, ROW_H)
        }
      }
    }

    /* 2) 行底色：黑键行压暗；每八度（C 音）一条实线横线 */
    for (let r = 0; r < metrics.rows; r++) {
      const midi = metrics.top - r
      if (midi < MIDI_LOW) break
      const y = RULER_H + r * ROW_H
      if (BLACK.has(midi % 12)) {
        g.fillStyle = 'rgba(0,0,0,0.30)'
        g.fillRect(metrics.left, y, metrics.width, ROW_H)
      }
    }
    /* 八度线（C 行）：实线，比拍线细一点、偏蓝 */
    for (let r = 0; r <= metrics.rows; r++) {
      const midi = metrics.top - r
      if (midi < MIDI_LOW - 1) break
      if (((midi % 12) + 12) % 12 !== 0) continue
      const y = RULER_H + r * ROW_H - 0.5
      g.strokeStyle = 'rgba(120,180,255,0.30)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(metrics.left, y)
      g.lineTo(metrics.w, y)
      g.stroke()
    }

    /* 3) 时间格：小节线实线最亮、拍线实线、1/4 拍虚线 */
    if (props.bpm > 0) {
      const first = props.firstBeatMs
      const barOpt = { beatsPerBar: props.beatsPerBar, pickupBeats: props.pickupBeats }
      const span = spanMs(view, durationMs)
      /* 3a) 1/4 拍虚线 */
      const quarter = beat / 4
      g.setLineDash([2, 3])
      g.strokeStyle = 'rgba(180,205,235,0.16)'
      g.lineWidth = 1
      const q0 = Math.floor((view.panMs - first) / quarter)
      const q1 = Math.ceil((view.panMs + span - first) / quarter)
      for (let i = q0; i <= q1; i++) {
        const ms = first + i * quarter
        if (ms < 0 || ms > durationMs) continue
        if (i % 4 === 0) continue
        const x = Math.round(xAt(ms)) + 0.5
        if (x < metrics.left || x > metrics.w) continue
        g.beginPath()
        g.moveTo(x, RULER_H)
        g.lineTo(x, metrics.h)
        g.stroke()
      }
      g.setLineDash([])
      /* 3b) 拍线（实线）与小节线（更亮） */
      const t0 = Math.max(0, Math.floor((view.panMs - first) / beat))
      const count = Math.ceil(span / beat) + 2
      for (let i = t0; i <= t0 + count; i++) {
        const ms = first + i * beat
        if (ms < 0 || ms > durationMs) continue
        const x = Math.round(xAt(ms)) + 0.5
        if (x < metrics.left || x > metrics.w) continue
        const isBar = isBarStartTick(i * 4, barOpt)
        g.strokeStyle = isBar ? 'rgba(150,200,255,0.50)' : 'rgba(255,255,255,0.16)'
        g.lineWidth = isBar ? 1.5 : 1
        g.beginPath()
        g.moveTo(x, isBar ? 0 : RULER_H)
        g.lineTo(x, metrics.h)
        g.stroke()
      }
      g.lineWidth = 1
    }

    /* 4) 重复区间：琥珀色半透明块 + 两端握柄（可以拖着改长短）
     * 样式照 noteDigger 那张图：整段填充、左右各一根竖握柄、时间尺上也有对应的一段。 */
    if (props.loop) {
      const x1 = xAt(props.loop.startMs)
      const x2 = xAt(props.loop.endMs)
      const on = props.loopOn
      g.fillStyle = on ? 'rgba(255,181,60,0.10)' : 'rgba(255,181,60,0.05)'
      g.fillRect(x1, RULER_H, Math.max(1, x2 - x1), metrics.h - RULER_H)
      /* 时间尺上也标一段，拖时间轴时能看出去哪了 */
      g.fillStyle = on ? 'rgba(255,181,60,0.55)' : 'rgba(255,181,60,0.28)'
      g.fillRect(x1, RULER_H - 4, Math.max(1, x2 - x1), 3)
      g.strokeStyle = on ? 'rgba(255,181,60,0.9)' : 'rgba(255,181,60,0.45)'
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(Math.round(x1) + 0.5, RULER_H)
      g.lineTo(Math.round(x1) + 0.5, metrics.h)
      g.moveTo(Math.round(x2) + 0.5, RULER_H)
      g.lineTo(Math.round(x2) + 0.5, metrics.h)
      g.stroke()
      /* 握柄：竖条 + 中间两道短横线，看着就知道能拖 */
      for (const hx of [x1, x2]) {
        const w = 7
        g.fillStyle = on ? '#ffb53c' : 'rgba(255,181,60,0.6)'
        g.beginPath()
        g.roundRect(hx - w / 2, RULER_H + 2, w, metrics.h - RULER_H - 4, 3)
        g.fill()
        g.strokeStyle = 'rgba(40,28,8,0.55)'
        g.lineWidth = 1
        for (let i = -1; i <= 1; i++) {
          g.beginPath()
          g.moveTo(hx - 2, (RULER_H + metrics.h) / 2 + i * 4 + 0.5)
          g.lineTo(hx + 2, (RULER_H + metrics.h) / 2 + i * 4 + 0.5)
          g.stroke()
        }
      }
    }

    /* 5) 音符 */
    for (const n of notes) {
      if (n.midi > metrics.top || n.midi < bottomMidi) continue
      const x1 = xAt(n.startMs)
      const x2 = Math.max(x1 + 2, xAt(n.endMs))
      if (x2 < metrics.left || x1 > metrics.w) continue
      const y = rowTop(n.midi)
      const h = ROW_H - 1
      const sel = n.id === props.selectedId
      /* 确认过的音是"我要扒的谱音"，得在彩虹热力图上跳出来（用户 m06417）：
       * 亮青绿实心 + 深色描边 + 一点外发光，像贴上去的小卡片；没确认的保持灰、别抢眼。 */
      g.fillStyle = n.confirmed ? '#3dffb8' : 'rgba(120,138,156,0.42)'
      g.strokeStyle = sel ? '#ffffff' : n.confirmed ? 'rgba(3,26,20,0.95)' : 'rgba(90,104,120,0.7)'
      g.lineWidth = sel ? 2 : 1.4
      if (n.confirmed) {
        g.shadowColor = 'rgba(0,0,0,0.65)'
        g.shadowBlur = 4
        g.shadowOffsetY = 1
      }
      /* 太短的音（最小格才 30–40ms，折合两三个像素）也要看得见，所以给个最小可视宽度 */
      const w = Math.max(6, x2 - x1)
      g.beginPath()
      g.rect(x1 + 0.5, y + 0.5, w - 1, h)
      g.fill()
      g.stroke()
      g.shadowColor = 'transparent'
      g.shadowBlur = 0
      g.shadowOffsetY = 0
      /* 顶上一条 1px 高光，方块不至于糊成一条线 */
      if (n.confirmed && w > 4) {
        g.fillStyle = 'rgba(255,255,255,0.35)'
        g.fillRect(x1 + 1, y + 1, w - 2, 1)
      }
      const text = label(n.midi)
      if (w > 26 && h >= 11) {
        g.fillStyle = n.confirmed ? '#03251d' : '#c8d4e0'
        g.font = FONT
        g.textBaseline = 'middle'
        g.fillText(text, x1 + 4, y + h / 2 + 0.5, w - 6)
      }
    }

    /* 5.5) 框了播放区间时，区间外面压暗（用户 m03936：外侧波形变暗变灰） */
    if (props.loop && props.loopOn) {
      const x1 = Math.max(metrics.left, xAt(props.loop.startMs))
      const x2 = Math.min(metrics.w, xAt(props.loop.endMs))
      g.fillStyle = 'rgba(6,8,12,0.55)'
      if (x1 > metrics.left) g.fillRect(metrics.left, RULER_H, x1 - metrics.left, metrics.h - RULER_H)
      if (x2 < metrics.w) g.fillRect(x2, RULER_H, metrics.w - x2, metrics.h - RULER_H)
    }

    /* 6) 悬停行高亮 + 右上角信息（用户 m04792 第三条：原来 0.05 太淡，看不见） */
    if (hoverMidi !== null) {
      const y = rowTop(hoverMidi)
      g.fillStyle = 'rgba(120,190,255,0.20)'
      g.fillRect(metrics.left, y, metrics.width, ROW_H)
      g.strokeStyle = 'rgba(150,210,255,0.45)'
      g.lineWidth = 1
      g.strokeRect(metrics.left + 0.5, y + 0.5, metrics.width - 1, ROW_H - 1)
    }

    /* 7) 时间尺 */
    g.fillStyle = '#141a23'
    g.fillRect(0, 0, metrics.w, RULER_H)
    g.fillStyle = 'rgba(255,255,255,0.10)'
    g.fillRect(0, RULER_H - 1, metrics.w, 1)
    const tickS = pickTickSeconds(view, durationMs, metrics.width)
    g.font = FONT
    g.textBaseline = 'middle'
    for (let ms = 0; ms <= durationMs; ms += tickS * 1000) {
      const x = xAt(ms)
      if (x < metrics.left - 1 || x > metrics.w) continue
      g.strokeStyle = 'rgba(255,255,255,0.18)'
      g.beginPath()
      g.moveTo(Math.round(x) + 0.5, RULER_H - 5)
      g.lineTo(Math.round(x) + 0.5, RULER_H - 1)
      g.stroke()
      g.fillStyle = 'rgba(200,214,230,0.75)'
      const s = ms / 1000
      const txt = s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s}s`
      g.fillText(txt, x + 3, RULER_H / 2 - 3)
    }
    if (props.bpm > 0) {
      const beat = beatMs(props.bpm)
      const tickMs = beat / 4
      const barOpt = { beatsPerBar: props.beatsPerBar, pickupBeats: props.pickupBeats }
      for (let bar = 0; ; bar++) {
        /* 小节线不是等宽的：弱起时第 1 小节只占 pickupBeats 拍 */
        const ms = props.firstBeatMs + barStartTick(bar, barOpt) * tickMs
        if (ms > durationMs) break
        if (ms < 0) continue
        const x = xAt(ms)
        if (x < metrics.left || x > metrics.w) continue
        g.fillStyle = 'rgba(140,200,255,0.9)'
        g.fillText(String(bar + 1), x + 3, RULER_H - 5)
      }
    }

    /* 8) 左侧钢琴键盘（用户 m04234 的口径）
     *  · 从左侧看：白键一个挨一个、**高度全都一样**，横向分界线只出现在"两个白键相接"处
     *    （E|F、B|C）—— 别的地方不该有线，否则看着像梯子
     *  · 从右侧看：黑键和白键露出的那一格**高度也一样**，黑键右侧贴住键列右边缘、整行高
     *  · 数字模式：在当前调式的音级上，靠左侧白格内写简谱数字（带八度点）；音名模式照旧标 C */
    const KEY_BLACK_W = Math.round(KEY_W * 0.62)
    const KEY_BLACK_X = KEY_W - KEY_BLACK_W
    g.fillStyle = '#ffffff'
    g.fillRect(0, RULER_H, KEY_W, metrics.h - RULER_H)

    /* 白键不是矩形：它的左半边会伸进相邻黑键格里的一半，于是长成 L / J / T 三种形状
     * （用户 m05078）。这里算白键左块的上/下边界：
     *   上方是黑键 → 到那条黑键的竖直中心为止；上方是白键（E|F、B|C）→ 到本格上边界
     *   下方同理。黑键只占右侧 62%，所以左块不会压到黑键。 */
    const bandOf = (cls: number, top: number) => {
      const up = (cls + 1) % 12
      const down = (cls + 11) % 12
      const t = BLACK.has(up) ? top - ROW_H / 2 : top
      const b = BLACK.has(down) ? top + ROW_H + ROW_H / 2 : top + ROW_H
      return { t: Math.max(RULER_H, t), b: Math.min(metrics.h, b) }
    }

    const fillWhiteKey = (cls: number, y: number) => {
      const { t, b } = bandOf(cls, y)
      g.fillRect(0, t, KEY_BLACK_X, b - t) // 左块（伸进黑键格的一半）
      g.fillRect(KEY_BLACK_X, y, KEY_BLACK_W, ROW_H) // 本格右边那截（L/J/T 的"脚"）
    }

    for (let r = 0; r < metrics.rows; r++) {
      const midi = metrics.top - r
      if (midi < MIDI_LOW) break
      const y = RULER_H + r * ROW_H
      const cls = ((midi % 12) + 12) % 12
      /* 当前行（鼠标所在行）/ 按下的琴键：按"键的形状"压黄（用户 m04380、m04987、m05078）。
       * 白键按 L/J/T 的形状压（左块比本格高半格到一格），黑键只有它自己那块变黄。 */
      const lit = pressMidi === midi ? 1 : hoverMidi === midi ? 0.85 : 0
      const litFill = lit >= 1 ? '#ffc83c' : '#f2b53c'
      if (BLACK.has(cls)) {
        /* 黑键：I 形，右侧贴边、整行高（用户 m04792 第一条） */
        g.fillStyle = lit > 0 ? litFill : '#000000'
        g.beginPath()
        g.roundRect(KEY_BLACK_X, y, KEY_BLACK_W, ROW_H, [2, 0, 0, 2])
        g.fill()
      } else if (lit > 0) {
        g.fillStyle = litFill
        fillWhiteKey(cls, y)
      }
    }

    /* 分界线画在高亮之上：黑键行在它竖直中心画一条短线（两个白键的分界藏在黑键中间），
     * E|F 与 B|C 之间没有黑键，整格通栏（画在 E / B 的上边界 —— 行是往下走的，用户 m04987） */
    for (let r = 0; r < metrics.rows; r++) {
      const midi = metrics.top - r
      if (midi < MIDI_LOW) break
      const y = RULER_H + r * ROW_H
      const cls = ((midi % 12) + 12) % 12
      g.fillStyle = 'rgba(0,0,0,0.45)'
      if (BLACK.has(cls)) g.fillRect(0, y + ROW_H / 2 - 0.5, KEY_BLACK_X, 1)
      else if (cls === 4 || cls === 11) g.fillRect(0, y - 0.5, KEY_W, 1)
    }

    for (let r = 0; r < metrics.rows; r++) {
      const midi = metrics.top - r
      if (midi < MIDI_LOW) break
      const y = RULER_H + r * ROW_H
      const cls = ((midi % 12) + 12) % 12
      const lit = pressMidi === midi ? 1 : hoverMidi === midi ? 0.85 : 0
      g.font = FONT
      g.textBaseline = 'middle'

      /* 黑格行：数字写在**黑键块里面**、颜色反相（黑键上浅字、高亮成黄时改回深字），用户 m05415 */
      if (BLACK.has(cls)) {
        if (props.pitchMode !== 'number') continue
        /* 距黑格左缘的留白跟白格一样（都是 5px），用户 m05580 */
        g.fillStyle = lit > 0 ? 'rgba(30,44,60,0.95)' : '#e8f1fb'
        g.fillText(midiToNumber(midi, props.tonic).text, KEY_BLACK_X + 5, y + ROW_H / 2)
        continue
      }

      /* 白格行（用户 m05224 + m05331 + m05374）：按当前调式标音级，半音也标
       * （bB 调里 B 自然就是 `1#`、E 自然就是 `4#`），即 `text` 原样写、不过滤 accidental；
       * 位置取白键左块的竖直正中（L/J/T 那条"腿"的中间）。 */
      const band = bandOf(cls, y)
      const cy = (band.t + band.b) / 2
      /* 白键左块里也有分界线（黑键中心那条），先描一圈白边再填字，免得线把字割成两半 */
      g.lineWidth = 2.5
      g.strokeStyle = 'rgba(255,255,255,0.95)'
      g.fillStyle = 'rgba(30,44,60,0.9)'
      const text =
        props.pitchMode === 'number' ? midiToNumber(midi, props.tonic).text : cls === 0 || midi === MIDI_LOW ? midiToName(midi) : ''
      if (text) {
        g.strokeText(text, 5, cy)
        g.fillText(text, 5, cy)
      }
    }
    g.fillStyle = 'rgba(8,12,18,0.9)'
    g.fillRect(KEY_W - 1, RULER_H, 1, metrics.h - RULER_H)
    /* 8.5) 时间尺左边那格：当前调号（形如 1=bB，用户 m04234）+ 右边一把锁（用户 m05515） */
    g.fillStyle = 'rgba(170,205,240,0.92)'
    g.font = '700 13px ui-monospace, Consolas, monospace'
    g.textBaseline = 'middle'
    g.fillText(`1=${keyLabel(props.tonic)}`, 5, RULER_H / 2)

    /* 锁图标：锁上时实心、开锁时淡一点；点它切"锁住竖着换音区"。
     * 位置固定在调号右边（键列右上角），命中区在下面 pointerdown 里按 LOCK_BOX 判。 */
    const lx = KEY_W - 14
    const ly = RULER_H / 2
    g.strokeStyle = props.lockPitch ? 'rgba(255,206,64,0.95)' : 'rgba(150,180,215,0.75)'
    g.fillStyle = props.lockPitch ? 'rgba(255,206,64,0.95)' : 'rgba(150,180,215,0.55)'
    g.lineWidth = 1.4
    /* 锁体 */
    g.beginPath()
    g.roundRect(lx - 5, ly - 1, 10, 7, 1.5)
    g.fill()
    /* 锁梁（锁上时闭合、开锁时偏到一侧） */
    g.beginPath()
    g.arc(lx - (props.lockPitch ? 0 : 3), ly - 2.5, 3, Math.PI, 0)
    g.stroke()
    /* 9) 播放头 */
    const px = xAt(playMs)
    if (px >= metrics.left) {
      g.strokeStyle = '#ff4d6a'
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(px, 0)
      g.lineTo(px, metrics.h)
      g.stroke()
    }
  }, [
    spectrum,
    metrics,
    notes,
    props.bpm,
    props.gain,
    props.contrast,
    props.beatsPerBar,
    props.pickupBeats,
    props.firstBeatMs,
    props.loop,
    props.selectedId,
    props.tonic,
    props.pitchMode,
    view,
    durationMs,
    playMs,
    hoverMidi,
    pressMidi,
    label,
    rowTop,
    xAt,
  ])

  /* ── 滚轮（用户 2026-11-18 指定）──
   *  普通        = 上下换音区
   *  Shift       = 左右平移（"移动波形"）
   *  Shift + Alt = 横向缩放（时值比率；Ctrl+滚轮 也保留，方便戴鼠标惯用 Ctrl 的人） */
  useEffect(() => {
    /* 挂在整块面板上而不是 canvas 上：鼠标在画布边缘/占位文字/滚动条上方滚动也算数，
     * 不用先点一下才生效 */
    const cv = canvasRef.current
    const host = wrapRef.current
    if (!cv || !host) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      /* 缩放只认 Ctrl（macOS 的 Cmd 也认）；Shift+Alt 那套已按用户 m06188 取消 */
      const wantZoom = e.ctrlKey || e.metaKey
      if (wantZoom) {
        const rect = cv.getBoundingClientRect()
        const anchorMs = msAt(e.clientX - rect.left)
        /* 以光标下的时刻为锚点缩放：光标指着的那一拍不动，两边伸缩 */
        const factor = e.deltaY > 0 ? 0.8 : 1.25
        const zoom = Math.max(1, Math.min(64, view.zoom * factor))
        const span = durationMs / Math.max(1, zoom)
        const frac = (anchorMs - view.panMs) / spanMs(view, durationMs)
        props.onView({ zoom, panMs: Math.max(0, anchorMs - frac * span) })
        return
      }
      if (e.shiftKey) {
        /* 平移：一次挪视野宽度的 12%，滚得快就挪得多 */
        const span = spanMs(view, durationMs)
        const maxPan = Math.max(0, durationMs - span)
        const panMs = Math.max(0, Math.min(maxPan, view.panMs + (e.deltaY > 0 ? span : -span) * 0.12))
        props.onView({ zoom: view.zoom, panMs })
        return
      }
      /* 竖着换音区：锁住的时候滚轮改走横着平移（用户 m05515 的锁 + m05608），解锁恢复上下 */
      const horizontal = e.shiftKey || props.lockPitch
      if (horizontal) {
        const span = spanMs(view, durationMs)
        const maxPan = Math.max(0, durationMs - span)
        const panMs = Math.max(0, Math.min(maxPan, view.panMs + (e.deltaY > 0 ? span : -span) * 0.12))
        props.onView({ zoom: view.zoom, panMs })
        return
      }
      setCenter((c) => Math.max(MIDI_LOW, Math.min(MIDI_HIGH, c - Math.sign(e.deltaY) * 2)))
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [durationMs, msAt, props, view])

  /* ── 指针交互 ── */
  /* 重复区间的三块热区：左握柄 / 右握柄 / 整段（先判它们，再判音符） */
  const loopHit = useCallback(
    (x: number): 'l' | 'r' | 'body' | null => {
      const r = props.loop
      if (!r) return null
      const x1 = xAt(r.startMs)
      const x2 = xAt(r.endMs)
      if (Math.abs(x - x1) <= 6) return 'l'
      if (Math.abs(x - x2) <= 6) return 'r'
      if (x > x1 && x < x2) return 'body'
      return null
    },
    [props.loop, xAt],
  )

  const noteAt = useCallback(
    (x: number, y: number): RawNote | null => {
      const midi = midiAt(y)
      if (midi < MIDI_LOW || midi > MIDI_HIGH) return null
      for (const n of notes) {
        if (n.midi !== midi) continue
        const x1 = xAt(n.startMs)
        const x2 = Math.max(x1 + 3, xAt(n.endMs))
        if (x >= x1 - 1 && x <= x2 + 1) return n
      }
      return null
    },
    [midiAt, notes, xAt],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      e.currentTarget.setPointerCapture(e.pointerId)
      props.onBeginEdit()
      /* Alt 临时绘制：除了 keydown 记的 altHeld，也认事件自带的 altKey（用户 m05672） */
      const draw = mode === 'draw' || altHeld || e.altKey

      if (y < RULER_H) {
        /* 键列右上角那把锁：只切"锁住竖着换音区"，不挪播放头（用户 m05515） */
        if (x >= KEY_W - 22 && x <= KEY_W - 2) {
          props.onToggleLock()
          return
        }
        /* 时间尺：点一下 = 把播放头挪到这里并准备播放；按住拖 = 圈出播放区间（拖到哪算到哪） */
        const ms = snapMs(msAt(x), { bpm: props.bpm, beatsPerBar: props.beatsPerBar, pickupBeats: props.pickupBeats, firstBeatMs: props.firstBeatMs }, 'off')
        drag.current = { kind: 'loop', anchorMs: ms, moved: false }
        props.onSeek(ms)
        return
      }

      if (x < KEY_W) {
        const midi = midiAt(y)
        if (midi >= MIDI_LOW && midi <= MIDI_HIGH) {
          props.onAudition(midi)
          /* 按下时这一格高亮成黄色，松手/移出就灭（用户 m04380） */
          setPressMidi(midi)
          drag.current = { kind: 'key', midi }
        }
        return
      }

      const hit = noteAt(x, y)
      const rawMs = msAt(x)
      /* 先看是不是在重复区间上：握柄改长短、中间拖整段（任何模式下都能拖） */
      const lh = loopHit(x)
      if (lh === 'l' || lh === 'r') {
        const r = props.loop
        if (r) drag.current = { kind: 'loopEdge', edge: lh, startMs: r.startMs, endMs: r.endMs }
        return
      }
      /* 区间带内部不再"拖整段"（用户 m03712 第 4 条：区间里点格子也要试听 + 定位当前时点）。
       * 想整体挪区间：拖两端握柄，或在时间尺上重新划一段。 */
      if (hit) {
        props.onSelect(hit.id)
        props.onAudition(hit.midi)
        props.onSeek(hit.startMs)
        if (!draw) return
        if (x >= xAt(hit.endMs) - EDGE_PX) {
          drag.current = { kind: 'resize', id: hit.id, startMs: hit.startMs }
        } else {
          drag.current = {
            kind: 'move',
            id: hit.id,
            grabMs: rawMs,
            grabY: y,
            midi: hit.midi,
            startMs: hit.startMs,
            endMs: hit.endMs,
            moved: false,
          }
        }
        return
      }

      props.onSelect(null)
      props.onAudition(midiAt(y))
      props.onSeek(rawMs)
      if (!draw) return
      const opt = { bpm: props.bpm, beatsPerBar: props.beatsPerBar, pickupBeats: props.pickupBeats, firstBeatMs: props.firstBeatMs }
      /* 起点取"光标所在的那一格"（向下取整），不是最近的格点 ——
       * 否则点在格子后半段时，新音会跑到十字准星右边一格，用户看到的就是"偏右上角"。 */
      const startMs = snapMsFloor(rawMs, opt, props.snap)
      const id = props.onAdd({
        midi: midiAt(y),
        startMs,
        endMs: startMs + beatMs(props.bpm) / 16, /* 新画的音先给最小格（1/16 拍），要长就往右拖 */
      })
      drag.current = { kind: 'create', id, startMs, moved: false }
    },
    [msAt, midiAt, mode, altHeld, noteAt, props, xAt],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      setHoverY(y)
      setHoverMidi(y >= RULER_H ? midiAt(y) : null)

      const d = drag.current
      if (!d) {
        /* 没在拖的时候：握柄上是左右箭头；绘制模式下停在音符右缘也是左右箭头（用户 m05780：
         * 得让用户看得出来这里能调时值）；其余一律普通箭头（m04626 说过不要十字）。 */
        const lh = loopHit(x)
        const edge =
          (mode === 'draw' || altHeld) &&
          (() => {
            const hit = noteAt(x, y)
            return !!hit && x >= xAt(hit.endMs) - EDGE_PX
          })()
        e.currentTarget.style.cursor = lh === 'l' || lh === 'r' || edge ? 'ew-resize' : 'default'
        return
      }
      const opt = { bpm: props.bpm, beatsPerBar: props.beatsPerBar, pickupBeats: props.pickupBeats, firstBeatMs: props.firstBeatMs }
      if (d.kind === 'scrub') {
        props.onSeek(snapMs(msAt(x), opt, props.snap))
        return
      }
      if (d.kind === 'loop') {
        const ms = snapMs(msAt(x), opt, 'beat')
        /* 拖过一像素才算"圈区间"，否则松手就是单纯点了下时间线 */
        if (!d.moved && Math.abs(ms - d.anchorMs) < 20) return
        d.moved = true
        e.currentTarget.style.cursor = 'ew-resize'
        props.onLoop({ startMs: Math.max(0, Math.min(d.anchorMs, ms)), endMs: Math.max(d.anchorMs, ms) })
        return
      }
      if (d.kind === 'loopEdge') {
        const ms = snapMs(msAt(x), opt, 'beat')
        if (d.edge === 'l') {
          const start = Math.min(ms, d.endMs - beatMs(props.bpm) / 2)
          props.onLoop({ startMs: Math.max(0, start), endMs: d.endMs })
        } else {
          const end = Math.max(ms, d.startMs + beatMs(props.bpm) / 2)
          props.onLoop({ startMs: d.startMs, endMs: Math.min(props.durationMs, end) })
        }
        return
      }
      if (d.kind === 'loopMove') {
        const delta = msAt(x) - d.grabMs
        const len = d.endMs - d.startMs
        let start = d.startMs + delta
        start = Math.max(0, Math.min(props.durationMs - len, start))
        props.onLoop({ startMs: start, endMs: start + len })
        return
      }
      if (d.kind === 'move') {
        const delta = msAt(x) - d.grabMs
        const dRow = Math.round((d.grabY - y) / ROW_H) /* 往上拖 = 升 key，一格一个半音 */
        if (!d.moved && Math.abs(delta) < beatMs(props.bpm) / 8 && dRow === 0) return
        d.moved = true
        const start = snapMs(d.startMs + delta, opt, props.snap)
        props.onPatch(d.id, {
          startMs: start,
          endMs: start + (d.endMs - d.startMs),
          midi: Math.max(MIDI_LOW, Math.min(MIDI_HIGH, d.midi + dRow)),
        })
        return
      }
      if (d.kind === 'resize') {
        const end = snapMs(msAt(x), opt, props.snap)
        props.onPatch(d.id, { endMs: Math.max(d.startMs + beatMs(props.bpm) / 4, end) })
        return
      }
      if (d.kind === 'create') {
        const end = snapMs(msAt(x), opt, props.snap)
        if (end > d.startMs) {
          d.moved = true
          props.onPatch(d.id, { endMs: end })
        }
      }
    },
    [midiAt, msAt, props],
  )

  const onPointerUp = useCallback(() => {
    props.onEndEdit()
    const d = drag.current
    drag.current = null
    setPressMidi(null)

    // 时间尺上"点一下不拖" = 取消播放时段（用户 m03936：单纯点击时间轴取消时段）
    if (d?.kind === 'loop' && !d.moved) props.onLoop(null)
    // 绘制模式下"点一下不拖"= 确认/取消确认
    if (d?.kind === 'move' && !d.moved) props.onToggleConfirmed(d.id)
  }, [props])

  const onContext = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const hit = noteAt(e.clientX - rect.left, e.clientY - rect.top)
      if (!hit) return
      e.preventDefault()
      props.onRemove(hit.id)
    },
    [noteAt, props],
  )

  const hint =
    mode === 'draw'
      ? '绘制：点空格子画音（按住拖长）、点已有的音=确认/取消确认、拖右边缘改时值、右键删'
      : '选择：点哪里都只试听，不改谱'

  return (
    <div className="pane roll" ref={wrapRef}>
      {/* 说明放画布上方一条窄头里，不压时间尺（时间尺上只留刻度和第几小节） */}
      <div className="pane-head">
        <span>音符表</span>
        <span className="dim">{hint}</span>
      </div>
      <div className="roll-host" ref={hostRef}>
      <canvas
        ref={canvasRef}
        style={{
          width: metrics.w,
          height: metrics.h,
          /* 默认箭头（用户 m04626）；握柄上的左右箭头由 pointermove 动态改 */
          cursor: 'default',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHoverMidi(null)
          setHoverY(null)
        }}
        onContextMenu={onContext}
      />
      </div>
      {/* 悬浮信息：跟着鼠标走，但只在音符格区域显示（时间尺上不显示） */}
      {hoverMidi !== null && hoverY !== null && hoverY >= RULER_H && (
        <div className="row-badge">
          {midiToName(hoverMidi)} · {midiToNumber(hoverMidi, props.tonic).text}
          <span className="dim">（点一下试听）</span>
        </div>
      )}
      {notes.length === 0 && (
        <div className="pane-empty">
          {spectrum
            ? '还没有音符：切到「绘制」（反引号键）在格子里点几下，或在右侧勾上「分析后自动填入音符」'
            : '还没有音符：先打开一段音频'}
        </div>
      )}
      <HScroll
        durationMs={props.durationMs}
        view={props.view}
        onPan={(panMs) => props.onView({ zoom: props.view.zoom, panMs })}
      />
    </div>
  )
}

/**
 * 横向滚动条（noteDigger 那条 hscrollbar 的简化版）。
 *
 * 只在放大（视野 < 全曲）时才有意义：thumb 的长度 = 视野占比，位置 = 左边缘；
 * 拖 thumb 平移，点轨道直接跳过去。上面画布用 Shift+滚轮/拖拽也能平移，这条是给鼠标党的。
 */
function HScroll(props: {
  durationMs: number
  view: View
  onPan: (panMs: number) => void
}) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; pan: number } | null>(null)
  const span = spanMs(props.view, props.durationMs)
  const maxPan = Math.max(0, props.durationMs - span)
  /* 一直显示：没放大时 thumb 铺满整条（拖不动），这样用户知道"这里有滚动条"，
   * 放大之后立刻就能拖。 */
  const visible = props.durationMs > 0
  const ratio = props.durationMs > 0 ? Math.min(1, span / props.durationMs) : 1
  const left = maxPan > 0 ? Math.min(1, props.view.panMs / props.durationMs) : 0
  const disabled = maxPan <= 0

  if (!visible) return null
  return (
    <div
      className={disabled ? 'hbar off' : 'hbar'}
      ref={trackRef}
      title={disabled ? COPY.hbarDisabledTip : COPY.hbarTip}
      onPointerDown={(e) => {
        const el = trackRef.current
        if (!el || disabled) return
        const r = el.getBoundingClientRect()
        const t = (e.clientX - r.left) / Math.max(1, r.width)
        const thumbStart = props.view.panMs / props.durationMs
        const thumbSpan = ratio
        /* 点在 thumb 上 → 拖；点在轨道上 → 让视野中心跳到点击处 */
        if (t >= thumbStart && t <= thumbStart + thumbSpan) {
          dragRef.current = { x: e.clientX, pan: props.view.panMs }
        } else {
          props.onPan(Math.max(0, Math.min(maxPan, t * props.durationMs - span / 2)))
        }
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = dragRef.current
        const el = trackRef.current
        if (!d || !el) return
        const r = el.getBoundingClientRect()
        const dx = e.clientX - d.x
        const next = d.pan + (dx / Math.max(1, r.width)) * props.durationMs
        props.onPan(Math.max(0, Math.min(maxPan, next)))
      }}
      onPointerUp={() => {
        dragRef.current = null
      }}
      onPointerCancel={() => {
        dragRef.current = null
      }}
    >
      <i style={{ left: `${left * 100}%`, width: `${Math.max(4, ratio * 100)}%` }} />
    </div>
  )
}
