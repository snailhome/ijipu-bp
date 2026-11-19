/**
 * jps/bars.ts — 小节边界（含弱起）
 *
 * 为什么单独一层：拍轴从"首拍"起算，正常每小节 `beatsPerBar` 拍；
 * 弱起（`pickupBeats > 0`）时**第 1 小节只有 pickupBeats 拍**，从第 2 小节起才是整小节。
 * 生成 jps、音符表的小节线/小节号、流线谱、按小节跳转与吸附都从这里取边界，
 * 避免四处各写一遍 `floor(tick / barTicks)` 而口径不一致（AGENTS「数值口径必须同源」）。
 *
 * 单位统一用 tick（1 tick = 1/4 拍）；pickupBeats = 0 时所有函数退化成旧的等宽小节。
 */
import { TICKS_PER_BEAT } from './ticks'
import type { GridOptions } from '../model/types'

type BarOpt = Pick<GridOptions, 'beatsPerBar' | 'pickupBeats'>

/** 某小节有几拍（只有第 1 小节可能少，弱起 ≥ beatsPerBar 时按整小节算） */
export function barBeats(bar: number, opt: BarOpt): number {
  const per = Math.max(1, Math.round(opt.beatsPerBar))
  if (bar !== 0) return per
  const pickup = Math.round(opt.pickupBeats ?? 0)
  return pickup > 0 && pickup < per ? pickup : per
}

/** 某小节有几 tick */
export function barTicksAt(bar: number, opt: BarOpt): number {
  return barBeats(bar, opt) * TICKS_PER_BEAT
}

/** 某小节第一拍的 tick（第 1 小节永远是 0） */
export function barStartTick(bar: number, opt: BarOpt): number {
  const b = Math.max(0, Math.round(bar))
  if (b === 0) return 0
  const per = Math.max(1, Math.round(opt.beatsPerBar))
  return (barBeats(0, opt) + (b - 1) * per) * TICKS_PER_BEAT
}

/** tick 落在第几小节（0 起） */
export function barIndexOf(tick: number, opt: BarOpt): number {
  const t = Math.max(0, tick)
  const first = barTicksAt(0, opt)
  if (t < first) return 0
  const per = Math.max(1, Math.round(opt.beatsPerBar)) * TICKS_PER_BEAT
  return 1 + Math.floor((t - first) / per)
}

/**
 * 总小节数：`maxTick` 是最后一个音的结束 tick。
 * 正好落在小节线上算前一小节（不凭空多一个空小节）。
 */
export function barCountOf(maxTick: number, opt: BarOpt): number {
  const t = Math.max(0, maxTick)
  const first = barTicksAt(0, opt)
  if (t <= first) return 1
  const per = Math.max(1, Math.round(opt.beatsPerBar)) * TICKS_PER_BEAT
  return 1 + Math.ceil((t - first) / per)
}

/** 这个 tick 是不是小节的第一拍（画小节线用） */
export function isBarStartTick(tick: number, opt: BarOpt): boolean {
  const t = Math.round(tick)
  if (t < 0) return false
  return t === barStartTick(barIndexOf(t, opt), opt)
}
