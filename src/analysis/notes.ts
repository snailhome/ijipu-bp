/**
 * analysis/notes.ts — 单声部音高跟踪（频谱 → 秒轴音符）
 *
 * 判据是"动态规划找一条最省力的音高轨迹"，不是"每帧挑最强"：
 *  1. 每帧对每个半音 bin 算**谐波求和**分（基频弱、泛音强的真实乐器也能认对基频）
 *  2. 对每段连续有声帧跑 Viterbi：落在强 bin 上得高分，跳得远扣分
 *     （同音 0、差 1 个半音 0.55、差 2 个 1.3、八度 2.0……见 JUMP_COST）
 *  3. 路径不变的一段 = 一个音；太短的段丢掉，同音相邻段合并
 *  4. 掐掉两头"看不出来"的一截（音尾衰减会被窗拖住）
 *  5. 八度纠偏：用原始频谱在"当前 / ±12 半音"里再核对一次，
 *     压基频+二次、抬三/五次谐波，修"弱基频被判高八度 / 次谐波被判低八度"（用户 2026-11-22）
 *
 * 为什么不用"每帧 argmax + 中值滤波"（P0 第一版）：
 * 真曲子实测（独奏陶笛 287 秒）出了 710 个音，谱面上全是 `#1 #2` 这种相邻半音抖动 ——
 * 最强 bin 会在基频/泛音之间来回跳，中值滤波只压得住 1 帧的孤立跳变，压不住成片的。
 * Viterbi 看的是"整条路径"，同样的抖动会被跳变代价吃掉。
 * 为什么还不做 HMM+DTW（noteDigger aboutANA 那套）：那套要"已知音高序列"再做对齐，
 * 而我们这里音高是未知的，得先在 88 个 bin 上找轨迹 —— 也就是这里的版本。
 * 更重的模型（basic-pitch ONNX）留到 P4，理由见 docs/TRANSCRIBE-PLAN.md §六。
 */
import { BIN_COUNT, MIDI_LOW } from './pitchNames'
import type { RawNote, Spectrum } from '../model/types'

export interface TrackOptions {
  /** 最短音符（毫秒），比它短的段当噪声丢掉 */
  minMs?: number
  /** 静音阈值：相对全局最大帧 RMS 的比例 */
  silenceRatio?: number
  /** 跳变代价的整体缩放（0 = 不做平滑，退回逐帧最强）；默认 1 */
  jumpScale?: number
}

/** 谐波位置（半音数）与权重：基频、八度、八度+五度、两个八度、两个八度+大三度 */
const HARMONIC_STEPS = [0, 12, 19, 24, 28]
const HARMONIC_WEIGHTS = [1, 0.5, 0.33, 0.25, 0.2]

/**
 * 跳变代价表：JUMP_COST[d] = 跳到"高 d 个半音"要扣多少分（对数域）。
 * 形状来自"旋律多级进、少跳进"：相邻半音几乎不罚（颤音/滑音要跟得上），
 * 三全音以上罚得狠；**八度单独给个便宜的价**（换把位、翻高八度很常见）。
 */
const JUMP_COST = (() => {
  const t = new Float32Array(BIN_COUNT)
  for (let d = 0; d < BIN_COUNT; d++) {
    if (d === 0) t[d] = 0
    else if (d === 1) t[d] = 0.55
    else if (d === 2) t[d] = 1.3
    else if (d <= 4) t[d] = 2.2
    else if (d <= 6) t[d] = 3.0
    else if (d <= 9) t[d] = 3.8
    else if (d <= 11) t[d] = 4.4
    else if (d === 12) t[d] = 2.0
    else if (d <= 16) t[d] = 4.8
    else if (d === 19) t[d] = 3.4
    else if (d === 24) t[d] = 3.2
    else t[d] = 5.5
  }
  return t
})()

/** 每帧每个 bin 的谐波求和分（越大越像"这里有基频"） */
function harmonicScores(data: Float32Array, row: number, out: Float32Array): number {
  let max = 0
  for (let b = 0; b < BIN_COUNT; b++) {
    let s = data[row + b]
    for (let h = 1; h < HARMONIC_STEPS.length; h++) {
      const hi = b + HARMONIC_STEPS[h]
      if (hi >= BIN_COUNT) break
      s += data[row + hi] * HARMONIC_WEIGHTS[h]
    }
    out[b] = s
    if (s > max) max = s
  }
  return max
}

/**
 * 八度纠偏（用户 2026-11-22："分析成谱的音比频谱显示低了八度"）。
 *
 * Viterbi 只看"谐波求和分"，遇到**基频弱、二次谐波强**的人声/乐器时，
 * 容易把二次谐波当成基频（高八度）；遇到**低八度泛音/周期加倍**时又会往下掉。
 * 这里在一条音段定下来后，用**原始频谱**再比一次"当前音 / 低八度 / 高八度"：
 *
 *  - 权重故意压**基频**和**二次谐波**，抬**三次、五次谐波**——
 *    真正的基频会有 3f/5f，而"把二次谐波当基频"的候选，它的 3f/5f 在更高的地方、通常很弱；
 *  - 只比当前 ±12 半音，不再往下找两个八度（否则弱基频的 A4 会被拉到 A3）；
 *  - 分数接近时保留原判，避免把本来对的音翻掉。
 */
const OCTAVE_WEIGHTS = [0.6, 0.15, 1, 0.2, 0.8, 0.15]
/** 1、2、3、4、5、6 次谐波相对基频的半音数（3rd=+19、5th=+28，不是八度！） */
const OCTAVE_STEPS = [0, 12, 19, 24, 28, 31]

function octaveScore(mean: Float32Array, bin: number): number {
  let s = 0
  for (let h = 0; h < OCTAVE_WEIGHTS.length; h++) {
    const idx = bin + OCTAVE_STEPS[h]
    if (idx >= BIN_COUNT) break
    s += OCTAVE_WEIGHTS[h] * Math.log1p(mean[idx] * 20)
  }
  return s
}

/** 候选基频有没有"三次/五次谐波"支撑：纯次谐波/低频噪声只有 1、2 次，不能靠它降八度 */
function hasHarmonicSupport(mean: Float32Array, bin: number): boolean {
  const e3 = bin + 19 < BIN_COUNT ? mean[bin + 19] : 0
  const e5 = bin + 28 < BIN_COUNT ? mean[bin + 28] : 0
  const base = mean[bin] + (bin + 12 < BIN_COUNT ? mean[bin + 12] : 0)
  return e3 + e5 > Math.max(0.02, base * 0.12)
}

/** 用音段 [from,to] 的平均频谱，在当前 bin / ±12 里挑一个更可信的基频 */
function correctedBin(spec: Spectrum, from: number, to: number, bin: number): number {
  const mean = new Float32Array(BIN_COUNT)
  const n = Math.max(1, to - from + 1)
  for (let f = from; f <= to; f++) {
    const row = f * BIN_COUNT
    for (let b = 0; b < BIN_COUNT; b++) mean[b] += spec.data[row + b]
  }
  for (let b = 0; b < BIN_COUNT; b++) mean[b] /= n
  const cur = octaveScore(mean, bin)
  let bestBin = bin
  let bestScore = cur
  for (const d of [-12, 12]) {
    const b = bin + d
    if (b < 0 || b >= BIN_COUNT) continue
    /* 只有 1、2 次谐波、没有 3/5 次的"低八度"多半是次谐波/噪声，不能把音拉下去 */
    if (!hasHarmonicSupport(mean, b)) continue
    const s = octaveScore(mean, b)
    if (s > bestScore) {
      bestScore = s
      bestBin = b
    }
  }
  /* 证据不够强就不动：0.2 大约相当于"三次谐波明显更合理"这一档 */
  return bestScore > cur + 0.2 ? bestBin : bin
}

/**
 * 在一段连续有声帧 [from, to] 上跑 Viterbi，把结果写进 path。
 * 每帧发射分 = log(谐波分 / 本帧最大)，跳变代价见 JUMP_COST。
 */
function viterbiRun(
  spec: Spectrum,
  from: number,
  to: number,
  jumpScale: number,
  path: Int16Array,
): void {
  const { data } = spec
  const n = to - from + 1
  if (n <= 0) return
  const emit = new Float32Array(BIN_COUNT)
  const back = new Int16Array(n * BIN_COUNT)
  let prev = new Float32Array(BIN_COUNT)
  let next = new Float32Array(BIN_COUNT)

  // 起点帧：发射分就是总分
  harmonicScores(data, from * BIN_COUNT, emit)
  let max = 0
  for (let b = 0; b < BIN_COUNT; b++) if (emit[b] > max) max = emit[b]
  const inv0 = max > 0 ? 1 / max : 0
  for (let b = 0; b < BIN_COUNT; b++) {
    prev[b] = Math.log(1e-3 + emit[b] * inv0)
    back[b] = b
  }

  for (let f = from + 1; f <= to; f++) {
    const row = (f - from) * BIN_COUNT
    harmonicScores(data, f * BIN_COUNT, emit)
    let m = 0
    for (let b = 0; b < BIN_COUNT; b++) if (emit[b] > m) m = emit[b]
    const inv = m > 0 ? 1 / m : 0
    for (let b = 0; b < BIN_COUNT; b++) {
      const e = Math.log(1e-3 + emit[b] * inv)
      let bestScore = -Infinity
      let bestFrom = b
      for (let p = 0; p < BIN_COUNT; p++) {
        const c = prev[p] - JUMP_COST[Math.abs(b - p)] * jumpScale
        if (c > bestScore) {
          bestScore = c
          bestFrom = p
        }
      }
      next[b] = bestScore + e
      back[row + b] = bestFrom
    }
    const swap = prev
    prev = next
    next = swap
  }

  // 回溯
  let b = 0
  let best = -Infinity
  for (let i = 0; i < BIN_COUNT; i++) {
    if (prev[i] > best) {
      best = prev[i]
      b = i
    }
  }
  for (let f = to; f >= from; f--) {
    path[f] = b
    b = back[(f - from) * BIN_COUNT + b]
  }
}

export function trackMonophonic(spec: Spectrum, opts: TrackOptions = {}): RawNote[] {
  const minMs = opts.minMs ?? 80
  const silenceRatio = opts.silenceRatio ?? 0.02
  const jumpScale = opts.jumpScale ?? 1
  const { frames, hopMs, frameRms } = spec
  if (frames === 0) return []

  let maxRms = 0
  for (let f = 0; f < frames; f++) maxRms = Math.max(maxRms, frameRms[f])
  if (maxRms < 1e-5) return []
  const silence = Math.max(1e-4, maxRms * silenceRatio)

  // 1+2) 谐波求和 + Viterbi（按"连续有声段"分别跑，静音处自然断开）
  const path = new Int16Array(frames).fill(-1)
  let f = 0
  while (f < frames) {
    if (frameRms[f] < silence) {
      f++
      continue
    }
    const start = f
    while (f < frames && frameRms[f] >= silence) f++
    viterbiRun(spec, start, f - 1, jumpScale, path)
  }

  // 3) 连段
  const segments: { bin: number; from: number; to: number }[] = []
  let curBin = -1
  let curFrom = 0
  for (let i = 0; i <= frames; i++) {
    const b = i < frames ? path[i] : -1
    if (b !== curBin) {
      if (curBin >= 0) segments.push({ bin: curBin, from: curFrom, to: i - 1 })
      curBin = b
      curFrom = i
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

  // 4.5) 掐掉两头看不出来的一截
  //      为什么需要：帧窗长 186ms，音尾的衰减会被"还包含它"的那几帧拖住，
  //      末音因此长约 100ms → 量化成 1.25 拍、还要和后面那个音做连音线。
  //      判据用"该段自身的中位数音量"而不是全局阈值：每段自己的响度不同。
  //      尾部比头部更狠（0.55 vs 0.35）：起音快、收音慢，拖尾主要在后面。
  for (const seg of merged) {
    let sum = 0
    for (let i = seg.from; i <= seg.to; i++) sum += frameRms[i]
    const mid = sum / Math.max(1, seg.to - seg.from + 1)
    let a = seg.from
    let z = seg.to
    while (a < z && frameRms[a] < mid * 0.35) a++
    while (z > a && frameRms[z] < mid * 0.55) z--
    // 至少留 2 帧，否则短音符会被掐没
    if (z - a + 1 >= 2) {
      seg.from = a
      seg.to = z
    }
  }

  // 4.6) 八度纠偏：用原始频谱再核对一次，修"二次谐波强→高八度 / 低八度泛音→低八度"
  const corrected = merged.map((seg) => ({ ...seg, bin: correctedBin(spec, seg.from, seg.to, seg.bin) }))
  const finalSegs: typeof merged = []
  for (const seg of corrected) {
    const last = finalSegs[finalSegs.length - 1]
    if (last && last.bin === seg.bin && seg.from - last.to - 1 <= 2) last.to = seg.to
    else finalSegs.push({ ...seg })
  }

  // 5) 出 RawNote（力度 = 该段时域 RMS 相对于全曲最响帧，0.2..1）
  return finalSegs.map((seg, i) => {
    let rms = 0
    for (let k = seg.from; k <= seg.to; k++) rms += frameRms[k]
    rms /= Math.max(1, seg.to - seg.from + 1)
    return {
      id: `n${i + 1}`,
      midi: MIDI_LOW + seg.bin,
      startMs: seg.from * hopMs,
      endMs: (seg.to + 1) * hopMs,
      velocity: Math.min(1, Math.max(0.2, rms / maxRms)),
      confirmed: false,
    }
  })
}
