/**
 * ui/NoteRoll.tsx — 钢琴卷帘（扒谱用的"表格"）
 *
 * 形状照着 noteDigger：**左边一条钢琴键盘，右边是"音高 × 时间"的格子**，
 * 水平是时间轴、垂直是音名，一个音就是某一行里的一格。
 * 为什么不做"带状波形"：扒谱是**反复核对**的过程 —— 听原音频 → 判断这个音是哪个音高、
 * 多长 → 听合成音确认 → 改。带状图形看不出"这一行对应哪个音"，也没法一格一格点着试听。
 *
 * 交互（一个 canvas 全包，省掉两套坐标同步）：
 *  · 点空格子 → 播放头挪到这儿 + 响这个音高（试听）
 *  · 在空格子上按住拖 → 直接画一个音（时值 = 拖多长）
 *  · 拖音符中间 → 改音高/位置；拖音符右边缘 → 改时值
 *  · Delete / 右键 → 删掉选中的音
 *  · 滚轮 → 上下换音区
 */
import { useEffect, useRef, useState } from 'react'
import { midiToName, midiToNumber } from '../analysis/pitchNames'
import type { PitchMode } from '../model/store'
import type { GridNote, RawNote } from '../model/types'

interface Props {
  notes: RawNote[]
  grid: GridNote[]
  bpm: number
  beatsPerBar: number
  firstBeatMs: number
  durationMs: number
  pitchMode: PitchMode
  tonic: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  onSeek: (ms: number) => void
  onAudition: (midi: number) => void
  onAdd: (n: { midi: number; startMs: number; endMs: number }) => void
  onPatch: (id: string, patch: Partial<Pick<RawNote, 'midi' | 'startMs' | 'endMs'>>) => void
  onRemove: (id: string) => void
  playMs: number
}

/** 键盘列宽、顶部时间尺高度、默认行高（像素）、"拖右边缘改时值"的判定宽度 */
const KEY_W = 56
const RULER_H = 20
const ROW_H = 13
const EDGE_PX = 6
/** 黑键的音级（相对 C） */
const BLACK = new Set([1, 3, 6, 8, 10])

function isBlack(midi: number): boolean {
  return BLACK.has(((midi % 12) + 12) % 12)
}

type Drag =
  | { kind: 'create'; midi: number; anchorMs: number; ms: number }
  | { kind: 'move'; id: string; grabMs: number; origStart: number; origEnd: number; origMidi: number; midi: number }
  | { kind: 'resize'; id: string; origStart: number; end: number }

export function NoteRoll(props: Props) {
  const {
    notes,
    grid,
    bpm,
    beatsPerBar,
    firstBeatMs,
    durationMs,
    pitchMode,
    tonic,
    selectedId,
    onSelect,
    onSeek,
    onAudition,
    onAdd,
    onPatch,
    onRemove,
    playMs,
  } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [center, setCenter] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag
  const movedRef = useRef(false)

  // 首次有音符时，把视野对到"这批音的中位音高"
  useEffect(() => {
    if (notes.length === 0 || center !== null) return
    const sorted = notes.map((n) => n.midi).sort((a, b) => a - b)
    setCenter(sorted[Math.floor(sorted.length / 2)])
  }, [notes, center])

  /** 画布几何：把 (ms, midi) 换算成像素 */
  const geom = () => {
    const wrap = wrapRef.current
    const w = Math.max(1, wrap?.clientWidth ?? 1)
    const h = Math.max(1, wrap?.clientHeight ?? 1)
    const gridH = Math.max(10, h - RULER_H)
    const rows = Math.max(8, Math.floor(gridH / ROW_H))
    const rowH = gridH / rows
    const mid = center ?? (notes.length > 0 ? notes[Math.floor(notes.length / 2)].midi : 60)
    let top = Math.round(mid + rows / 2 - 1)
    top = Math.min(108, Math.max(rows + 20, top))
    const bottom = top - rows + 1
    return {
      w,
      h,
      rows,
      rowH,
      top,
      bottom,
      gridW: Math.max(10, w - KEY_W),
      yOf: (m: number) => RULER_H + (top - m) * rowH,
      xOf: (ms: number) => KEY_W + (ms / Math.max(1, durationMs)) * Math.max(10, w - KEY_W),
      msOf: (px: number) => ((px - KEY_W) / Math.max(10, w - KEY_W)) * Math.max(1, durationMs),
      midiOf: (py: number) => top - Math.max(0, Math.min(rows - 1, Math.floor((py - RULER_H) / rowH))),
    }
  }

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const g0 = geom()
      const { w, h, rowH, top, bottom, gridW, yOf, xOf } = g0
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#0b0f14'
      ctx.fillRect(0, 0, w, h)

      if (notes.length === 0 && !drag) {
        ctx.fillStyle = '#5d6b80'
        ctx.font = '13px "Segoe UI", sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('还没有音符：先打开一段音频', w / 2, h / 2)
        ctx.textAlign = 'left'
      }

      // ── 行底色：黑键行深一点；鼠标所在行高亮 ──
      for (let m = bottom; m <= top; m++) {
        const y = yOf(m)
        if (isBlack(m)) {
          ctx.fillStyle = 'rgba(255,255,255,0.022)'
          ctx.fillRect(KEY_W, y, gridW, rowH)
        }
        if (m === hover) {
          ctx.fillStyle = 'rgba(79,209,197,0.09)'
          ctx.fillRect(KEY_W, y, gridW, rowH)
        }
        ctx.strokeStyle = m % 12 === 0 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.035)'
        ctx.beginPath()
        ctx.moveTo(KEY_W, Math.round(y) + 0.5)
        ctx.lineTo(w, Math.round(y) + 0.5)
        ctx.stroke()
      }

      // ── 拍线 / 小节线 ──
      const beatMs = 60000 / Math.max(1, bpm)
      if (bpm > 0 && durationMs > 0) {
        let beat = 0
        for (let t = firstBeatMs; t <= durationMs; t += beatMs, beat++) {
          const x = xOf(t)
          const isBar = beat % beatsPerBar === 0
          ctx.strokeStyle = isBar ? 'rgba(79,209,197,0.30)' : 'rgba(255,255,255,0.055)'
          ctx.beginPath()
          ctx.moveTo(Math.round(x) + 0.5, RULER_H)
          ctx.lineTo(Math.round(x) + 0.5, h)
          ctx.stroke()
        }
      }

      /** 一条音符（raw 时值），selected 时描边 */
      const drawNote = (midi: number, startMs: number, endMs: number, velocity: number, sel: boolean) => {
        if (midi > top || midi < bottom) return
        const x = xOf(startMs)
        const bw = Math.max(3, xOf(endMs) - x)
        const y = yOf(midi)
        const bh = Math.max(3, rowH - 2)
        ctx.fillStyle = sel ? '#ffd166' : `rgba(79,209,197,${0.5 + 0.45 * velocity})`
        ctx.fillRect(x, y + 1, bw, bh)
        if (sel) {
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1
          ctx.strokeRect(x + 0.5, y + 1.5, bw - 1, bh - 1)
          ctx.lineWidth = 1
        }
        if (bw > 22 && rowH >= 11) {
          const label = pitchMode === 'number' ? midiToNumber(midi, tonic).text : midiToName(midi)
          ctx.fillStyle = sel ? '#3a2a00' : '#04211f'
          ctx.font = `${Math.min(11, Math.max(8, rowH - 3))}px "Segoe UI", sans-serif`
          ctx.textBaseline = 'middle'
          ctx.fillText(label, x + 3, y + rowH / 2)
          ctx.textBaseline = 'alphabetic'
        }
      }

      // 量化后的拍轴：在音符底下画一根细线，让人看见"会落在哪"
      if (bpm > 0) {
        const tickMs = beatMs / 4
        ctx.fillStyle = 'rgba(255,255,255,0.16)'
        for (const gn of grid) {
          if (gn.midi > top || gn.midi < bottom) continue
          const s = firstBeatMs + gn.startTick * tickMs
          const e = s + gn.ticks * tickMs
          const y = yOf(gn.midi) + rowH - 2
          ctx.fillRect(xOf(s), y, Math.max(2, xOf(e) - xOf(s)), 1)
        }
      }

      // 音符：编辑的是 raw（秒轴），量化只是它下面那条线
      for (const n of notes) {
        drawNote(n.midi, n.startMs, n.endMs, n.velocity, n.id === selectedId)
      }
      // 正在拖出来的新音
      if (drag?.kind === 'create') {
        const s = Math.min(drag.anchorMs, drag.ms)
        const e = Math.max(drag.anchorMs, drag.ms)
        drawNote(drag.midi, s, Math.max(s + 40, e), 0.8, true)
      }

      // ── 播放头 ──
      if (durationMs > 0) {
        const px = xOf(playMs)
        ctx.strokeStyle = 'rgba(255,120,120,0.85)'
        ctx.beginPath()
        ctx.moveTo(Math.round(px) + 0.5, RULER_H)
        ctx.lineTo(Math.round(px) + 0.5, h)
        ctx.stroke()
      }

      // ── 顶部时间尺：秒刻度 + 小节号 ──
      ctx.fillStyle = '#0d1219'
      ctx.fillRect(0, 0, w, RULER_H)
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.beginPath()
      ctx.moveTo(0, RULER_H - 0.5)
      ctx.lineTo(w, RULER_H - 0.5)
      ctx.stroke()
      if (durationMs > 0) {
        // 选一个让刻度不挤的间隔（0.5/1/2/5/10/30/60 秒）
        const target = durationMs / 8
        const steps = [500, 1000, 2000, 5000, 10000, 30000, 60000]
        const stepMs = steps.find((s) => s >= target) ?? 60000
        ctx.font = '10px "Segoe UI", sans-serif'
        for (let t = 0; t <= durationMs; t += stepMs) {
          const x = xOf(t)
          if (x < KEY_W) continue
          ctx.strokeStyle = 'rgba(255,255,255,0.16)'
          ctx.beginPath()
          ctx.moveTo(Math.round(x) + 0.5, RULER_H - 5)
          ctx.lineTo(Math.round(x) + 0.5, RULER_H - 1)
          ctx.stroke()
          ctx.fillStyle = '#7d8b9e'
          const label = stepMs >= 1000 ? `${(t / 1000).toFixed(stepMs >= 10000 ? 0 : 1)}s` : `${t}ms`
          ctx.fillText(label, x + 2, 10)
        }
        if (bpm > 0) {
          const barMs = beatMs * beatsPerBar
          ctx.font = '9px "Segoe UI", sans-serif'
          for (let t = firstBeatMs, bar = 1; t <= durationMs; t += barMs, bar++) {
            const x = xOf(t)
            if (x < KEY_W) continue
            ctx.fillStyle = '#8ea2ba'
            ctx.fillText(`${bar}`, x + 2, 19)
          }
        }
      }

      // ── 左边钢琴键盘 ──
      ctx.fillStyle = '#141a22'
      ctx.fillRect(0, RULER_H, KEY_W, h - RULER_H)
      for (let m = bottom; m <= top; m++) {
        const y = yOf(m)
        const black = isBlack(m)
        if (black) {
          ctx.fillStyle = '#1b232d'
          ctx.fillRect(6, y + 1, KEY_W - 12, rowH - 2)
        } else {
          ctx.fillStyle = m === hover ? '#e8f2ff' : '#c8d2df'
          ctx.fillRect(0, y + 1, KEY_W - 6, rowH - 2)
        }
        if (rowH >= 10) {
          ctx.textBaseline = 'middle'
          if (m % 12 === 0) {
            ctx.font = 'bold 9px "Segoe UI", sans-serif'
            ctx.fillStyle = '#20262e'
            ctx.fillText(`C${Math.floor(m / 12) - 1}`, KEY_W - 32, y + rowH / 2)
          } else if (!black && pitchMode === 'number') {
            ctx.font = '9px "Segoe UI", sans-serif'
            ctx.fillStyle = '#4a5666'
            ctx.fillText(midiToNumber(m, tonic).text, KEY_W - 20, y + rowH / 2)
          }
          ctx.textBaseline = 'alphabetic'
        }
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.beginPath()
      ctx.moveTo(KEY_W - 0.5, RULER_H)
      ctx.lineTo(KEY_W - 0.5, h)
      ctx.stroke()
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [notes, grid, bpm, beatsPerBar, firstBeatMs, durationMs, pitchMode, tonic, playMs, center, hover, selectedId, drag])

  /** 鼠标位置 → 坐标 + 命中的音符 */
  const probe = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const lx = e.clientX - rect.left
    const ly = e.clientY - rect.top
    const g = geom()
    const ms = g.msOf(lx)
    const midi = g.midiOf(ly)
    // 命中音符：同一行、且 x 落在块内
    const hit = [...notes]
      .reverse()
      .find((n) => n.midi === midi && ms >= n.startMs - 4 && ms <= n.endMs + 4) ?? null
    const nearEdge = hit ? g.xOf(hit.endMs) - lx <= EDGE_PX : false
    return { lx, ly, ms, midi, hit, nearEdge, inKeys: lx < KEY_W, inRuler: ly < RULER_H, g }
  }

  return (
    <div
      className="pane roll"
      ref={wrapRef}
      tabIndex={0}
      onMouseMove={(e) => {
        const { midi, inRuler } = probe(e)
        setHover(inRuler ? null : midi)
      }}
      onMouseLeave={() => setHover(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const { midi, ms, hit, nearEdge, inKeys, inRuler } = probe(e)
        if (inRuler || durationMs <= 0) return
        movedRef.current = false
        if (inKeys) {
          onAudition(midi)
          return
        }
        if (hit) {
          onSelect(hit.id)
          if (nearEdge) {
            setDrag({ kind: 'resize', id: hit.id, origStart: hit.startMs, end: hit.endMs })
          } else {
            setDrag({
              kind: 'move',
              id: hit.id,
              grabMs: ms,
              origStart: hit.startMs,
              origEnd: hit.endMs,
              origMidi: hit.midi,
              midi: hit.midi,
            })
          }
          e.currentTarget.setPointerCapture(e.pointerId)
          return
        }
        onSelect(null)
        setDrag({ kind: 'create', midi, anchorMs: ms, ms })
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = dragRef.current
        if (!d) return
        const { midi, ms } = probe(e)
        movedRef.current = true
        if (d.kind === 'create') setDrag({ ...d, ms })
        else if (d.kind === 'resize') setDrag({ ...d, end: Math.max(d.origStart + 40, ms) })
        else setDrag({ ...d, midi })
      }}
      onPointerUp={(e) => {
        const d = dragRef.current
        setDrag(null)
        if (!d) return
        const { ms } = probe(e)
        const moved = movedRef.current
        if (d.kind === 'create') {
          const s = Math.min(d.anchorMs, ms)
          const e2 = Math.max(d.anchorMs, ms)
          if (e2 - s >= 60) onAdd({ midi: d.midi, startMs: s, endMs: e2 })
          else {
            // 没拖动 = 点一下：挪播放头 + 试听这个音高
            onSeek(d.anchorMs)
            onAudition(d.midi)
          }
          return
        }
        if (d.kind === 'resize') {
          if (moved) onPatch(d.id, { endMs: Math.max(d.origStart + 40, ms) })
          return
        }
        if (moved) {
          const delta = ms - d.grabMs
          onPatch(d.id, {
            midi: d.midi,
            startMs: Math.max(0, d.origStart + delta),
            endMs: Math.max(40, d.origEnd + delta),
          })
        }
      }}
      onClick={(e) => {
        const { ms, inRuler } = probe(e)
        if (inRuler || durationMs <= 0) return
        if (movedRef.current) {
          movedRef.current = false
          return
        }
        // 点空白处的"定位"已由 pointerUp 处理；这里只处理键盘区之外的单击定位
        if (e.detail === 1 && !dragRef.current) {
          const { hit } = probe(e)
          if (!hit) onSeek(ms)
        }
      }}
      onContextMenu={(e) => {
        const { hit } = probe(e)
        if (hit) {
          e.preventDefault()
          onRemove(hit.id)
        }
      }}
      onKeyDown={(e) => {
        if (!selectedId) return
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          onRemove(selectedId)
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const n = notes.find((x) => x.id === selectedId)
          if (!n) return
          onPatch(selectedId, { midi: n.midi + (e.key === 'ArrowUp' ? 1 : -1) })
        }
      }}
      onWheel={(e) => {
        if (notes.length === 0) return
        e.preventDefault()
        const step = Math.sign(e.deltaY) * 3
        if (step === 0) return
        setCenter((c) => {
          const base = c ?? notes[Math.floor(notes.length / 2)].midi
          return Math.max(30, Math.min(96, base - step))
        })
      }}
      title="点格子试听音高；空白处拖动可画音；拖音符改音高/位置，拖右边缘改时值；Delete 删除"
    >
      <canvas ref={canvasRef} />
      <span className="pane-label">音符表（点格子试听 · 空白拖动画音 · Delete 删除）</span>
    </div>
  )
}
