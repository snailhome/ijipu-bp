/**
 * ui/Spectrogram.tsx — 对数频谱（背景画布）
 *
 * 画法照 noteDigger 的三层思路，但我们只做两层：频谱一张、交互层一张（音符 + 播放头）。
 * 频谱只在「分析结果变了 / 尺寸变了」时重画，播放头是 DOM 元素 —— 60fps 时不碰画布。
 */
import { useEffect, useRef } from 'react'
import { midiToName } from '../analysis/pitchNames'
import { BIN_COUNT, MIDI_LOW, displayValue } from '../analysis/spectrum'
import type { Spectrum } from '../model/types'

interface Props {
  spectrum: Spectrum | null
  durationMs: number
  onSeek: (ms: number) => void
  playMs: number
}

export function Spectrogram({ spectrum, durationMs, onSeek, playMs }: Props) {
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
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = '#0b0f14'
      ctx.fillRect(0, 0, w, h)

      if (spectrum) {
        const img = ctx.createImageData(w, h)
        const { frames, data } = spectrum
        for (let x = 0; x < w; x++) {
          const f = Math.min(frames - 1, Math.floor((x / w) * frames))
          const row = f * BIN_COUNT
          for (let y = 0; y < h; y++) {
            const b = BIN_COUNT - 1 - Math.floor((y / h) * BIN_COUNT)
            const v = displayValue(data[row + b])
            const a = Math.pow(v, 0.62)
            const i = (y * w + x) * 4
            img.data[i] = 10 + a * 245
            img.data[i + 1] = 16 + a * 196 * (0.35 + 0.65 * a)
            img.data[i + 2] = 26 + a * 150
            img.data[i + 3] = 255
          }
        }
        ctx.putImageData(img, 0, 0)

        // 八度参考线（每个 C）
        ctx.font = '10px "Segoe UI", sans-serif'
        for (let b = 0; b < BIN_COUNT; b++) {
          if ((MIDI_LOW + b) % 12 !== 0) continue
          const y = h - ((b + 0.5) / BIN_COUNT) * h
          ctx.strokeStyle = 'rgba(255,255,255,0.08)'
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(w, y)
          ctx.stroke()
          ctx.fillStyle = 'rgba(230,237,247,0.35)'
          ctx.fillText(midiToName(MIDI_LOW + b), 3, y - 2)
        }
      } else {
        ctx.fillStyle = '#5d6b80'
        ctx.font = '13px "Segoe UI", sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('打开音频后这里显示频谱', w / 2, h / 2)
        ctx.textAlign = 'left'
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [spectrum])

  return (
    <div
      className="pane"
      ref={wrapRef}
      style={{ flex: '1 1 42%' }}
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
      <span className="pane-label">频谱（对数／半音）</span>
    </div>
  )
}
