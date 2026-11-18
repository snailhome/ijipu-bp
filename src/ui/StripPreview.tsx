/**
 * ui/StripPreview.tsx — 简谱"流线谱"预览条
 *
 * 为什么不用引擎的分页排版（`layoutScore` + `renderScoreToSvg`）：
 * 它把谱排成一页一页、每小节宽度由排版决定，**跟上面的时间格对不齐**；
 * 用户要求"与时间格对应宽度对应，这样调整音符能够即时显示"（m01788 第 7 条）。
 * 所以这里按同一个时间映射直接画：横轴 = 时间，数字写在音的起点，长音用增时线拉到位。
 *
 * 口径与 `jps/toJps.ts` 保持一致（减时线/增时线/附点都照它的规则），
 * 真正交出去的仍然是 `store.jps`（那份要被引擎 `parseJps`/`layoutScore` 两道闸门验过）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { midiToNumber } from '../analysis/pitchNames'
import { marks } from '../jps/marks'
import { beatMs } from '../jps/snap'
import { msToX, xToMs } from './timeAxis'
import type { View } from '../model/store'
import type { GridNote } from '../model/types'

interface Props {
  grid: GridNote[]
  bpm: number
  beatsPerBar: number
  firstBeatMs: number
  durationMs: number
  view: View
  playMs: number
  tonic: number
  onSeek: (ms: number) => void
}

const PAD_TOP = 26
const PAD_BOTTOM = 12
const LINE_Y = 46
const FONT_SIZE = 20
/** 左边留出与音符表键盘列等宽的空白，两个画布的时间刻度才对得上 */
const LEFT = 66
const RIGHT_PAD = 10

export function StripPreview(props: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const xAt = useCallback(
    (ms: number) => msToX(ms, props.view, props.durationMs, LEFT, Math.max(1, size.w - LEFT - RIGHT_PAD)),
    [props.durationMs, props.view, size.w],
  )

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || size.w <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(size.w * dpr)
    cv.height = Math.round(size.h * dpr)
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = '#f7f3e7'
    g.fillRect(0, 0, size.w, size.h)
    /* 左侧留白（与音符表键盘列同宽），画成稍深一点，看起来是同一个坐标系 */
    g.fillStyle = '#ece5d3'
    g.fillRect(0, 0, LEFT, size.h)

    const beat = beatMs(props.bpm)
    const barTicks = Math.max(1, props.beatsPerBar) * 4
    const tickMs = beat / 4

    /* 小节线 + 小节号 */
    const lastTick = Math.max(1, ...props.grid.map((n) => n.startTick + n.ticks))
    const bars = Math.max(1, Math.ceil(lastTick / barTicks))
    g.font = '10px ui-monospace, Consolas, monospace'
    g.textBaseline = 'middle'
    for (let b = 0; b <= bars; b++) {
      const ms = props.firstBeatMs + b * barTicks * tickMs
      const x = Math.round(xAt(ms)) + 0.5
      if (x < -1 || x > size.w + 1) continue
      g.strokeStyle = b === 0 ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.28)'
      g.lineWidth = b === 0 ? 1.6 : 1
      g.beginPath()
      g.moveTo(x, PAD_TOP - 6)
      g.lineTo(x, size.h - PAD_BOTTOM + 4)
      g.stroke()
      g.fillStyle = 'rgba(60,60,60,0.55)'
      g.fillText(String(b + 1), x + 3, PAD_TOP - 12)
    }

    /* 每小节的拍线（淡） */
    for (let i = 0, t = 0; t <= lastTick; i++, t = i * 4) {
      const ms = props.firstBeatMs + t * tickMs
      const x = Math.round(xAt(ms)) + 0.5
      if (x < 0 || x > size.w) continue
      g.strokeStyle = 'rgba(0,0,0,0.07)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(x, PAD_TOP)
      g.lineTo(x, size.h - PAD_BOTTOM)
      g.stroke()
    }

    /* 音符 */
    g.textBaseline = 'alphabetic'
    for (const n of props.grid) {
      const startMs = props.firstBeatMs + n.startTick * tickMs
      const endMs = startMs + n.ticks * tickMs
      const x = xAt(startMs)
      if (x < -40 || x > size.w + 40) continue
      const num = midiToNumber(n.midi, props.tonic)
      const text = `${num.digit}${num.accidental}`
      const m = marks(n.ticks)
      const y = LINE_Y

      g.fillStyle = '#1b1b1b'
      g.font = `${FONT_SIZE}px "Noto Serif SC", "Songti SC", serif`
      g.fillText(text, x + 1, y)
      const tw = g.measureText(text).width

      /* 八度点 */
      const dotR = 1.9
      const dots = Math.abs(num.dots)
      for (let i = 0; i < Math.min(3, dots); i++) {
        g.beginPath()
        const cy = num.dots > 0 ? y - FONT_SIZE - 3 - i * 6 : y + 5 + i * 6
        g.arc(x + tw / 2, cy, dotR, 0, Math.PI * 2)
        g.fill()
      }

      /* 减时线（写在数字下面） */
      for (let i = 0; i < m.under; i++) {
        const ly = y + 4 + i * 3
        g.fillRect(x - 1, ly, Math.max(6, tw + 2), 1.4)
      }

      /* 增时线：从数字右边一直拉到这个音的时间终点 */
      if (m.dash > 0) {
        const endX = xAt(endMs)
        g.fillRect(x + tw + 3, y - 8, Math.max(4, endX - x - tw - 5), 1.6)
      }

      /* 附点 */
      for (let i = 0; i < m.dots; i++) {
        const dx = x + tw + 3 + (m.dash > 0 ? 0 : i * 6)
        const cy = m.dash > 0 ? y - 7.4 : y - 5
        g.fillRect(dx, cy, 3, 3)
      }
    }

    /* 播放头 */
    const px = xAt(props.playMs)
    if (px >= 0) {
      g.strokeStyle = '#ff4d6a'
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(px, 0)
      g.lineTo(px, size.h)
      g.stroke()
    }

    if (props.grid.length === 0) {
      g.fillStyle = 'rgba(60,60,60,0.45)'
      g.font = '12px ui-monospace, Consolas, monospace'
      g.fillText('还没有确认的音符 —— 在上面的表格里点一下就是确认', LEFT + 4, size.h / 2 + 4)
    }
  }, [props, size, xAt])

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      props.onSeek(
        xToMs(e.clientX - rect.left, props.view, props.durationMs, LEFT, Math.max(1, size.w - LEFT - RIGHT_PAD)),
      )
    },
    [props, size.w],
  )

  return (
    <div className="pane strip" ref={wrapRef}>
      <span className="pane-label">简谱预览（流线谱：横轴即时间，改音立刻反映）</span>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h }}
        onClick={onClick}
      />
    </div>
  )
}
