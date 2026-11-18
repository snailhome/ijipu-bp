/**
 * ui/NoteRoll.tsx — 钢琴卷帘（"表格"）
 *
 * 每个音高一行、时间横向。方块上直接写音名或简谱数字（跟着调号变），
 * 所以"换调号 → 数字重算"这件事不用另做一张表：卷帘本身就是那张表。
 * 底层还画拍线/小节线，用户能一眼看出音符有没有压在拍上。
 */
import { useEffect, useRef } from 'react'
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
  onSeek: (ms: number) => void
  playMs: number
}

export function NoteRoll(props: Props) {
  const { notes, grid, bpm, beatsPerBar, firstBeatMs, durationMs, pitchMode, tonic, onSeek, playMs } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const draw = () => {
      const w = Math.max(1, wrap.clientWidth)
      const h = Math.max(1, wrap.clientHeight)
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#0b0f14'
      ctx.fillRect(0, 0, w, h)

      if (notes.length === 0) {
        ctx.fillStyle = '#9aa7bb'
        ctx.font = '13px "Segoe UI", sans-serif'
        ctx.fillText('没检测到音符', 12, 26)
        return
      }

      let lo = 127
      let hi = 0
      for (const n of notes) {
        lo = Math.min(lo, n.midi)
        hi = Math.max(hi, n.midi)
      }
      lo = Math.max(0, lo - 2)
      hi = Math.min(127, hi + 2)
      const rows = hi - lo + 1
      const rowH = h / rows
      const x = (ms: number) => (ms / Math.max(1, durationMs)) * w

      // 拍线 / 小节线
      const beatMs = 60000 / Math.max(1, bpm)
      if (bpm > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)'
        let beat = 0
        for (let t = firstBeatMs; t <= durationMs; t += beatMs, beat++) {
          const bx = x(t)
          ctx.strokeStyle = beat % beatsPerBar === 0 ? 'rgba(79,209,197,0.35)' : 'rgba(255,255,255,0.06)'
          ctx.beginPath()
          ctx.moveTo(bx, 0)
          ctx.lineTo(bx, h)
          ctx.stroke()
        }
      }

      // 音高行参考线（C 行）
      for (let m = lo; m <= hi; m++) {
        if (m % 12 !== 0) continue
        const y = h - ((m - lo + 0.5) / rows) * h
        ctx.strokeStyle = 'rgba(255,255,255,0.06)'
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }

      // 音符块：用 grid（量化后）画，才看得见"谱上的样子"
      const byMidi = new Map<number, GridNote[]>()
      for (const g of grid) {
        const arr = byMidi.get(g.midi) ?? []
        arr.push(g)
        byMidi.set(g.midi, arr)
      }
      const beatTicks = 1 / 4 // 1 tick = 1/4 拍
      for (const [midi, items] of byMidi) {
        if (midi < lo || midi > hi) continue
        const y = h - ((midi - lo + 0.5) / rows) * h
        for (const g of items) {
          const startMs = firstBeatMs + g.startTick * beatTicks * beatMs
          const durMs = g.ticks * beatTicks * beatMs
          const bx = x(startMs)
          const bw = Math.max(2, x(startMs + durMs) - bx)
          const bh = Math.max(4, rowH - 2)
          ctx.fillStyle = `rgba(79,209,197,${0.35 + 0.55 * g.velocity})`
          ctx.fillRect(bx, y - bh / 2, bw, bh)
          if (bw > 26 && rowH >= 11) {
            const label = pitchMode === 'number' ? midiToNumber(midi, tonic).text : midiToName(midi)
            ctx.fillStyle = '#04211f'
            ctx.font = `${Math.min(12, Math.max(9, rowH - 3))}px "Segoe UI", sans-serif`
            ctx.textBaseline = 'middle'
            ctx.fillText(label, bx + 3, y)
            ctx.textBaseline = 'alphabetic'
          }
        }
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [notes, grid, bpm, beatsPerBar, firstBeatMs, durationMs, pitchMode, tonic])

  return (
    <div
      className="pane"
      ref={wrapRef}
      style={{ flex: '1 1 34%' }}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const ratio = (e.clientX - rect.left) / Math.max(1, rect.width)
        onSeek(Math.max(0, Math.min(durationMs, ratio * durationMs)))
      }}
      title="点一下定位播放头"
    >
      <canvas ref={canvasRef} />
      {durationMs > 0 && (
        <div
          className="playhead"
          style={{ left: `${Math.min(100, Math.max(0, (playMs / durationMs) * 100))}%` }}
        />
      )}
      <span className="pane-label">音符（已按拍量化）</span>
    </div>
  )
}
