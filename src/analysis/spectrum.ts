/**
 * analysis/spectrum.ts — STFT → 对数（半音）频谱
 *
 * 参数：8192 点 FFT、汉宁窗、20 帧/秒（hop = sr/20）。
 * 为什么是 8192：44.1kHz 下频率间隔约 5.4Hz，F#2 以上够用；再大只是更慢，
 * 而扒旋律根本用不到 C1 那一带（这也是 noteDigger 的原话）。
 *
 * 归一化：**每帧能量方差为 1**（noteDigger 学的 timbreAMT）。好处是画面动态范围好看、
 * 阈值判据不随录音音量漂移；代价是"静音帧也被拉成 1"，所以另存每帧时域 RMS 做静音判定。
 */
import { BIN_COUNT, MIDI_LOW, MIDI_HIGH } from './pitchNames'
import { FFT } from './fft'
import { buildLogMap, windowOf } from './logmap'
import type { Spectrum } from '../model/types'

export { BIN_COUNT, MIDI_LOW, MIDI_HIGH }

export interface SpectrumOptions {
  /** FFT 点数（2 的幂），默认 8192 */
  fftSize?: number
  /** 每秒分析多少帧，默认 20 */
  fps?: number
}

export function computeSpectrum(
  samples: Float32Array,
  sampleRate: number,
  opts: SpectrumOptions = {},
): Spectrum {
  const fftSize = opts.fftSize ?? 8192
  const fps = opts.fps ?? 20
  const hop = Math.max(1, Math.round(sampleRate / fps))
  const frames = Math.max(1, Math.floor((samples.length - fftSize) / hop) + 1)
  const fft = new FFT(fftSize)
  const win = windowOf(fftSize)
  const logMap = buildLogMap(sampleRate, fftSize)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  const mag = new Float64Array(fftSize / 2 + 1)
  const data = new Float32Array(frames * BIN_COUNT)
  const frameRms = new Float32Array(frames)

  for (let f = 0; f < frames; f++) {
    const offset = f * hop
    let sumSq = 0
    for (let i = 0; i < fftSize; i++) {
      const s = offset + i < samples.length ? samples[offset + i] : 0
      sumSq += s * s
      re[i] = s * win[i]
      im[i] = 0
    }
    frameRms[f] = Math.sqrt(sumSq / fftSize)
    fft.transform(re, im)
    for (let k = 0; k <= fftSize / 2; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
    }
    const row = f * BIN_COUNT
    let sq = 0
    for (let b = 0; b < BIN_COUNT; b++) {
      const bin = logMap.map[b]
      let v = 0
      for (let j = 0; j < bin.weights.length; j++) v += mag[bin.start + j] * bin.weights[j]
      data[row + b] = v
      sq += v * v
    }
    // 每帧方差归一（sqrt(v²·invSigma) = v·sqrt(invSigma)）
    const mean = sq / BIN_COUNT
    if (mean > 1e-12) {
      const scale = Math.sqrt(1 / Math.sqrt(mean))
      for (let b = 0; b < BIN_COUNT; b++) data[row + b] *= scale
    }
  }

  return {
    frames,
    hopMs: (hop / sampleRate) * 1000,
    sampleRate,
    data,
    frameRms,
  }
}

/** 显示用：归一化幅度 → 0..1（对数压缩，弱音也看得见） */
export function displayValue(v: number): number {
  return Math.min(1, Math.max(0, Math.log1p(v) / Math.log1p(3.2)))
}

/** 第 f 帧、第 b 个 bin 的值 */
export function valueAt(spec: Spectrum, f: number, b: number): number {
  return spec.data[f * BIN_COUNT + b]
}
