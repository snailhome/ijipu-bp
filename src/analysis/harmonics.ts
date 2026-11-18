/**
 * analysis/harmonics.ts — 去谐波（把"泛音"从谱里减掉，只留基频）
 *
 * 为什么要它：单声部扒谱最怕"泛音抢位"——一个 C4 的谱上，G4（3 倍频）、C5（2 倍频）
 * 也有一片能量，Viterbi 就可能把这些当成音。noteDigger 用 NNLS 解谐波模板；
 * 我们这版用更便宜的**谐波相减**（纯算术、O(88×5/帧)，Node 里能直接验）：
 *
 *   predicted[b] = Σ_h w_h · amp[b - off_h]        （off = 12/19/24/28/31 半音 = 2..6 倍频）
 *   out[b]       = max(0, amp[b] - strength · predicted[b])
 *
 * 用**原始** amp 算预测（不用已经减过的值），避免一路连锁减到没有；
 * strength 由界面上的滑条给（0 = 不动，1 = 全减）。
 */
import type { Spectrum } from '../model/types'

/** 谐波半音偏移：2、3、4、5、6 倍频 */
const OFFS: number[] = [12, 19, 24, 28, 31]
/** 各次谐波的相对强度（越高越弱，也越容易被别的音盖住） */
const WEIGHTS: number[] = [1, 0.62, 0.4, 0.26, 0.16]

export function binsOfSpectrum(spec: Spectrum): number {
  return Math.round(spec.data.length / Math.max(1, spec.frames))
}

/**
 * 谐波相减。`strength` 0..1；返回新的 Spectrum（不动传进来的那份）。
 */
export function suppressHarmonics(spec: Spectrum, strength: number): Spectrum {
  const k = Math.max(0, Math.min(1, strength))
  if (k <= 0) return spec
  const bins = binsOfSpectrum(spec)
  const frames = spec.frames
  const src = spec.data
  const out = new Float32Array(src.length)

  for (let f = 0; f < frames; f++) {
    const row = f * bins
    for (let b = 0; b < bins; b++) {
      const amp = src[row + b]
      let pred = 0
      for (let h = 0; h < OFFS.length; h++) {
        const lo = b - OFFS[h]
        if (lo < 0) break
        pred += WEIGHTS[h] * src[row + lo]
      }
      const v = amp - k * pred
      out[row + b] = v > 0 ? v : 0
    }
  }

  return { ...spec, data: out }
}
