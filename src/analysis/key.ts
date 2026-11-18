/**
 * analysis/key.ts — 调性分析（哪些调最可能）
 *
 * 用 Krumhansl–Kessler 的大调音级轮廓跟 12 维色度向量做相关：
 *  · 色度 = 每个音级在整个频谱上的能量和（跨八度）
 *  · 每个主音把轮廓转一下算相关，相关值再归成"可能性比率"
 * 这正是 noteDigger「调性分析」面板给的那组比率；区别是我们**不写死**，
 * 界面里可以手动改调号（改完数字音符立刻重算）。
 */
import { BIN_COUNT, MIDI_LOW } from './pitchNames'
import type { KeyCandidate, Spectrum } from '../model/types'

/** Krumhansl 大调轮廓（C 大调，按音级 0..11） */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]

export function chromaVector(spec: Spectrum): Float64Array {
  const v = new Float64Array(12)
  const { frames, data } = spec
  for (let f = 0; f < frames; f++) {
    const row = f * BIN_COUNT
    for (let b = 0; b < BIN_COUNT; b++) {
      const pc = (((MIDI_LOW + b) % 12) + 12) % 12
      v[pc] += data[row + b]
    }
  }
  let max = 0
  for (let i = 0; i < 12; i++) if (v[i] > max) max = v[i]
  if (max > 0) for (let i = 0; i < 12; i++) v[i] /= max
  return v
}

function corr(a: Float64Array | number[], b: number[]): number {
  const n = 12
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  if (da <= 0 || db <= 0) return 0
  return num / Math.sqrt(da * db)
}

/** 返回按可能性降序的 12 个候选大调 */
export function guessKeys(spec: Spectrum): KeyCandidate[] {
  const chroma = chromaVector(spec)
  const raw: { tonic: number; r: number }[] = []
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = new Array<number>(12)
    for (let i = 0; i < 12; i++) rotated[i] = MAJOR_PROFILE[(i - tonic + 12) % 12]
    raw.push({ tonic, r: corr(chroma, rotated) })
  }
  const min = Math.min(...raw.map((x) => x.r))
  const weights = raw.map((x) => Math.max(0, x.r - min + 0.02))
  const sum = weights.reduce((a, b) => a + b, 0)
  return raw
    .map((x, i) => ({ tonic: x.tonic, share: sum > 0 ? weights[i] / sum : 1 / 12 }))
    .sort((a, b) => b.share - a.share)
}
