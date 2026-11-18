/**
 * model/store.ts — 唯一状态源（Zustand）
 *
 * 一条单向数据流：分析结果（秒轴）→ **可编辑的音符表** → 量化参数 + 调号 → 拍轴音符 → jps 文本。
 * 任何参数改动都只调 `applyDerived`，界面不自己算 jps，避免两处口径。
 *
 * 为什么音符要单独存一份（`notes`）而不是直接读 `analysis.notes`：
 * 扒谱是人工核对的过程 —— 分析只是**初稿**，用户会改音高、拖时值、删掉泛音误报。
 * 改了以后仍然要能"回到机器初稿"，所以 `analysis.notes` 一直留着当底稿（界面上的「重来」）。
 */
import { create } from 'zustand'
import { quantize } from '../jps/quantize'
import { toJps } from '../jps/toJps'
import type { PlayMode } from '../audio/player'
import type { AnalyzeResult, GridNote, RawNote } from './types'

export type PitchMode = 'name' | 'number'

interface State {
  /* 文件 */
  fileName: string | null
  filePath: string | null
  durationMs: number
  /* 分析 */
  analysis: AnalyzeResult | null
  /** 当前音符表（可编辑；初值来自 analysis.notes） */
  notes: RawNote[]
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

  /* ── 音符编辑（扒谱的人工环节） ── */
  addNote: (n: { midi: number; startMs: number; endMs: number; velocity?: number }) => void
  patchNote: (id: string, patch: Partial<Pick<RawNote, 'midi' | 'startMs' | 'endMs'>>) => void
  removeNote: (id: string) => void
  /** 丢掉人工改动，回到分析初稿 */
  resetNotes: () => void
}

/** 由当前参数算出 grid / jps / warnings（纯计算，不改 state） */
function derive(
  s: Pick<State, 'notes' | 'bpm' | 'beatsPerBar' | 'firstBeatMs' | 'tonic' | 'title'>,
) {
  const q = quantize(s.notes, {
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
function applyDerived(set: (p: Partial<State>) => void, get: () => State): void {
  const s = get()
  set(derive(s))
}

let seq = 0
function nextId(): string {
  seq += 1
  return `m${seq.toString(36)}`
}

export const useBp = create<State>((set, get) => ({
  fileName: null,
  filePath: null,
  durationMs: 0,
  analysis: null,
  notes: [],
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
  setLoaded: (p) => set({ ...p, analysis: null, notes: [], grid: [], jps: '', warnings: [] }),
  setAnalysis: (a) => {
    set({
      analysis: a,
      notes: a.notes.map((n) => ({ ...n })),
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

  addNote: (n) => {
    const startMs = Math.max(0, Math.min(n.startMs, n.endMs))
    const endMs = Math.max(startMs + 40, Math.max(n.startMs, n.endMs))
    const note: RawNote = {
      id: nextId(),
      midi: Math.max(21, Math.min(108, Math.round(n.midi))),
      startMs,
      endMs,
      velocity: n.velocity ?? 0.8,
    }
    const notes = [...get().notes, note].sort((a, b) => a.startMs - b.startMs || a.midi - b.midi)
    set({ notes })
    applyDerived(set, get)
  },
  patchNote: (id, patch) => {
    const notes = get()
      .notes.map((n) => {
        if (n.id !== id) return n
        const merged = { ...n, ...patch }
        if (patch.midi !== undefined) merged.midi = Math.max(21, Math.min(108, Math.round(merged.midi)))
        if (patch.startMs !== undefined) merged.startMs = Math.max(0, merged.startMs)
        if (patch.endMs !== undefined) merged.endMs = Math.max(merged.startMs + 40, merged.endMs)
        if (merged.endMs <= merged.startMs) merged.endMs = merged.startMs + 40
        return merged
      })
      .sort((a, b) => a.startMs - b.startMs || a.midi - b.midi)
    set({ notes })
    applyDerived(set, get)
  },
  removeNote: (id) => {
    set({ notes: get().notes.filter((n) => n.id !== id) })
    applyDerived(set, get)
  },
  resetNotes: () => {
    const a = get().analysis
    set({ notes: a ? a.notes.map((n) => ({ ...n })) : [] })
    applyDerived(set, get)
  },
}))
