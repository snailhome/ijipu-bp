/**
 * analysis/chords.ts — 和弦识别（从 noteDigger 的 `plugins/chordEst.js` 复刻）
 *
 * 为什么单独抽成纯函数：和弦识别的输入只有频谱，输出只有"哪一段是什么和弦"，
 * 跟画布/播放无关。这样 Node 冒烟能直接拿合成信号断言（scripts/smoke.ts 有 C 大三和弦用例），
 * 也能在 worker 里跑，不占主线程。
 *
 * 算法（与 noteDigger 同一套，未做"发明"）：
 *  1. 频谱 → chroma（12 个音级能量）：每个半音 bin 取 f²，乘一条"往低频加权"的余弦窗
 *     （低音区更可信），同音级跨八度相加。**注意 bin 0 是 A0**，所以音级要按
 *     `(bin + MIDI_LOW) % 12` 取，不能直接 `% 12`（那样整体会转 9 个半音）。
 *  2. 每帧观测量与 169 个状态（14 种和弦 × 12 个根音 + 无和弦）做余弦匹配，
 *     和弦模板本身先过一遍谐波模板（一个根音的能量会漏到它的 2/3/4… 倍频上）。
 *  3. 多帧用 HMM + Viterbi 解码：转移概率里带乐理规则（上行纯四度、下行三度、
 *     挂留解决、同根音变复杂和弦要罚分……），所以不会一帧一个和弦地乱跳。
 *
 * 输出只做"提示"用，**不写进 jps**（方案文档 §7.5 已定：jps 的 `{bz}` 是伴奏声部记谱，
 * 不是和弦标记）。界面上画在音符表底部一条带子里。
 */
import type { Spectrum } from '../model/types'
import { MIDI_LOW } from './pitchNames'

export interface ChordSegment {
  /** 起点（毫秒） */
  startMs: number
  /** 终点（毫秒） */
  endMs: number
  /** 和弦名：`C` / `Am` / `G7` / `Db` …；`N` 表示这一段判不出和弦（静音/噪声） */
  name: string
}

export interface ChordOptions {
  /** 短于这么多毫秒的段并进前一段（默认 100ms，20fps 下 = 2 帧） */
  minMs?: number
}

/* ── 和弦字典：模式（半音集合）+ 先验概率（相对"常见程度"） ── */
const PATTERNS: Array<{ suffix: string; intervals: number[]; prob: number }> = [
  { suffix: '', intervals: [0, 4, 7], prob: 1 },
  { suffix: 'm', intervals: [0, 3, 7], prob: 0.9 },
  { suffix: 'dim', intervals: [0, 3, 6], prob: 0.1 },
  { suffix: 'aug', intervals: [0, 4, 8], prob: 0.1 },
  { suffix: 'sus4', intervals: [0, 5, 7], prob: 0.04 },
  { suffix: 'sus2', intervals: [0, 2, 7], prob: 0.04 },
  { suffix: '7', intervals: [0, 4, 7, 10], prob: 0.01 },
  { suffix: 'm7', intervals: [0, 3, 7, 10], prob: 0.01 },
  { suffix: 'maj7', intervals: [0, 4, 7, 11], prob: 0.005 },
  { suffix: 'dim7', intervals: [0, 3, 6, 9], prob: 0.004 },
  { suffix: 'm7b5', intervals: [0, 3, 6, 10], prob: 0.003 },
  { suffix: 'add9', intervals: [0, 2, 4, 7], prob: 0.003 },
  { suffix: 'mM7', intervals: [0, 3, 7, 11], prob: 0.001 },
  { suffix: 'maj9', intervals: [0, 2, 4, 7, 11], prob: 0.0002 },
]

const ROOTS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

/** 无和弦状态（静音/噪声）的相对概率 */
const P_N = 0.1

/** 一秒之后"换和弦"的概率（noteDigger 用 0.82，这里按实际帧长换算） */
const P_SWITCH_PER_SEC = 0.82

/** 转移矩阵里"变复杂"的罚分：和弦音数变多算不自然的进行 */
const TENSION = new Set(['7', 'dim', 'm7b5', 'dim7', 'aug', 'mM7'])
const STABLE = new Set(['', 'm', 'm7', 'maj7', 'add9', 'maj9'])
const SUSPENSE = new Set(['sus4', 'sus2'])

interface ChordModel {
  names: string[]
  /** 169 × 12，每行一个和弦模板（已归一化） */
  templates: Float32Array
  /** 169，先验对数概率 */
  logPrior: Float32Array
  /** 169 × 169，转移对数概率 */
  logTrans: Float32Array
  /** 状态数（169） */
  n: number
  /** 有效和弦数（不含 N） */
  valid: number
}

/** 谐波模板：一个基音在它自己 12 音级上的能量分布 */
function harmonicTemplate(decay: number, harmonics: number): Float32Array {
  const a = new Float32Array(12)
  for (let h = 1, w = 1; h <= harmonics; h += 1, w *= decay) {
    const bin = Math.log2(h) * 12
    const l = Math.floor(bin)
    const r = Math.ceil(bin)
    const frac = bin - l
    a[l % 12] += w * (1 - frac)
    a[r % 12] += w * frac
  }
  return a
}

let cached: ChordModel | null = null

function getModel(): ChordModel {
  if (cached) return cached
  const tmpl = harmonicTemplate(0.6, 9)
  const valid = PATTERNS.length * 12
  const n = valid + 1
  const names: string[] = []
  const templates = new Float32Array(n * 12)
  const logPrior = new Float32Array(n)

  /* 先验：各模式按 prob 归一，再除以 12 个根音 */
  let sum = 0
  for (const p of PATTERNS) sum += p.prob
  const scale = (1 - P_N) / (sum * 12)

  const ampOf = (len: number) => (len === 4 ? 0.98 : len === 5 ? 0.95 : len === 6 ? 0.93 : 1)

  /** 把一个和弦的音级集合过谐波模板并归一，写进 templates 的第 i 行 */
  const writeChord = (i: number, root: number, intervals: number[], amp: number) => {
    const raw = new Float32Array(12)
    for (let k = 0; k < 12; k += 1) {
      let v = 0
      for (const iv of intervals) v += tmpl[(k - ((root + iv) % 12) + 12) % 12]
      raw[k] = v
    }
    let sq = 0
    for (let k = 0; k < 12; k += 1) sq += raw[k] * raw[k]
    const g = amp / Math.sqrt(Math.max(1e-9, sq))
    for (let k = 0; k < 12; k += 1) templates[i * 12 + k] = raw[k] * g
  }

  let i = 0
  for (const p of PATTERNS) {
    for (let root = 0; root < 12; root += 1) {
      names.push(`${ROOTS[root]}${p.suffix}`)
      writeChord(i, root, p.intervals, ampOf(p.intervals.length))
      logPrior[i] = Math.log(p.prob * scale)
      i += 1
    }
  }
  names.push('N')
  writeChord(i, 0, Array.from({ length: 12 }, (_, k) => k), 0.8)
  logPrior[i] = Math.log(P_N)

  /* 转移概率：同态保持 P(keep)，其余按模式概率 × 乐理规则再归一 */
  const logTrans = new Float32Array(n * n)
  for (let a = 0; a < n; a += 1) {
    if (a === valid) {
      /* 从"无和弦"回到有和弦：用先验分布 */
      for (let b = 0; b < n; b += 1) logTrans[a * n + b] = logPrior[b]
      continue
    }
    const r1 = a % 12
    const p1 = Math.floor(a / 12)
    const row = new Float32Array(n)
    let sumScore = 0
    for (let b = 0; b < n; b += 1) {
      if (a === b) continue
      let score: number
      if (b < valid) {
        const r2 = b % 12
        const p2 = Math.floor(b / 12)
        score = PATTERNS[p2].prob
        const interval = (r2 - r1 + 12) % 12
        const n1 = PATTERNS[p1].intervals.length
        const n2 = PATTERNS[p2].intervals.length
        if (interval === 5) {
          /* 上行纯四度（V→I 那类）最强 */
          score *= 5
          if (TENSION.has(PATTERNS[p1].suffix) && STABLE.has(PATTERNS[p2].suffix)) score *= 2
        } else if (interval === 8 || interval === 9) {
          score *= 3 /* 下行三度：I→vi / I→iii */
        } else if (interval === 2) {
          score *= 2.5 /* 上行二度：IV→V */
        } else if (interval === 0 && SUSPENSE.has(PATTERNS[p1].suffix) && STABLE.has(PATTERNS[p2].suffix)) {
          score *= 10 /* 挂留解决：同根音 */
        } else if (interval === 1 && PATTERNS[p1].suffix === 'dim7') {
          score *= 4 /* 减七半音上行解决 */
        } else if (interval === 0 && p1 !== p2) {
          score *= n2 < n1 ? 0.9 : 0.1 /* 同根音下变复杂 = 罚分 */
        }
      } else {
        score = P_N
      }
      row[b] = score
      sumScore += score
    }
    /* 这里的 0.98 只是占位比例：真正的"保持概率"要按帧长换算，
     * 在 decodeChords 里整体重标定（自转移 = k，其余按本行比例缩放） */
    const k = 0.98
    const scaleOther = (1 - k) / Math.max(1e-9, sumScore)
    for (let b = 0; b < n; b += 1) {
      logTrans[a * n + b] = Math.log(a === b ? k : row[b] * scaleOther)
    }
  }

  cached = { names, templates, logPrior, logTrans, n, valid }
  return cached
}

/** 观测用：频谱 → 12 个音级的 chroma（已按 L2 归一化，全 0 时返回全 0） */
export function chromaOf(spec: Spectrum, frame: number, out?: Float32Array): Float32Array {
  const bins = Math.round(spec.data.length / Math.max(1, spec.frames))
  const buf = out ?? new Float32Array(12)
  buf.fill(0)
  const row = frame * bins
  for (let k = 0; k < bins; k += 1) {
    const v = spec.data[row + k]
    if (v <= 0) continue
    /* 先"削肩"：88 个半音 bin 在低频（F2/C3 一带）分辨率不够，一个音的能量会漏到相邻半音，
     * 峰值旁边长出一截 0.5–0.6 倍高的影子。把"比左右邻居都矮"的那截减掉，影子就没了、
     * 真峰值基本不动 —— 否则 F 大三和弦会被判成 Faug（C3 漏成 C#3）。
     * 系数 0.5：只减一半留一半，两个真实相邻半音同时响时不会被抹掉一个。 */
    const lo = k > 0 ? spec.data[row + k - 1] : 0
    const hi = k < bins - 1 ? spec.data[row + k + 1] : 0
    const peak = Math.max(0, v - 0.5 * Math.max(lo, hi))
    if (peak <= 0) continue
    const pc = (((MIDI_LOW + k) % 12) + 12) % 12
    buf[pc] += peak * peak * OCTAVE_W[k]
  }
  let sq = 0
  for (let i = 0; i < 12; i += 1) sq += buf[i] * buf[i]
  if (sq > 1e-12) {
    const g = 1 / Math.sqrt(sq)
    for (let i = 0; i < 12; i += 1) buf[i] *= g
  }
  return buf
}

/** 往低频加权的余弦窗（低音区更可信；按 noteDigger 的 84 格公式算，本仓 88 格） */
const OCTAVE_W = (() => {
  const bins = 88
  const W = new Float32Array(bins)
  const T = 84
  const w = (2 * Math.PI) / T
  for (let i = 0; i < bins; i += 1) W[i] = (Math.cos(w * i - Math.PI) + 1) / Math.pow(2, i / 24)
  let sum = 0
  for (let i = 0; i < bins; i += 1) sum += W[i]
  const k = 12 / Math.max(1e-9, sum)
  for (let i = 0; i < bins; i += 1) W[i] *= k
  return W
})()

/**
 * 识别的核心：逐帧 Viterbi，返回每一帧的状态序号。
 * 单独导出是为了冒烟能验"帧数对不对"，也方便以后换解码器。
 */
export function decodeChords(spec: Spectrum): { states: Uint8Array; hopMs: number } {
  const m = getModel()
  const frames = spec.frames
  const hopMs = spec.hopMs
  const k = Math.pow(P_SWITCH_PER_SEC, hopMs / 1000)
  const trans = new Float32Array(m.logTrans)
  /* 按帧长换算"保持"概率：20fps → 约 0.99；若 hopMs 变了也不用改代码 */
  for (let a = 0; a < m.n; a += 1) {
    trans[a * m.n + a] = Math.log(k)
    let sumOther = 0
    for (let b = 0; b < m.n; b += 1) {
      if (b === a) continue
      trans[a * m.n + b] = Math.exp(m.logTrans[a * m.n + b])
      sumOther += trans[a * m.n + b]
    }
    const g = (1 - k) / Math.max(1e-9, sumOther)
    for (let b = 0; b < m.n; b += 1) {
      if (b === a) continue
      trans[a * m.n + b] = Math.log(Math.max(1e-12, trans[a * m.n + b] * g))
    }
  }

  const scores = new Float32Array(m.n)
  const next = new Float32Array(m.n)
  const ptrs = new Uint8Array(m.n)
  const backPtrs = new Uint8Array(frames * m.n)
  const chroma = new Float32Array(12)
  const like = new Float32Array(m.n)
  const specFrames = spec.frames

  for (let f = 0; f < frames; f += 1) {
    const frame = Math.min(specFrames - 1, f)
    chromaOf(spec, frame, chroma)
    /* 发射概率：余弦相似度（chroma 已归一化）取 5 次方拉开差距 */
    let pSum = 0
    for (let i = 0; i < m.n; i += 1) {
      let dot = 0
      for (let c = 0; c < 12; c += 1) dot += chroma[c] * m.templates[i * 12 + c]
      const p = dot > 0 ? Math.pow(dot, 5) : 0
      pSum += p
      like[i] = p
    }
    if (pSum < 1e-12) {
      like.fill(0)
      like[m.n - 1] = 1
      pSum = 1
    }
    const logSum = Math.log(pSum)
    for (let i = 0; i < m.n; i += 1) {
      next[i] = like[i] > 0 ? Math.log(like[i]) - logSum : -Infinity
    }

    if (f === 0) {
      for (let i = 0; i < m.n; i += 1) scores[i] = next[i] + m.logPrior[i]
      ptrs.fill(0)
    } else {
      for (let j = 0; j < m.n; j += 1) {
        let best = -Infinity
        let bestA = 0
        for (let a = 0; a < m.n; a += 1) {
          const s = scores[a] + trans[a * m.n + j]
          if (s > best) {
            best = s
            bestA = a
          }
        }
        next[j] += best
        ptrs[j] = bestA
      }
      scores.set(next)
      backPtrs.set(ptrs, f * m.n)
    }
  }

  /* 回溯 */
  const states = new Uint8Array(frames)
  let cur = 0
  let best = -Infinity
  for (let i = 0; i < m.n; i += 1) {
    if (scores[i] > best) {
      best = scores[i]
      cur = i
    }
  }
  for (let f = frames - 1; f >= 0; f -= 1) {
    states[f] = cur
    if (f > 0) cur = backPtrs[f * m.n + cur]
  }
  return { states, hopMs }
}

/**
 * 识别和弦，返回时间轴上的分段。
 * 前后同名的段合并；孤立一帧的跳变按邻居抹掉（否则界面上会闪几个 50ms 的小块）。
 */
export function detectChords(spec: Spectrum, opts: ChordOptions = {}): ChordSegment[] {
  if (spec.frames <= 0) return []
  const { states, hopMs } = decodeChords(spec)
  const m = getModel()
  const minMs = Math.max(0, opts.minMs ?? 100)

  /* 抹掉单帧毛刺：i 与左右都不同 → 跟左边 */
  const label = new Uint8Array(states)
  for (let i = 1; i < label.length - 1; i += 1) {
    if (label[i] !== label[i - 1] && label[i] !== label[i + 1]) label[i] = label[i - 1]
  }

  const out: ChordSegment[] = []
  let start = 0
  for (let i = 1; i <= label.length; i += 1) {
    if (i < label.length && label[i] === label[start]) continue
    const startMs = start * hopMs
    const endMs = i * hopMs
    const name = m.names[label[start]]
    const prev = out[out.length - 1]
    if (prev && prev.name === name) prev.endMs = endMs
    else if (prev && (endMs - startMs < minMs || name === 'N')) {
      /* 太短 / 判不出：并进前一段，别在界面上留碎块 */
      prev.endMs = endMs
    } else out.push({ startMs, endMs, name })
    start = i
  }
  return out
}
