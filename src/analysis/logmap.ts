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

/** 半音核的半宽（单位：半音）；0.667 ≈ 2/3，noteDigger 的原值。冒烟里按它验"没有越界权重" */
export const SEMI_R = 0.667

export function buildLogMap(sampleRate: number, fftSize: number): LogMap {
  const half = fftSize / 2
  const binHz = sampleRate / fftSize
  const map: LogMapBin[] = []
  for (let i = 0; i < BIN_COUNT; i++) {
    const center = midiToFreq(MIDI_LOW + i)
    // 覆盖 [-SEMI_R, +SEMI_R] 半音的频率范围，换算成 FFT bin
    // 最底下几个半音（A0 一带）的半音间距比 FFT 分辨率还窄，可能一个 bin 中心都落进窗里；
    // 把"最近的 FFT bin"也纳进来兜底，免得整格是空的（那几格本来就听不出音高）。
    const near = Math.max(1, Math.min(half, Math.round(center / binHz)))
    const lo = Math.min(near, Math.max(1, Math.floor((center * Math.pow(2, -SEMI_R / 12)) / binHz)))
    const hi = Math.max(near, Math.min(half, Math.ceil((center * Math.pow(2, SEMI_R / 12)) / binHz)))
    const weights = new Float64Array(Math.max(1, hi - lo + 1))
    let sum = 0
    for (let k = lo; k <= hi; k++) {
      const semis = 12 * Math.log2((k * binHz) / center)
      /* 核的支撑只有 ±SEMI_R：边界外必须是 0。
       * 以前漏了这条判断，余弦过了 π 又绕回正值，于是低频相邻半音的格子互相"吃"对方
       * 的能量（F2 有近一半落进 F#2），和弦识别会把 F 大三判成 Faug（用户 m02483 实测）。 */
      if (Math.abs(semis) > SEMI_R) continue
      const w = Math.max(0, Math.cos((semis * Math.PI) / SEMI_R) + 1)
      weights[k - lo] = w
      sum += w
    }
    // 低频兜底：没有 bin 落在窗里就退化成"最近的 FFT bin 单独作代表"
    if (sum <= 0) {
      weights[near - lo] = 1
      sum = 1
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
