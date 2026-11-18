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
 *  · 两种点击模式：绘制（画音 / 确认）与选择（只试听），F2 / F3 切
 *  · 吸附三档（格点 / 拍 / 小节线）、重复区间（时间尺上 shift 拖）、放大与自动翻页
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BIN_COUNT, MIDI_HIGH, MIDI_LOW, midiToName, midiToNumber } from '../analysis/pitchNames'
import { displayValue } from '../analysis/spectrum'
import { beatMs, snapMs } from '../jps/snap'
import { msToX, pickTickSeconds, spanMs, xToMs } from './timeAxis'
import type { PitchMode, View } from '../model/store'
import type { EditMode, LoopRange, RawNote, SnapMode, Spectrum } from '../model/types'

interface Props {
  notes: RawNote[]
  spectrum: Spectrum | null
  durationMs: number
  bpm: number
  beatsPerBar: number
  firstBeatMs: number
  pitchMode: PitchMode
  tonic: number
  mode: EditMode
  snap: SnapMode
  view: View
  loop: LoopRange | null
  loopOn: boolean
  selectedId: string | null
  playMs: number
  onSelect: (id: string | null) => void
  onSeek: (ms: number) => void
  onAudition: (midi: number) => void
  onAdd: (n: { midi: number; startMs: number; endMs: number }) => string
  onPatch: (id: string, patch: Partial<Pick<RawNote, 'midi' | 'startMs' | 'endMs'>>) => void
  onRemove: (id: string) => void
  onToggleConfirmed: (id: string) => void
  onView: (v: View) => void
  onLoop: (r: LoopRange | null) => void
}

const KEY_W = 66
const RULER_H = 24
const ROW_H = 14
const EDGE_PX = 8
const FONT = '10px ui-monospace, Consolas, monospace'

/** 黑键音级（C# D# F# G# A#） */
const BLACK = new Set([1, 3, 6, 8, 10])

/* ── 热力图配色：暗蓝 → 紫 → 橙 → 白 ── */
const STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [11, 15, 22]],
  [0.18, [38, 24, 74]],
  [0.42, [124, 45, 106]],
  [0.66, [214, 116, 47]],
  [0.85, [250, 210, 140]],
  [1.0, [255, 255, 255]],
]

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

/** 频谱 → 一张 帧×88 的小图（之后靠 drawImage 缩放，比逐格 fillRect 快几十倍） */
function buildHeat(spec: Spectrum): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, spec.frames)
  cv.height = BIN_COUNT
  const g = cv.getContext('2d')
  if (!g) return cv
  const img = g.createImageData(cv.width, BIN_COUNT)
  for (let f = 0; f < cv.width; f++) {
    for (let y = 0; y < BIN_COUNT; y++) {
      const midi = MIDI_HIGH - y
      const bin = midi - MIDI_LOW
      const v = bin >= 0 && bin < BIN_COUNT ? displayValue(spec.data[f * BIN_COUNT + bin]) : 0
      const [r, gg, b] = heatColor(v)
      const p = (y * cv.width + f) * 4
      img.data[p] = r
      img.data[p + 1] = gg
      img.data[p + 2] = b
      img.data[p + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return cv
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
  | { kind: 'loop'; anchorMs: number }
  /** 拖重复区间的左/右端；grabMs 记按下时鼠标对应的时间，拖动时整体平移用 */
  | { kind: 'loopEdge'; edge: 'l' | 'r'; startMs: number; endMs: number }
  | { kind: 'loopMove'; grabMs: number; startMs: number; endMs: number }
  | { kind: 'move'; id: string; grabMs: number; startMs: number; endMs: number; moved: boolean }
  | { kind: 'resize'; id: string; startMs: number }
  | { kind: 'create'; id: string; startMs: number; moved: boolean }

export function NoteRoll(props: Props) {
  const { notes, spectrum, durationMs, view, playMs, mode } = props
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [center, setCenter] = useState(76)
  const [hoverMidi, setHoverMidi] = useState<number | null>(null)
  const drag = useRef<Drag | null>(null)

  /* 尺寸跟随容器 */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const metrics = useMemo<Metrics>(() => {
    const rows = Math.max(8, Math.floor((size.h - RULER_H) / ROW_H))
    let top = Math.min(MIDI_HIGH, Math.round(center + Math.floor(rows / 2)))
    if (top - rows + 1 < MIDI_LOW) top = MIDI_LOW + rows - 1
    return { w: size.w, h: size.h, left: KEY_W, width: Math.max(80, size.w - KEY_W), top, rows }
  }, [size, center])

  const heat = useMemo(() => (spectrum ? buildHeat(spectrum) : null), [spectrum])

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

    /* 1) 频谱热力图（只铺网格区域，纵向按可见音区裁） */
    if (heat && spectrum) {
      const srcY = Math.max(0, MIDI_HIGH - metrics.top)
      const srcH = Math.min(BIN_COUNT - srcY, metrics.rows)
      const sx = (view.panMs / 1000) / (spectrum.hopMs / 1000)
      const sw = spanMs(view, durationMs) / spectrum.hopMs
      g.globalAlpha = 0.92
      g.drawImage(
        heat,
        Math.max(0, sx),
        srcY,
        Math.max(1, Math.min(heat.width - Math.max(0, sx), sw)),
        srcH,
        metrics.left,
        RULER_H,
        metrics.width,
        srcH * ROW_H,
      )
      g.globalAlpha = 1
    }

    /* 2) 行底色：黑键行压暗、C 行亮线 */
    for (let r = 0; r < metrics.rows; r++) {
      const midi = metrics.top - r
      if (midi < MIDI_LOW) break
      const y = RULER_H + r * ROW_H
      if (BLACK.has(midi % 12)) {
        g.fillStyle = 'rgba(0,0,0,0.30)'
        g.fillRect(metrics.left, y, metrics.width, ROW_H)
      }
      if (midi % 12 === 0) {
        g.fillStyle = 'rgba(120,180,255,0.16)'
        g.fillRect(metrics.left, y + ROW_H - 1, metrics.width, 1)
      }
      g.fillStyle = 'rgba(255,255,255,0.035)'
      g.fillRect(metrics.left, y + ROW_H - 1, metrics.width, 1)
    }

    /* 3) 拍线与小节线 */
    if (props.bpm > 0) {
      const first = props.firstBeatMs
      const t0 = Math.max(0, Math.floor((view.panMs - first) / beat))
      const count = Math.ceil(spanMs(view, durationMs) / beat) + 2
      for (let i = t0; i <= t0 + count; i++) {
        const ms = first + i * beat
        if (ms < 0 || ms > durationMs) continue
        const x = Math.round(xAt(ms)) + 0.5
        const isBar = ((i % Math.max(1, props.beatsPerBar)) + props.beatsPerBar) % props.beatsPerBar === 0
        g.strokeStyle = isBar ? 'rgba(150,200,255,0.34)' : 'rgba(255,255,255,0.10)'
        g.beginPath()
        g.moveTo(x, RULER_H)
        g.lineTo(x, metrics.h)
        g.stroke()
      }
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
      const y = rowTop(n.midi) + 1
      const h = ROW_H - 2
      const sel = n.id === props.selectedId
      g.fillStyle = n.confirmed ? 'rgba(45,214,190,0.92)' : 'rgba(120,138,156,0.42)'
      g.strokeStyle = sel ? '#ffffff' : n.confirmed ? 'rgba(8,40,36,0.85)' : 'rgba(90,104,120,0.7)'
      g.lineWidth = sel ? 2 : 1
      const w = Math.max(3, x2 - x1)
      g.beginPath()
      g.rect(x1 + 0.5, y + 0.5, w - 1, h)
      g.fill()
      g.stroke()
      const text = label(n.midi)
      if (w > 26 && h >= 11) {
        g.fillStyle = n.confirmed ? '#05221e' : '#c8d4e0'
        g.font = FONT
        g.textBaseline = 'middle'
        g.fillText(text, x1 + 4, y + h / 2 + 0.5, w - 6)
      }
    }

    /* 6) 悬停行高亮 + 右上角信息 */
    if (hoverMidi !== null) {
      const y = rowTop(hoverMidi)
      g.fillStyle = 'rgba(255,255,255,0.05)'
      g.fillRect(metrics.left, y, metrics.width, ROW_H)
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
      const perBar = beat * Math.max(1, props.beatsPerBar)
      const firstBar = props.firstBeatMs
      for (let i = 0; ; i++) {
        const ms = firstBar + i * perBar
        if (ms > durationMs) break
        if (ms < 0) continue
        const x = xAt(ms)
        if (x < metrics.left || x > metrics.w) continue
        g.fillStyle = 'rgba(140,200,255,0.9)'
        g.fillText(String(i + 1), x + 3, RULER_H - 5)
      }
    }

    /* 8) 左侧钢琴键盘（真实键形）
     * 白键要连成一片：先把整列铺白，再在白键之间画分隔线，最后把黑键压上去。
     * 上一版按行画白键，黑键所在的那一行就露出底色，看着像一架梯子。 */
    g.fillStyle = '#f2f5f8'
    g.fillRect(0, RULER_H, KEY_W, metrics.h - RULER_H)
    for (let r = 0; r < metrics.rows; r++) {
      const midi = metrics.top - r
      if (midi < MIDI_LOW) break
      const y = RULER_H + r * ROW_H
      const cls = ((midi % 12) + 12) % 12
      /* 每个半音格都画一条边界线（用户要看得出"一格一格"），
       * 白键与白键之间再描重一点，黑键所在行的横线由黑键自己盖住。 */
      const whiteRow = !BLACK.has(cls)
      const whiteAbove = !BLACK.has(((cls + 1) % 12))
      g.fillStyle = whiteRow && whiteAbove ? 'rgba(20,32,48,0.55)' : 'rgba(20,32,48,0.30)'
      g.fillRect(0, y + ROW_H - 1, KEY_W - 1, 1)
      if (cls === 0 || midi === MIDI_LOW) {
        g.fillStyle = 'rgba(40,60,80,0.85)'
        g.font = FONT
        g.textBaseline = 'middle'
        g.fillText(midiToName(midi), 4, y + ROW_H / 2)
      }
    }
    g.fillStyle = 'rgba(20,32,48,0.55)'
    g.fillRect(KEY_W - 1, RULER_H, 1, metrics.h - RULER_H)
    /* 黑键：高度与白键格**一样**（每半音一行，14px），只是沿"琴键深度"方向短一截，
     * 且贴着右边（右 = 琴键后端），左边留出白键的正面。 */
    for (let r = 0; r < metrics.rows; r++) {
      const midi = metrics.top - r
      if (midi < MIDI_LOW) break
      if (!BLACK.has(((midi % 12) + 12) % 12)) continue
      const y = RULER_H + r * ROW_H
      g.fillStyle = '#12161d'
      g.beginPath()
      g.roundRect(KEY_W * 0.36, y + 0.5, KEY_W * 0.62, ROW_H - 1, 2)
      g.fill()
      g.strokeStyle = 'rgba(255,255,255,0.18)'
      g.lineWidth = 1
      g.stroke()
    }

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
    heat,
    spectrum,
    metrics,
    notes,
    props.bpm,
    props.beatsPerBar,
    props.firstBeatMs,
    props.loop,
    props.selectedId,
    props.tonic,
    props.pitchMode,
    view,
    durationMs,
    playMs,
    hoverMidi,
    label,
    rowTop,
    xAt,
  ])

  /* ── 滚轮：普通=换音区，shift=平移，ctrl=缩放 ── */
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const rect = cv.getBoundingClientRect()
        const anchorMs = msAt(e.clientX - rect.left)
        const factor = e.deltaY > 0 ? 0.8 : 1.25
        const zoom = Math.max(1, Math.min(64, view.zoom * factor))
        const span = durationMs / Math.max(1, zoom)
        const frac = (anchorMs - view.panMs) / spanMs(view, durationMs)
        props.onView({ zoom, panMs: Math.max(0, anchorMs - frac * span) })
        return
      }
      if (e.shiftKey) {
        const span = spanMs(view, durationMs)
        props.onView({ zoom: view.zoom, panMs: view.panMs + (e.deltaY > 0 ? span : -span) * 0.12 })
        return
      }
      setCenter((c) => Math.max(MIDI_LOW, Math.min(MIDI_HIGH, c - Math.sign(e.deltaY) * 2)))
    }
    cv.addEventListener('wheel', onWheel, { passive: false })
    return () => cv.removeEventListener('wheel', onWheel)
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

      if (y < RULER_H) {
        const ms = snapMs(msAt(x), { bpm: props.bpm, beatsPerBar: props.beatsPerBar, firstBeatMs: props.firstBeatMs }, e.shiftKey ? 'beat' : 'off')
        if (e.shiftKey) {
          drag.current = { kind: 'loop', anchorMs: ms }
          props.onLoop({ startMs: ms, endMs: ms + 1 })
        } else {
          drag.current = { kind: 'scrub' }
          props.onSeek(ms)
        }
        return
      }

      if (x < KEY_W) {
        const midi = midiAt(y)
        if (midi >= MIDI_LOW && midi <= MIDI_HIGH) props.onAudition(midi)
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
      if (lh === 'body' && !hit) {
        const r = props.loop
        if (r) drag.current = { kind: 'loopMove', grabMs: rawMs, startMs: r.startMs, endMs: r.endMs }
        return
      }
      if (hit) {
        props.onSelect(hit.id)
        props.onAudition(hit.midi)
        props.onSeek(hit.startMs)
        if (mode !== 'draw') return
        if (x >= xAt(hit.endMs) - EDGE_PX) {
          drag.current = { kind: 'resize', id: hit.id, startMs: hit.startMs }
        } else {
          drag.current = {
            kind: 'move',
            id: hit.id,
            grabMs: rawMs,
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
      if (mode !== 'draw') return
      const opt = { bpm: props.bpm, beatsPerBar: props.beatsPerBar, firstBeatMs: props.firstBeatMs }
      const startMs = snapMs(rawMs, opt, props.snap)
      const id = props.onAdd({
        midi: midiAt(y),
        startMs,
        endMs: startMs + beatMs(props.bpm),
      })
      drag.current = { kind: 'create', id, startMs, moved: false }
    },
    [msAt, midiAt, mode, noteAt, props, xAt],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      setHoverMidi(y >= RULER_H ? midiAt(y) : null)

      const d = drag.current
      if (!d) {
        /* 没在拖的时候，鼠标落在握柄上就换成左右箭头，告诉用户这里能拖 */
        const lh = loopHit(x)
        e.currentTarget.style.cursor =
          lh === 'l' || lh === 'r' ? 'ew-resize' : lh === 'body' ? 'grab' : mode === 'draw' ? 'crosshair' : 'pointer'
        return
      }
      const opt = { bpm: props.bpm, beatsPerBar: props.beatsPerBar, firstBeatMs: props.firstBeatMs }
      if (d.kind === 'scrub') {
        props.onSeek(snapMs(msAt(x), opt, props.snap))
        return
      }
      if (d.kind === 'loop') {
        const ms = snapMs(msAt(x), opt, 'beat')
        props.onLoop({ startMs: Math.min(d.anchorMs, ms), endMs: Math.max(d.anchorMs, ms) })
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
        if (!d.moved && Math.abs(delta) < beatMs(props.bpm) / 8) return
        d.moved = true
        const start = snapMs(d.startMs + delta, opt, props.snap)
        props.onPatch(d.id, { startMs: start, endMs: start + (d.endMs - d.startMs) })
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
    const d = drag.current
    drag.current = null
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
      <span className="pane-label">
        音符表（{hint}）
      </span>
      <canvas
        ref={canvasRef}
        style={{
          width: metrics.w,
          height: metrics.h,
          cursor: mode === 'draw' ? 'crosshair' : 'pointer',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverMidi(null)}
        onContextMenu={onContext}
      />
      {hoverMidi !== null && (
        <div className="row-badge">
          {midiToName(hoverMidi)} · {midiToNumber(hoverMidi, props.tonic).text}
          <span className="dim">（点一下试听）</span>
        </div>
      )}
      {notes.length === 0 && (
        <div className="pane-empty">还没有音符：先打开一段音频，或直接在格子里画</div>
      )}
    </div>
  )
}
