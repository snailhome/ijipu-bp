/**
 * jps/quantize.ts — 秒轴音符 → 拍轴音符（量化）
 *
 * 为什么量化单独一层：扒谱用**秒**最贴原曲，制谱用**拍**才写得进 jps。
 * 两层都留着，用户改 BPM / 首拍时只重算这一层，原始秒轴一个数都不动
 * （noteDigger 作者说的"跨越这个鸿沟"，见 docs/TRANSCRIBE-PLAN.md §2）。
 *
 * 量化单位固定 1/16 拍（1 tick = 1/4 拍）：简谱的时值都是 2^-n 与附点，
 * 1/16 拍已经够表达 16 分音符和附点八分；三连音写不出来，会进 warnings。
 */
import type { GridNote, GridOptions, RawNote } from '../model/types'

/** 每拍多少 tick（1 tick = 1/4 拍 = 16 分音符） */
export const TICKS_PER_BEAT = 4

export interface QuantizeResult {
  notes: GridNote[]
  /** 量化时发现的问题（给界面「注意」栏，不阻断） */
  warnings: string[]
  /** 总小节数 */
  barCount: number
}

export function quantize(notes: RawNote[], opt: GridOptions): QuantizeResult {
  const beatMs = 60000 / Math.max(1, opt.bpm)
  const warnings: string[] = []
  const raw: GridNote[] = []

  for (const n of notes) {
    const exactStart = ((n.startMs - opt.firstBeatMs) / beatMs) * TICKS_PER_BEAT
    const exactDur = ((n.endMs - n.startMs) / beatMs) * TICKS_PER_BEAT
    const startTick = Math.max(0, Math.round(exactStart))
    const ticks = Math.max(1, Math.round(exactDur))

    // 偏离超过 1/2 tick 的，记一条（告诉用户"这音可能没对上拍"）
    const startErr = Math.abs(exactStart - startTick) / TICKS_PER_BEAT
    const durErr = Math.abs(exactDur - ticks) / TICKS_PER_BEAT
    if (startErr > 0.12 || durErr > 0.12) {
      warnings.push(`第 ${raw.length + 1} 个音偏离拍点约 ${(Math.max(startErr, durErr) * 100) | 0}% 拍，已就近对齐`)
    }
    raw.push({ midi: n.midi, startTick, ticks, velocity: n.velocity })
  }

  raw.sort((a, b) => a.startTick - b.startTick || a.midi - b.midi)

  // 去重叠：前一个音伸进后一个音里就截短（单声部不应该叠）
  let overlaps = 0
  for (let i = 1; i < raw.length; i++) {
    const prev = raw[i - 1]
    const cur = raw[i]
    const prevEnd = prev.startTick + prev.ticks
    if (cur.startTick < prevEnd) {
      prev.ticks = Math.max(1, cur.startTick - prev.startTick)
      overlaps++
    }
  }
  if (overlaps > 0) warnings.push(`${overlaps} 处音符重叠，已按后一个音截短前一个`)

  const barTicks = Math.max(1, opt.beatsPerBar) * TICKS_PER_BEAT
  let maxTick = 0
  for (const n of raw) maxTick = Math.max(maxTick, n.startTick + n.ticks)
  const barCount = Math.max(1, Math.ceil(maxTick / barTicks))

  return { notes: raw, warnings, barCount }
}
