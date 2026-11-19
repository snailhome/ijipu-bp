/**
 * jps/snap.ts — 画音/拖音时的吸附
 *
 * 三档（对照 noteDigger 的"吸附模式"）：
 *  · off  —— 不吸附，毫秒原样
 *  · grid —— 吸到 十六分音符（1/4 拍）（界面最小绘制格就是一个 十六分音符（1/4 拍） × 一个半音）
 *  · beat —— 吸到拍
 *  · bar  —— 吸到小节线
 *
 * 注意：吸附只影响"你按下/拖动时的落点"，最终谱面时值仍由 `quantize` 决定 ——
 * 两处都量化会互相打架，所以这里只管落点。
 */
import { barIndexOf, barStartTick } from './bars'
import { TICKS_PER_BEAT } from './ticks'
import type { GridOptions, SnapMode } from '../model/types'

/** 一拍多少毫秒 */
export function beatMs(bpm: number): number {
  return 60000 / Math.max(20, bpm)
}

/** 吸附步长（毫秒）；off 返回 0 表示不吸 */
export function snapStepMs(opt: GridOptions, mode: SnapMode): number {
  const beat = beatMs(opt.bpm)
  switch (mode) {
    case 'bar':
      return beat * Math.max(1, opt.beatsPerBar)
    case 'beat':
      return beat
    case 'grid':
      return beat / 16 /* 最小绘制格 = 1/16 拍（虚线里再四分，用户 m04517） */
    default:
      return 0
  }
}

/** 把时间吸到最近的格点（相对首拍）；结果不早于 0 */
export function snapMs(ms: number, opt: GridOptions, mode: SnapMode): number {
  /* 小节线不是等宽的（弱起时第 1 小节少几拍），得按真实边界取最近的一条 */
  if (mode === 'bar') {
    const tickMs = beatMs(opt.bpm) / TICKS_PER_BEAT
    const tick = Math.max(0, (ms - opt.firstBeatMs) / tickMs)
    const bar = barIndexOf(tick, opt)
    const before = barStartTick(bar, opt)
    const after = barStartTick(bar + 1, opt)
    const nearest = tick - before <= after - tick ? before : after
    return Math.max(0, opt.firstBeatMs + nearest * tickMs)
  }
  const step = snapStepMs(opt, mode)
  if (step <= 0) return Math.max(0, ms)
  const anchor = opt.firstBeatMs
  const k = Math.round((ms - anchor) / step)
  return Math.max(0, anchor + k * step)
}

/**
 * 向下取整到所在格（画新音时用：点在格子哪里，新音就从那格的起点开始）。
 * 小节档要落到真实小节线上，不能拿"整小节宽度"去 floor（弱起会偏）。
 */
export function snapMsFloor(ms: number, opt: GridOptions, mode: SnapMode): number {
  if (mode === 'bar') {
    const tickMs = beatMs(opt.bpm) / TICKS_PER_BEAT
    const tick = Math.max(0, (ms - opt.firstBeatMs) / tickMs)
    return Math.max(0, opt.firstBeatMs + barStartTick(barIndexOf(tick, opt), opt) * tickMs)
  }
  const step = snapStepMs(opt, mode)
  if (step <= 0) return Math.max(0, ms)
  return Math.max(0, opt.firstBeatMs + Math.floor((ms - opt.firstBeatMs) / step) * step)
}
