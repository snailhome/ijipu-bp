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

/** 节奏分析结果：BPM、拍点、重拍位置、可信度 */
export interface RhythmResult {
  bpm: number
  firstBeatMs: number
  /** 每个拍点的毫秒时刻 */
  beats: number[]
  /** 0..1，越大说明谱上的起声越贴着拍点（低于 0.25 基本是没节奏或检测失败） */
  confidence: number
  /** 拍点里哪一个是小节第一拍（相对 beats 的下标） */
  downbeat: number
}

/** 在 onset 包络上取某个（可能带小数的）帧位置的线性插值 */
function envAt(env: Float32Array, pos: number): number {
  const i = Math.floor(pos)
  if (i < 0 || i >= env.length) return 0
  const t = pos - i
  const a = env[i]
  const b = i + 1 < env.length ? env[i + 1] : a
  return a * (1 - t) + b * t
}

/**
 * 给一个周期找最佳相位：把拍点铺在 0, p, 2p, … 上，左右各 ±0.25 拍微调，
 * 让这些位置上的起声强度之和最大。
 */
function bestPhase(env: Float32Array, period: number): { phase: number; score: number } {
  let best = { phase: 0, score: -1 }
  const steps = Math.max(8, Math.round(period * 4))
  for (let s = 0; s < steps; s++) {
    const base = (s / steps) * period
    let score = 0
    let n = 0
    for (let t = base; t < env.length; t += period) {
      let local = 0
      for (let d = -0.25; d <= 0.2501; d += 0.25) local = Math.max(local, envAt(env, t + d * period))
      score += local
      n++
    }
    if (n > 0) score /= n
    if (score > best.score) best = { phase: base, score }
  }
  return best
}

/**
 * 节奏分析：先估 BPM，再在 onset 包络上找拍点相位，最后按拍号挑重拍。
 *
 * 和 noteDigger 的 `beatTrackDp`（动态规划跟拍）比起来这是"定速 + 找相位"的简化版：
 * 对节奏稳的曲子够用，变速曲子会飘——漂移这件事留给后面的 P2。
 */
export function analyzeRhythm(spec: Spectrum, beatsPerBar = 4): RhythmResult {
  const env = onsetEnvelope(spec)
  const hopMs = spec.hopMs
  const frames = env.length
  const guess = estimateTempo(spec)
  if (frames < 8) {
    return { bpm: guess.bpm, firstBeatMs: 0, beats: [], confidence: 0, downbeat: 0 }
  }

  /* 候选速度：估出来的、以及它的倍/半（自相关常在倍频处也出峰） */
  const candidates = [guess.bpm, guess.bpm * 2, guess.bpm / 2].filter((b) => b >= 40 && b <= 220)
  let best = { bpm: guess.bpm, phase: 0, score: -1, period: 0 }
  for (const bpm of candidates) {
    const period = 60000 / bpm / hopMs
    if (period < 2 || period > frames) continue
    const { phase, score } = bestPhase(env, period)
    /* 轻微偏好中速（55–160 之间不加罚），避免全都跑到 2 倍速上 */
    const prior = Math.exp(-Math.pow(Math.log2(bpm / 105), 2) / 0.8)
    const total = score * prior
    if (total > best.score) best = { bpm, phase, score: total, period }
  }

  /* 相位只对到"四分之一拍以内"，这里再把整条拍线一起挪到最近的起声峰上 */
  const grid: number[] = []
  for (let t = best.phase; t < frames; t += best.period) grid.push(t)
  const halfWin = Math.max(1, Math.round(best.period * 0.2))
  const offsets: number[] = []
  for (const t of grid) {
    const center = Math.round(t)
    let bestF = center
    let bestV = -1
    for (let d = -halfWin; d <= halfWin; d++) {
      const i = center + d
      if (i < 0 || i >= frames) continue
      if (env[i] > bestV) {
        bestV = env[i]
        bestF = i
      }
    }
    offsets.push(bestF - center)
  }
  const shift = offsets.length > 0 ? offsets.slice().sort((a, b) => a - b)[Math.floor(offsets.length / 2)] : 0
  const beats: number[] = []
  for (const t of grid) {
    const ms = Math.round((t + shift) * hopMs)
    if (ms >= 0 && ms <= (frames - 1) * hopMs) beats.push(ms)
  }
  if (beats.length === 0) {
    return { bpm: guess.bpm, firstBeatMs: 0, beats: [], confidence: 0, downbeat: 0 }
  }

  /* 可信度：拍点附近的平均起声 ÷ 全曲平均起声（再压到 0..1）。
   * 取 ±1 帧的局部最大，避免拍点正好落在两帧之间时判成 0。 */
  const localMax = (f: number): number => {
    let m = 0
    for (let d = -1; d <= 1; d++) {
      const i = f + d
      if (i >= 0 && i < frames) m = Math.max(m, env[i])
    }
    return m
  }
  let sum = 0
  let n = 0
  for (const ms of beats) {
    const f = Math.round(ms / hopMs)
    if (f >= 0 && f < frames) {
      sum += localMax(f)
      n++
    }
  }
  let mean = 0
  for (let f = 0; f < frames; f++) mean += env[f]
  mean /= Math.max(1, frames)
  const hit = n > 0 ? sum / n : 0
  const confidence = mean > 1e-6 ? Math.max(0, Math.min(1, hit / mean / 3)) : 0

  /* 重拍：在拍号周期里挨个试，挑"这一拍的起声之和"最大的位置 */
  const per = Math.max(1, beatsPerBar)
  let downbeat = 0
  let bestDown = -1
  for (let i0 = 0; i0 < Math.min(per, beats.length); i0++) {
    let s = 0
    for (let i = i0; i < beats.length; i += per) {
      const f = Math.round(beats[i] / hopMs)
      if (f >= 0 && f < frames) s += localMax(f)
    }
    /* 第一拍是小节线的先验：稍微给点加分，避免和小节线错开 */
    if (i0 === 0) s *= 1.08
    if (s > bestDown) {
      bestDown = s
      downbeat = i0
    }
  }

  return {
    bpm: Math.round(best.bpm * 10) / 10,
    firstBeatMs: beats[downbeat] ?? 0,
    beats,
    confidence: Math.round(confidence * 100) / 100,
    downbeat,
  }
}
