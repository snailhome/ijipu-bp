/**
 * analysis/analyze.ts — 一次分析的总调度（纯函数，Node 里可直接跑）
 *
 * samples → 频谱 → 单声部音符 → BPM/首拍 → 调性候选。
 * 只吃 Float32Array，不碰 DOM / AudioContext：这样 Node 冒烟能用合成信号夹起来验
 * （scripts/smoke.ts 就是干这个的）。
 */
import { analyzeRhythm, estimateTempo } from './beat'
import { suppressHarmonics } from './harmonics'
import { guessKeys } from './key'
import { trackMonophonic } from './notes'
import { computeSpectrum, type SpectrumOptions } from './spectrum'
import type { AnalyzeResult } from '../model/types'

export interface AnalyzeOptions extends SpectrumOptions {
  /** 最短音符（毫秒） */
  minNoteMs?: number
  /** 去谐波强度 0..1（0 = 不做） */
  suppress?: number
  /** 拍号（节奏分析挑重拍时要） */
  beatsPerBar?: number
  /** 要不要自动跟踪音符（默认要；界面里"自动填入音符"关掉时传 false，只出频谱/节奏/调性） */
  notes?: boolean
}

export function analyzeSamples(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): AnalyzeResult {
  const raw = computeSpectrum(samples, sampleRate, opts)
  const spectrum = opts.suppress && opts.suppress > 0 ? suppressHarmonics(raw, opts.suppress) : raw
  const notes = opts.notes === false ? [] : trackMonophonic(spectrum, { minMs: opts.minNoteMs ?? 60 })
  const tempo = estimateTempo(spectrum)
  const rhythm = analyzeRhythm(spectrum, opts.beatsPerBar ?? 4)
  const keyCandidates = guessKeys(spectrum)
  const analyzedEnd = (spectrum.frames + 1) * spectrum.hopMs
  return {
    durationMs: Math.max(analyzedEnd, (samples.length / sampleRate) * 1000),
    sampleRate,
    spectrum,
    notes,
    bpm: tempo.bpm,
    firstBeatMs: tempo.firstBeatMs,
    keyCandidates,
    rhythm: {
      bpm: rhythm.bpm,
      firstBeatMs: rhythm.firstBeatMs,
      confidence: rhythm.confidence,
      downbeat: rhythm.downbeat,
      beatCount: rhythm.beats.length,
    },
  }
}

/** 多声道混成单声道（0.5 权重防爆） */
export function mixdown(channels: Float32Array[], length?: number): Float32Array {
  const n = length ?? Math.min(...channels.map((c) => c.length))
  const out = new Float32Array(n)
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] += ch[i]
  }
  const k = 1 / Math.max(1, channels.length)
  for (let i = 0; i < n; i++) out[i] *= k
  return out
}
