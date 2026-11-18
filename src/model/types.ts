/**
 * model/types.ts — 爱扒谱的数据模型
 *
 * 两层坐标（方案文档 §7.1）：
 *  · RawNote：**秒轴**——从音频分析出来、贴原曲（一毫秒都不改）
 *  · GridNote：**拍轴**——量化到 1/16 拍、带小节序号，用来生成 jps
 * 两者都留着，用户调 BPM/首拍时只重算 GridNote，不回头改 RawNote。
 */

/** 秒轴音符（分析出来的是初稿，用户可改） */
export interface RawNote {
  id: string
  /** MIDI 音高（A4 = 69） */
  midi: number
  /** 起声（毫秒，音频绝对时间） */
  startMs: number
  /** 收声（毫秒） */
  endMs: number
  /** 力度 0..1（取该音符区间对数谱均值） */
  velocity: number
  /**
   * 是否"我确认这是谱音"。
   * 分析出来的音默认 false（淡色）；用户在绘制模式下点它 / 画出来的音是 true（亮色）。
   * **导出只认 confirmed**（用户 m01788 第 5、9 条），所以它决定成品，不是纯显示标记。
   */
  confirmed: boolean
}

/** 表格点击模式：绘制（画音 + 确认） / 选择（只试听） */
export type EditMode = 'draw' | 'select'

/** 吸附：关 / 半拍格点 / 拍 / 小节线 */
export type SnapMode = 'off' | 'grid' | 'beat' | 'bar'

/** 重复区间（循环播放） */
export interface LoopRange {
  startMs: number
  endMs: number
}

/** 调性候选：share = 相对可能性（0..1，全局归一） */
export interface KeyCandidate {
  /** 主音音级（C=0） */
  tonic: number
  share: number
}

/** 拍轴音符（量化后） */
export interface GridNote {
  midi: number
  /** 起点（以 1/4 拍为单位的 tick，16 分音符 = 1 tick） */
  startTick: number
  /** 时长（tick，≥1） */
  ticks: number
  velocity: number
}

/** 量化参数 */
export interface GridOptions {
  bpm: number
  beatsPerBar: number
  /** 首拍在音频里的绝对毫秒 */
  firstBeatMs: number
}

/** 频谱（帧 × 音高 bin），data 是行优先的 Float32Array */
export interface Spectrum {
  frames: number
  /** 每帧对应的 hop（毫秒） */
  hopMs: number
  sampleRate: number
  /** 长度 = frames × 88，单位方差归一化后的幅度（约 0..4） */
  data: Float32Array
  /** 每帧时域 RMS（静音判定用） */
  frameRms: Float32Array
}

/** 一次分析的完整产物（可直接 postMessage 传输） */
export interface AnalyzeResult {
  durationMs: number
  sampleRate: number
  spectrum: Spectrum
  notes: RawNote[]
  bpm: number
  firstBeatMs: number
  keyCandidates: KeyCandidate[]
  /** 节奏分析（拍点 + 重拍 + 可信度） */
  rhythm?: RhythmSummary
}

/** 节奏分析摘要（拍点数组不进 store，只留用得上的几个） */
export interface RhythmSummary {
  bpm: number
  firstBeatMs: number
  /** 0..1，越大越可信 */
  confidence: number
  /** 拍到第几拍（相对首拍）算小节第一拍，用来核对拍号 */
  downbeat: number
  /** 一共跟到多少个拍点 */
  beatCount: number
}
