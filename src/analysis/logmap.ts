/**
 * analysis/logmap.ts — 线性频谱 → 对数（半音）频谱
 *
 * 做法照 noteDigger 的思路，但参数简化：
 *  · 目标 88 个 bin（A0=21 … C8=108），每 bin 一个中心频率；
 *  · 每个 FFT bin 的频率按 |半音距离| 用余弦核加权，距离 ≥ semiR（0.667 半音）权重 0；
 *  · 权重和∝中心频率（高频窗更宽）——这跟它在对数坐标下用等宽窗是一回事。
 *
 * 为什么不直接用"每个半音一个 CQT 滤波器"：CQT 慢一个数量级，而 8192 点 FFT
 * 在 44.1kHz 下的频率间隔约 5.4Hz（F#2 以上够用），先跑通 STFT 这条线。
 */
import { hannWindow } from './fft'
import { BIN_COUNT, MIDI_LOW, midiToFreq } from './pitchNames'

export interface LogMapBin {
  /** 起始 FFT bin（含） */
  start: number
  /** 对应权重（长度与 start 起的一段相同） */
  weights: Float64Array
}

export interface LogMap {
  bins: number
  map: LogMapBin[]
}

/** 半音核的半宽（单位：半音）；0.667 ≈ 2/3，noteDigger 的原值 */
const SEMI_R = 0.667

export function buildLogMap(sampleRate: number, fftSize: number): LogMap {
  const half = fftSize / 2
  const binHz = sampleRate / fftSize
  const map: LogMapBin[] = []
  for (let i = 0; i < BIN_COUNT; i++) {
    const center = midiToFreq(MIDI_LOW + i)
    // 覆盖 [-SEMI_R, +SEMI_R] 半音的频率范围，换算成 FFT bin
    const lo = Math.max(1, Math.floor((center * Math.pow(2, -SEMI_R / 12)) / binHz))
    const hi = Math.min(half, Math.ceil((center * Math.pow(2, SEMI_R / 12)) / binHz))
    const weights = new Float64Array(Math.max(1, hi - lo + 1))
    let sum = 0
    for (let k = lo; k <= hi; k++) {
      const semis = 12 * Math.log2((k * binHz) / center)
      const w = Math.max(0, Math.cos((semis * Math.PI) / SEMI_R) + 1)
      weights[k - lo] = w
      sum += w
    }
    // 归一：bin 内的加权平均，避免"窗越宽能量越大"
    if (sum > 0) for (let j = 0; j < weights.length; j++) weights[j] /= sum
    map.push({ start: lo, weights })
  }
  return { bins: BIN_COUNT, map }
}

/** 汉宁窗缓存（FFT 长度相同就复用） */
const windowCache = new Map<number, Float64Array>()
export function windowOf(size: number): Float64Array {
  let w = windowCache.get(size)
  if (!w) {
    w = hannWindow(size)
    windowCache.set(size, w)
  }
  return w
}
