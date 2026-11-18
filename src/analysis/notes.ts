/**
 * analysis/notes.ts — 单声部音高跟踪（频谱 → 秒轴音符）
 *
 * P0 用的是"最简可用"的一组判据，故意不装 HMM：
 *  1. 每帧取能量最大的 bin（对整个人声/单音乐器足够）
 *  2. 三帧中值滤波去跳变
 *  3. 同样的 bin 连成段；换 bin 或掉进静音就断开
 *  4. 太短的段丢掉（默认 60ms），相邻同音高的段合并
 * 计划里的 Viterbi 版本（noteDigger aboutANA 那套）放在 P2，理由写在
 * docs/TRANSCRIBE-PLAN.md §9 —— 先把"音频 → 能出声的谱"这条路打通，
 * 判据好换，管线不好换。
 */
import { BIN_COUNT, MIDI_LOW } from './pitchNames'
import type { RawNote, Spectrum } from '../model/types'

export interface TrackOptions {
  /** 最短音符（毫秒），比它短的段当噪声丢掉 */
  minMs?: number
  /** 静音阈值：相对全局最大帧 RMS 的比例 */
  silenceRatio?: number
}

export function trackMonophonic(spec: Spectrum, opts: TrackOptions = {}): RawNote[] {
  const minMs = opts.minMs ?? 60
  const silenceRatio = opts.silenceRatio ?? 0.02
  const { frames, hopMs, frameRms, data } = spec
  if (frames === 0) return []

  let maxRms = 0
  for (let f = 0; f < frames; f++) maxRms = Math.max(maxRms, frameRms[f])
  if (maxRms < 1e-5) return []
  const silence = Math.max(1e-4, maxRms * silenceRatio)

  // 1) 每帧最强 bin
  const best = new Int16Array(frames).fill(-1)
  for (let f = 0; f < frames; f++) {
    if (frameRms[f] < silence) continue
    const row = f * BIN_COUNT
    let bestBin = -1
    let bestVal = 0
    for (let b = 0; b < BIN_COUNT; b++) {
      const v = data[row + b]
      if (v > bestVal) {
        bestVal = v
        bestBin = b
      }
    }
    best[f] = bestBin
  }

  // 2) 中值滤波（窗口 3，忽略 -1）
  const filtered = new Int16Array(best)
  for (let f = 1; f < frames - 1; f++) {
    const a = best[f - 1]
    const b = best[f]
    const c = best[f + 1]
    if (a < 0 || b < 0 || c < 0) continue
    filtered[f] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
  }

  // 3) 连段
  const segments: { bin: number; from: number; to: number }[] = []
  let curBin = -1
  let curFrom = 0
  for (let f = 0; f <= frames; f++) {
    const b = f < frames ? filtered[f] : -1
    if (b !== curBin) {
      if (curBin >= 0) segments.push({ bin: curBin, from: curFrom, to: f - 1 })
      curBin = b
      curFrom = f
    }
  }

  // 4) 过滤 + 合并
  const merged: { bin: number; from: number; to: number }[] = []
  for (const seg of segments) {
    const ms = (seg.to - seg.from + 1) * hopMs
    if (ms < minMs) continue
    const last = merged[merged.length - 1]
    const gapFrames = last ? seg.from - last.to - 1 : Number.POSITIVE_INFINITY
    if (last && last.bin === seg.bin && gapFrames <= 2) {
      last.to = seg.to
    } else {
      merged.push({ ...seg })
    }
  }

  // 5) 出 RawNote（力度 = 该段中间三帧的对数谱均值，归一化到 0..1）
  return merged.map((seg, i) => {
    const mid = Math.floor((seg.from + seg.to) / 2)
    let level = 0
    for (let f = Math.max(seg.from, mid - 1); f <= Math.min(seg.to, mid + 1); f++) {
      level += data[f * BIN_COUNT + seg.bin]
    }
    level /= Math.max(1, Math.min(seg.to, mid + 1) - Math.max(seg.from, mid - 1) + 1)
    return {
      id: `n${i + 1}`,
      midi: MIDI_LOW + seg.bin,
      startMs: seg.from * hopMs,
      endMs: (seg.to + 1) * hopMs,
      velocity: Math.min(1, level / 4),
    }
  })
}
