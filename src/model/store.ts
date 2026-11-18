/**
 * model/store.ts — 唯一状态源（Zustand）
 *
 * 一条单向数据流：分析结果（秒轴）→ 量化参数 + 调号 → 拍轴音符 → jps 文本。
 * 任何参数改动都只调 `applyDerived`，界面不自己算 jps，避免两处口径。
 */
import { create } from 'zustand'
import { quantize } from '../jps/quantize'
import { toJps } from '../jps/toJps'
import type { PlayMode } from '../audio/player'
import type { AnalyzeResult, GridNote } from './types'

export type PitchMode = 'name' | 'number'

interface State {
  /* 文件 */
  fileName: string | null
  filePath: string | null
  durationMs: number
  /* 分析 */
  analysis: AnalyzeResult | null
  busy: string | null
  error: string | null
  /* 播放 */
  playing: boolean
  currentMs: number
  playMode: PlayMode
  /* 显示与量化参数 */
  pitchMode: PitchMode
  tonic: number
  autoTonic: boolean
  bpm: number
  beatsPerBar: number
  firstBeatMs: number
  title: string
  /* 派生 */
  grid: GridNote[]
  jps: string
  warnings: string[]
  parseErrors: string[]

  setBusy: (s: string | null) => void
  setError: (s: string | null) => void
  setLoaded: (p: { fileName: string; filePath: string | null; durationMs: number }) => void
  setAnalysis: (a: AnalyzeResult) => void
  setPlaying: (b: boolean) => void
  setCurrentMs: (ms: number) => void
  setPlayMode: (m: PlayMode) => void
  setPitchMode: (m: PitchMode) => void
  setTonic: (t: number) => void
  setBpm: (b: number) => void
  setBeatsPerBar: (b: number) => void
  setFirstBeatMs: (ms: number) => void
  setTitle: (s: string) => void
  setParseErrors: (e: string[]) => void
  /** 参数变了：重算拍轴 + jps */
  refresh: () => void
}

/** 由当前参数算出 grid / jps / warnings（纯计算，不改 state） */
function derive(s: Pick<State, 'analysis' | 'bpm' | 'beatsPerBar' | 'firstBeatMs' | 'tonic' | 'title'>) {
  if (!s.analysis) return { grid: [], jps: '', warnings: [] as string[] }
  const q = quantize(s.analysis.notes, {
    bpm: s.bpm,
    beatsPerBar: s.beatsPerBar,
    firstBeatMs: s.firstBeatMs,
  })
  const jps = toJps(q.notes, {
    bpm: s.bpm,
    beatsPerBar: s.beatsPerBar,
    firstBeatMs: s.firstBeatMs,
    tonic: s.tonic,
    title: s.title,
  })
  return { grid: q.notes, jps, warnings: q.warnings }
}

/** 把上面的 derive 应用回 state */
function applyDerived(
  set: (p: Partial<State>) => void,
  get: () => State,
): void {
  const s = get()
  set(derive(s))
}

export const useBp = create<State>((set, get) => ({
  fileName: null,
  filePath: null,
  durationMs: 0,
  analysis: null,
  busy: null,
  error: null,
  playing: false,
  currentMs: 0,
  playMode: 'audio',
  pitchMode: 'name',
  tonic: 0,
  autoTonic: true,
  bpm: 100,
  beatsPerBar: 4,
  firstBeatMs: 0,
  title: '爱扒谱导出',
  grid: [],
  jps: '',
  warnings: [],
  parseErrors: [],

  setBusy: (s) => set({ busy: s }),
  setError: (s) => set({ error: s }),
  setLoaded: (p) => set({ ...p, analysis: null, grid: [], jps: '', warnings: [] }),
  setAnalysis: (a) => {
    set({
      analysis: a,
      bpm: a.bpm,
      firstBeatMs: a.firstBeatMs,
      tonic: a.keyCandidates[0]?.tonic ?? 0,
      autoTonic: true,
      durationMs: Math.max(get().durationMs, a.durationMs),
      currentMs: 0,
    })
    applyDerived(set, get)
  },
  setPlaying: (b) => set({ playing: b }),
  setCurrentMs: (ms) => set({ currentMs: ms }),
  setPlayMode: (m) => set({ playMode: m }),
  setPitchMode: (m) => set({ pitchMode: m }),
  setTonic: (t) => {
    set({ tonic: t, autoTonic: false })
    applyDerived(set, get)
  },
  setBpm: (b) => {
    set({ bpm: Math.max(20, Math.min(300, b)) })
    applyDerived(set, get)
  },
  setBeatsPerBar: (b) => {
    set({ beatsPerBar: Math.max(1, Math.min(12, b)) })
    applyDerived(set, get)
  },
  setFirstBeatMs: (ms) => {
    set({ firstBeatMs: Math.max(0, ms) })
    applyDerived(set, get)
  },
  setTitle: (t) => {
    set({ title: t })
    applyDerived(set, get)
  },
  setParseErrors: (e) => set({ parseErrors: e }),
  refresh: () => applyDerived(set, get),
}))
