/**
 * ui/timeAxis.ts — 时间轴 ↔ 像素（音符表和流线谱共用一套换算）
 *
 * 为什么单独抽出来：表格和下面的流线谱必须**同一套映射**，否则"改一个音、下面预览没对齐"。
 * zoom=1 时整曲铺满；放大后 panMs 是视野左边缘的时间。
 */
import type { View } from '../model/store'

/** 一屏显示多少毫秒 */
export function spanMs(view: View, durationMs: number): number {
  const d = Math.max(400, durationMs)
  return d / Math.max(1, view.zoom)
}

/** 时间 → 像素（left 是绘图区左边界，width 是绘图区宽度） */
export function msToX(ms: number, view: View, durationMs: number, left: number, width: number): number {
  const span = spanMs(view, durationMs)
  return left + ((ms - view.panMs) / span) * width
}

/** 像素 → 时间 */
export function xToMs(x: number, view: View, durationMs: number, left: number, width: number): number {
  const span = spanMs(view, durationMs)
  const ms = view.panMs + ((x - left) / Math.max(1, width)) * span
  return Math.max(0, Math.min(durationMs, ms))
}

/** 视野夹紧：不让 pan 跑到曲子外面去 */
export function clampView(view: View, durationMs: number): View {
  const span = spanMs(view, durationMs)
  const maxPan = Math.max(0, Math.max(0, durationMs) - span)
  return { zoom: view.zoom, panMs: Math.max(0, Math.min(maxPan, view.panMs)) }
}

/** 刻度候选（秒）：间距至少 64px 就用这个 */
const TICK_SECONDS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]

export function pickTickSeconds(view: View, durationMs: number, width: number): number {
  const span = spanMs(view, durationMs)
  const perPx = span / Math.max(1, width)
  for (const s of TICK_SECONDS) {
    if (s * 1000 / perPx >= 64) return s
  }
  return TICK_SECONDS[TICK_SECONDS.length - 1]
}
