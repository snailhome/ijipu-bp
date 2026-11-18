/**
 * model/store.ts — 唯一状态源（Zustand）
 *
 * 一条单向数据流：分析结果（秒轴）→ **可编辑的音符表** → 量化参数 + 调号 → 拍轴音符 → jps 文本。
 * 任何参数改动都只调 `applyDerived`，界面不自己算 jps，避免两处口径。
 *
 * 为什么音符要单独存一份（`notes`）而不是直接读 `analysis.notes`：
 * 扒谱是人工核对的过程 —— 分析只是**初稿**，用户会改音高、拖时值、删掉泛音误报。
 * 改了以后仍然要能"回到机器初稿"，所以 `analysis.notes` 一直留着当底稿（界面上的「重来」）。
 *
 * 为什么要 `confirmed`：
 * 分析给出的音有一堆泛音误报，**只有用户点过的音才算数**（用户 m01788 第 5、9 条）：
 * 绘制模式下点一下 = 确认/取消确认，导出与简谱预览都只认确认过的音。
 */
import { create } from 'zustand'
import { quantize } from '../jps/quantize'
import { toJps } from '../jps/toJps'
import type { PlayMode } from '../audio/player'
import type {
  AnalyzeResult,
  EditMode,
  GridNote,
  LoopRange,
  RawNote,
  SnapMode,
} from './types'

export type PitchMode = 'name' | 'number'

/** 视野：zoom=1 表示整曲铺满；panMs 是左边缘的时间 */
export interface View {
  zoom: number
  panMs: number
}

interface State {
  /* 文件 */
  fileName: string | null
  filePath: string | null
  durationMs: number
  /* 分析 */
  analysis: AnalyzeResult | null
  /** 当前音符表（可编辑；初值来自 analysis.notes，全部未确认） */
  notes: RawNote[]
  busy: string | null
  error: string | null
  /* 播放 */
  playing: boolean
  currentMs: number
  playMode: PlayMode
  /** 循环区间（重复区间） */
  loop: LoopRange | null
  loopOn: boolean
  /** 播放时自动把视野推到播放头（自动翻页） */
  autoPage: boolean
  /** 热力图显示倍率 */
  gain: number
  /** 热力图对比（指数） */
  contrast: number
  /* 显示与量化参数 */
  pitchMode: PitchMode
  /** 表格点击模式：draw=画音/确认，select=只试听 */
  mode: EditMode
  snap: SnapMode
  view: View
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
  setMode: (m: EditMode) => void
  setSnap: (s: SnapMode) => void
  setView: (v: View) => void
  setLoop: (r: LoopRange | null) => void
  setLoopOn: (b: boolean) => void
  setAutoPage: (b: boolean) => void
  setGain: (g: number) => void
  setContrast: (c: number) => void
  setTonic: (t: number) => void
  setBpm: (b: number) => void
  setBeatsPerBar: (b: number) => void
  setFirstBeatMs: (ms: number) => void
  setTitle: (s: string) => void
  setParseErrors: (e: string[]) => void
  /** 参数变了：重算拍轴 + jps */
  refresh: () => void

  /* ── 音符编辑（扒谱的人工环节） ── */
  /** 加一个音（返回新 id，便于画音时顺手拖动时值） */
  addNote: (n: {
    midi: number
    startMs: number
    endMs: number
    velocity?: number
  }) => string
  patchNote: (id: string, patch: Partial<Pick<RawNote, 'midi' | 'startMs' | 'endMs'>>) => void
  removeNote: (id: string) => void
  /** 确认 / 取消确认（绘制模式下点音符） */
  toggleConfirmed: (id: string) => void
  /** 全选 / 全不选 */
  setAllConfirmed: (b: boolean) => void
  /** 丢掉人工改动，回到分析初稿 */
  resetNotes: () => void
}

/** 由当前参数算出 grid / jps / warnings（纯计算，不改 state） */
function derive(
  s: Pick<
    State,
    'notes' | 'bpm' | 'beatsPerBar' | 'firstBeatMs' | 'tonic' | 'title'
  >,
) {
  // 只有确认过的音才进谱面（用户 m01788 第 9 条）
  const confirmed = s.notes.filter((n) => n.confirmed)
  const q = quantize(confirmed, {
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
  const unconfirmed = s.notes.length - confirmed.length
  const warnings = [...q.warnings]
  if (unconfirmed > 0) {
    warnings.push(
      `还有 ${unconfirmed} 个音没确认（淡色的），导出与简谱预览都不含它们 —— 绘制模式下点一下就是确认。`,
    )
  }
  return { grid: q.notes, jps, warnings }
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
  loop: null,
  loopOn: false,
  autoPage: true,
  gain: 0.85,
  contrast: 1.2,
  pitchMode: 'name',
  mode: 'draw',
  snap: 'beat',
  view: { zoom: 1, panMs: 0 },
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
  setLoaded: (p) =>
    set({
      ...p,
      analysis: null,
      notes: [],
      grid: [],
      jps: '',
      warnings: [],
      currentMs: 0,
      view: { zoom: 1, panMs: 0 },
      loop: null,
      loopOn: false,
    }),
  setAnalysis: (a) => {
    set({
      analysis: a,
      notes: a.notes.map((n) => ({ ...n, confirmed: false })),
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
  setMode: (m) => set({ mode: m }),
  setSnap: (s) => set({ snap: s }),
  setView: (v) =>
    set({
      view: {
        zoom: Math.max(1, Math.min(64, v.zoom)),
        panMs: Math.max(0, v.panMs),
      },
    }),
  setLoop: (r) => set({ loop: r }),
  setLoopOn: (b) => set({ loopOn: b }),
  setAutoPage: (b) => set({ autoPage: b }),
  setGain: (g) => set({ gain: Math.max(0.1, Math.min(6, g)) }),
  setContrast: (c) => set({ contrast: Math.max(0.2, Math.min(4, c)) }),
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
      confirmed: true,
    }
    const notes = [...get().notes, note].sort(
      (a, b) => a.startMs - b.startMs || a.midi - b.midi,
    )
    set({ notes })
    applyDerived(set, get)
    return note.id
  },
  patchNote: (id, patch) => {
    const notes = get()
      .notes.map((n) => {
        if (n.id !== id) return n
        const merged = { ...n, ...patch }
        if (patch.midi !== undefined) {
          merged.midi = Math.max(21, Math.min(108, Math.round(merged.midi)))
        }
        if (patch.startMs !== undefined) merged.startMs = Math.max(0, merged.startMs)
        if (patch.endMs !== undefined) {
          merged.endMs = Math.max(merged.startMs + 40, merged.endMs)
        }
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
  toggleConfirmed: (id) => {
    set({
      notes: get().notes.map((n) =>
        n.id === id ? { ...n, confirmed: !n.confirmed } : n,
      ),
    })
    applyDerived(set, get)
  },
  setAllConfirmed: (b) => {
    set({ notes: get().notes.map((n) => ({ ...n, confirmed: b })) })
    applyDerived(set, get)
  },
  resetNotes: () => {
    const a = get().analysis
    set({ notes: a ? a.notes.map((n) => ({ ...n, confirmed: false })) : [] })
    applyDerived(set, get)
  },
}))
