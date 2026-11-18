/**
 * jps/snap.ts — 画音/拖音时的吸附
 *
 * 三档（对照 noteDigger 的"吸附模式"）：
 *  · off  —— 不吸附，毫秒原样
 *  · grid —— 吸到 1/4 拍（十六分音符格点）
 *  · beat —— 吸到拍
 *  · bar  —— 吸到小节线
 *
 * 注意：吸附只影响"你按下/拖动时的落点"，最终谱面时值仍由 `quantize` 决定 ——
 * 两处都量化会互相打架，所以这里只管落点。
 */
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
      return beat / 4
    default:
      return 0
  }
}

/** 把时间吸到最近的格点（相对首拍）；结果不早于 0 */
export function snapMs(ms: number, opt: GridOptions, mode: SnapMode): number {
  const step = snapStepMs(opt, mode)
  if (step <= 0) return Math.max(0, ms)
  const anchor = opt.firstBeatMs
  const k = Math.round((ms - anchor) / step)
  return Math.max(0, anchor + k * step)
}
