/**
 * analysis/beat.ts — BPM 与首拍（拍点）
 *
 * 思路（比 noteDigger 的 bpmEst.js 简单得多，够 P0 用）：
 *  · 谱通量：每帧各行"比上一帧涨了多少"，加总 = 起声强度包络
 *  · 对包络做自相关，取 55–190 BPM 区间里最强的周期，再用先验往 100 BPM 收
 *  · 首拍 = 第一个明显超过均值的起声帧（用户还能在界面里改）
 * 真正的动态规划拍点跟踪（noteDigger 的 beatTrackDp）留给 P2。
 */
import type { Spectrum } from '../model/types'

export interface TempoGuess {
  bpm: number
  firstBeatMs: number
}

function binsOf(spec: Spectrum): number {
  return Math.round(spec.data.length / Math.max(1, spec.frames))
}

export function onsetEnvelope(spec: Spectrum): Float32Array {
  const { frames, data } = spec
  const bins = binsOf(spec)
  const env = new Float32Array(frames)
  let prev = new Float32Array(bins)
  let cur = new Float32Array(bins)
  for (let f = 0; f < frames; f++) {
    const row = f * bins
    let sum = 0
    for (let b = 0; b < bins; b++) {
      const v = data[row + b]
      if (v > prev[b]) sum += v - prev[b]
      cur[b] = v
    }
    env[f] = sum
    const t = prev
    prev = cur
    cur = t
  }

  let mean = 0
  for (let f = 0; f < frames; f++) mean += env[f]
  mean /= Math.max(1, frames)
  let max = 0
  for (let f = 0; f < frames; f++) {
    env[f] = Math.max(0, env[f] - mean)
    if (env[f] > max) max = env[f]
  }
  if (max > 0) for (let f = 0; f < frames; f++) env[f] /= max
  return env
}

export function estimateTempo(spec: Spectrum): TempoGuess {
  const env = onsetEnvelope(spec)
  const frames = env.length
  const hopMs = spec.hopMs
  if (frames < 8) return { bpm: 100, firstBeatMs: 0 }

  let bestLag = 0
  let bestScore = -Infinity
  for (let lag = 2; lag <= Math.min(60, Math.floor(frames / 2)); lag++) {
    let score = 0
    for (let f = lag; f < frames; f++) score += env[f] * env[f - lag]
    score /= frames - lag
    const bpm = 60000 / (lag * hopMs)
    if (bpm < 55 || bpm > 190) continue
    // 向 100 BPM 收一点：人耳偏好中速，且自相关在倍频处也会有峰
    score *= Math.exp(-Math.pow(Math.log2(bpm / 100), 2) / 0.5)
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }

  let bpm = bestLag > 0 ? 60000 / (bestLag * hopMs) : 100
  while (bpm < 60) bpm *= 2
  while (bpm > 180) bpm /= 2

  let mean = 0
  for (let f = 0; f < frames; f++) mean += env[f]
  mean /= frames
  let firstBeat = 0
  for (let f = 0; f < frames; f++) {
    if (env[f] > mean * 1.6) {
      firstBeat = f
      break
    }
  }

  return { bpm: Math.round(bpm * 10) / 10, firstBeatMs: firstBeat * hopMs }
}
