/**
 * ui/StripPreview.tsx — 简谱"流线谱"预览条
 *
 * 曲谱**字形全部交给引擎画**（`preview/stripSvg.ts`：jps → parse → layout →
 * `buildLinearStrip` → `renderScoreToSvg`），这里只做两件事：
 *   1. 按时间轴把这条谱摆到对应位置（横轴 = 时间，和上面的音符表同一套映射）；
 *   2. 画小节号、播放头、空谱提示，接点击 seek。
 *
 * 为什么不再手画：以前这里自己写数字/减时线/八度点/附点/连音弧，
 * 等于把引擎的谱面规范又抄一遍，跟真正交出去的 jps 容易对不上（用户 m02192）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { barCountOf, barStartTick } from '../jps/bars'
import { beatMs } from '../jps/snap'
import { buildStripImage, type StripImage } from '../preview/stripSvg'
import { msToX, spanMs, xToMs } from './timeAxis'
import type { View } from '../model/store'
import type { GridNote } from '../model/types'

interface Props {
  grid: GridNote[]
  bpm: number
  beatsPerBar: number
  /** 弱起拍数：第 1 小节的小节线/小节号要少画几拍（0 = 整小节） */
  pickupBeats: number
  firstBeatMs: number
  durationMs: number
  view: View
  playMs: number
  tonic: number
  title: string
  onSeek: (ms: number) => void
}

const PAD_TOP = 26
/** 左边留出与音符表键盘列等宽的空白，两个画布的时间刻度才对得上 */
const LEFT = 66
const RIGHT_PAD = 10

export function StripPreview(props: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [image, setImage] = useState<StripImage | null>(null)

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

  /* 出图：视窗附近几小节交给引擎排（改音/缩放/平移都要重排，稍作防抖避免拖动时连打） */
  useEffect(() => {
    if (size.w <= 0 || props.grid.length === 0) {
      setImage(null)
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      const contentW = Math.max(1, size.w - LEFT - RIGHT_PAD)
      const visibleMs = spanMs(props.view, props.durationMs)
      const pxPerBeat = beatMs(props.bpm) * (contentW / visibleMs)
      const img = buildStripImage({
        grid: props.grid,
        jps: {
          bpm: props.bpm,
          beatsPerBar: props.beatsPerBar,
          pickupBeats: props.pickupBeats,
          firstBeatMs: props.firstBeatMs,
          title: props.title,
          tonic: props.tonic,
        },
        fromMs: props.view.panMs,
        toMs: props.view.panMs + visibleMs,
        pxPerBeat,
        marginBars: 1,
      })
      if (alive) setImage(img)
    }, 40)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [
    props.grid,
    props.bpm,
    props.beatsPerBar,
    props.pickupBeats,
    props.firstBeatMs,
    props.title,
    props.tonic,
    props.view,
    props.durationMs,
    size.w,
  ])

  /* 覆盖层：小节号、播放头、空谱提示（谱面本身是下面的 SVG） */
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || size.w <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(size.w * dpr)
    cv.height = Math.round(size.h * dpr)
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, size.w, size.h)

    /* 左侧留白（与音符表键盘列同宽），画成稍深一点，看起来是同一个坐标系 */
    g.fillStyle = '#ece5d3'
    g.fillRect(0, 0, LEFT, size.h)

    const beat = beatMs(props.bpm)
    const barOpt = { beatsPerBar: props.beatsPerBar, pickupBeats: props.pickupBeats }
    const tickMs = beat / 4
    const lastTick = Math.max(1, ...props.grid.map((n) => n.startTick + n.ticks))
    const bars = barCountOf(lastTick, barOpt)

    /* 小节号（谱面里的小节线由引擎画，这里只补号） */
    g.font = '10px ui-monospace, Consolas, monospace'
    g.textBaseline = 'middle'
    g.fillStyle = 'rgba(60,60,60,0.55)'
    for (let b = 0; b <= bars; b++) {
      const ms = props.firstBeatMs + barStartTick(b, barOpt) * tickMs
      const x = xAt(ms)
      if (x < LEFT - 1 || x > size.w + 1) continue
      g.fillText(String(b + 1), x + 3, PAD_TOP - 12)
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
      <div className="strip-stage">
        {image && (
          <div
            className="strip-svg"
            style={{
              left: xAt(image.startMs),
              top: PAD_TOP,
              width: image.width * image.scale,
              height: image.height * image.scale,
            }}
            dangerouslySetInnerHTML={{ __html: image.svg }}
          />
        )}
        <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} onClick={onClick} />
      </div>
    </div>
  )
}
