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
import { analyzeRhythm } from '../analysis/beat'
import { toJps } from '../jps/toJps'
import { MIDI_HIGH, MIDI_LOW } from '../analysis/pitchNames'
import type { PlayMode } from '../audio/player'
import type { ChordSegment } from '../analysis/chords'
import type { ProjectFile } from './project'
import type {
  AnalyzeResult,
  EditMode,
  GridNote,
  LoopRange,
  RawNote,
  RhythmSummary,
  SnapMode,
} from './types'

export type PitchMode = 'name' | 'number'

/** 视野：zoom=1 表示整曲铺满；panMs 是左边缘的时间 */
export interface View {
  zoom: number
  panMs: number
}

/** 自动翻页 / 默认视野的一屏时长（毫秒）。用户 m03712：默认只显示 20 秒，不是整曲。 */
export const PAGE_MS = 20000

/** 一屏宽显示几秒（用户 m02483）：默认 20 秒，范围 2–60 秒 —— 再窄看不清时值，再宽看不清拍 */
export const PAGE_SEC_MIN = 2
export const PAGE_SEC_MAX = 60
export const PAGE_SEC_DEFAULT = PAGE_MS / 1000

/** 表格每半音一行的高度（用户 m02483）：太小字叠在一起，太大一屏放不下几个八度 */
export const ROW_H_MIN = 10
export const ROW_H_MAX = 26
export const ROW_H_DEFAULT = 14

/** 默认让第一行落在 C7 附近（原来的 center=76 换算过来就是这里），重开时从 localStorage 恢复 */
export const TOP_MIDI_DEFAULT = 96

/** 播放速度（用户 m02483）：0.5×–2× 够慢听细节、也够快过一遍；默认 1×（只改快慢，不改音高） */
export const PLAY_RATE_MIN = 0.5
export const PLAY_RATE_MAX = 2
export const PLAY_RATE_DEFAULT = 1

/** localStorage 里记的界面尺寸（非 SSR 环境才读；坏了就用默认值） */
function lsNum(key: string, def: number, min: number, max: number): number {
  if (typeof localStorage === 'undefined') return def
  try {
    const v = Number(localStorage.getItem(key) ?? '')
    return Number.isFinite(v) && v >= min && v <= max ? v : def
  } catch {
    return def
  }
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
  /* 锁住竖着换音区（钢琴键盘上方那把锁，用户 m05515） */
  lockPitch: boolean
  /** 热力图显示倍率 */
  gain: number
  /** 热力图对比（指数） */
  contrast: number
  /** 只看人声区（G3–C6，约 196–1047Hz）· 减少伴奏干扰（用户 m06504 的便宜方案） */
  bandOnly: boolean
  /** 去谐波强度 0..1（0 = 不做） */
  suppress: number
  autoNotes: boolean
  /** 最近一次节奏分析的结果 */
  rhythm: RhythmSummary | null
  /* 显示与量化参数 */
  pitchMode: PitchMode
  /** 表格点击模式：draw=画音/确认，select=只试听 */
  mode: EditMode
  snap: SnapMode
  view: View
  /** 一屏宽显示几秒（滑条）；真正的视野仍以 view.zoom 为准，这里只记"用户要的宽度" */
  pageSec: number
  /** 表格行高（每半音一行，10–26px） */
  rowH: number
  /** 表格第一行的音高（MIDI）；滚轮上下换音区后记在这里，重开时恢复 */
  topMidi: number
  /** 播放速度（0.5×–2×，只改快慢不改音高） */
  playRate: number
  /** 和弦识别结果（noteDigger 复刻；只做提示，不写进 jps） */
  chords: ChordSegment[]
  /** 要不要把和弦名画在表格底下 */
  showChords: boolean
  tonic: number
  autoTonic: boolean
  bpm: number
  beatsPerBar: number
  /** 弱起拍数（0 = 第 1 小节也是整小节；>0 则第 1 小节只有这么多拍） */
  pickupBeats: number
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
  /** 恢复方案：覆盖参数与音符（analysis 由调用方先设好）。id 重新编号，避免和本进程新画的音撞号 */
  applyProject: (p: ProjectFile) => void
  setPlaying: (b: boolean) => void
  setCurrentMs: (ms: number) => void
  setPlayMode: (m: PlayMode) => void
  setPitchMode: (m: PitchMode) => void
  setMode: (m: EditMode) => void
  setSnap: (s: SnapMode) => void
  setView: (v: View) => void
  setPageSec: (sec: number) => void
  setRowH: (h: number) => void
  setTopMidi: (m: number) => void
  setPlayRate: (r: number) => void
  setChords: (c: ChordSegment[]) => void
  setShowChords: (b: boolean) => void
  setLoop: (r: LoopRange | null) => void
  setLoopOn: (b: boolean) => void
  setAutoPage: (b: boolean) => void
  setLockPitch: (b: boolean) => void
  setGain: (g: number) => void
  setContrast: (c: number) => void
  setBandOnly: (b: boolean) => void
  setSuppress: (s: number) => void
  setAutoNotes: (b: boolean) => void
  /** 用当前谱再跑一次节奏分析，并把 BPM/首拍/拍号写回去 */
  runRhythm: () => void
  setTonic: (t: number) => void
  setBpm: (b: number) => void
  setBeatsPerBar: (b: number) => void
  setPickupBeats: (n: number) => void
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
  /** 手动记一步撤销：重新分析这类"直接换掉整张音符表"的操作，先存一份好让 Ctrl+Z 找回来 */
  snapshotNotes: () => void
  /** 丢掉人工改动，回到分析初稿 */
  resetNotes: () => void
  /* ── 撤销（用户 m05736：50 步） ── */
  /** 一次拖动/一次按键算一步：按下时调它，松手时调 endEdit */
  beginEdit: () => void
  endEdit: () => void
  undo: () => void
  redo: () => void
  history: RawNote[][]
  future: RawNote[][]
}

/** 由当前参数算出 grid / jps / warnings（纯计算，不改 state） */
function derive(
  s: Pick<
    State,
    'notes' | 'bpm' | 'beatsPerBar' | 'pickupBeats' | 'firstBeatMs' | 'tonic' | 'title'
  >,
) {
  // 只有确认过的音才进谱面（用户 m01788 第 9 条）
  const confirmed = s.notes.filter((n) => n.confirmed)
  const q = quantize(confirmed, {
    bpm: s.bpm,
    beatsPerBar: s.beatsPerBar,
    pickupBeats: s.pickupBeats,
    firstBeatMs: s.firstBeatMs,
  })
  const jps = toJps(q.notes, {
    bpm: s.bpm,
    beatsPerBar: s.beatsPerBar,
    pickupBeats: s.pickupBeats,
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

/* ── 撤销 / 重做栈（用户 m05736 要 50 步，m05893 加到 200 步并要重做） ──
 * 用整份 notes 快照，不做 diff：扒谱的音符量级是几百到几千，太便宜了，diff 反而容易出现
 * "撤销之后和原来差一点"的坑。
 * 200 步的内存估算：一个音约 100 字节，1000 个音的曲子一份快照 100KB，200 份 ≈ 20MB 上限；
 * 实际扒谱的曲子多在 300–800 个音，通常在 5–10MB，可以接受。
 * 拖动时会有几十次 patchNote，所以用 gestureDepth 归并成一步。 */
const MAX_UNDO = 200
let gestureDepth = 0
let gestureSaved = false

function pushUndo(set: (p: Partial<State>) => void, get: () => State): void {
  if (gestureDepth > 0 && gestureSaved) return
  const s = get()
  const history = s.history.length >= MAX_UNDO ? s.history.slice(1) : s.history.slice()
  history.push(s.notes)
  gestureSaved = gestureDepth > 0
  /* 一旦有新动作，原来的"重做"就作废（跟常见编辑器一致） */
  set({ history, future: [] })
}

export const useBp = create<State>((set, get) => ({
  fileName: null,
  filePath: null,
  durationMs: 0,
  analysis: null,
  notes: [],
  history: [],
  future: [],
  busy: null,
  error: null,
  playing: false,
  currentMs: 0,
  playMode: 'audio',
  loop: null,
  loopOn: false,
  autoPage: true,
  lockPitch: false,
  gain: 1,
  contrast: 1.4,
  bandOnly: false,
  suppress: 0,
  autoNotes: false,
  rhythm: null,
  pitchMode: 'number',
  mode: 'select',
  snap: 'grid', /* 默认吸到最小格（1/16 拍）—— 点哪一格就画哪一格，用户 m04674 */
  view: { zoom: 1, panMs: 0 },
  pageSec: lsNum('bp.pageSec', PAGE_SEC_DEFAULT, PAGE_SEC_MIN, PAGE_SEC_MAX),
  rowH: Math.round(lsNum('bp.rowH', ROW_H_DEFAULT, ROW_H_MIN, ROW_H_MAX)),
  topMidi: Math.round(lsNum('bp.topMidi', TOP_MIDI_DEFAULT, MIDI_LOW, MIDI_HIGH)),
  playRate: lsNum('bp.playRate', PLAY_RATE_DEFAULT, PLAY_RATE_MIN, PLAY_RATE_MAX),
  chords: [],
  showChords: true,
  tonic: 0,
  autoTonic: true,
  bpm: 100,
  beatsPerBar: 4,
  pickupBeats: 0,
  firstBeatMs: 0,
  title: '爱扒谱导出',
  grid: [],
  jps: '',
  warnings: [],
  parseErrors: [],

  setBusy: (s) => set({ busy: s }),
  setError: (s) => set({ error: s }),
  setLoaded: (p) => {
    /* 打开就一屏 20 秒（用户 m04107：打开音频文件，只显示前 20 秒）。
     * 以前这个缩放只在"开始播放"那个 effect 里做，于是刚打开时其实是整曲铺满；
     * 现在装载时直接把 zoom 算好，比 20 秒短的曲子仍然整首显示。
     * 一屏几秒是可调的（用户 m02483）：用当前设置 pageSec，不是写死的 20 秒。 */
    const page = Math.max(1, Math.min(p.durationMs || 1, (get().pageSec || PAGE_SEC_DEFAULT) * 1000))
    const zoom = Math.max(1, (p.durationMs || 1) / page)
    set({
      ...p,
      analysis: null,
      notes: [],
      grid: [],
      jps: '',
      warnings: [],
      chords: [],
      currentMs: 0,
      view: { zoom, panMs: 0 },
      loop: null,
      loopOn: false,
      history: [],
      future: [],
    })
    gestureDepth = 0
    gestureSaved = false
  },
  setAnalysis: (a) => {
    set({
      analysis: a,
      notes: a.notes.map((n) => ({ ...n, confirmed: false })),
      /* 换了一轮分析（换了轨/去谐波）：上一轮的和弦不再作数，等用户再点「和弦分析」 */
      chords: [],
      bpm: a.bpm,
      firstBeatMs: a.firstBeatMs,
      tonic: a.keyCandidates[0]?.tonic ?? 0,
      autoTonic: true,
      rhythm: a.rhythm ?? null,
      durationMs: Math.max(get().durationMs, a.durationMs),
      currentMs: 0,
    })
    applyDerived(set, get)
  },
  applyProject: (p) => {
    /* 方案是上一轮存下来的，参数按现在的上下限再钳一遍（拍号改小后弱起不能越界）。
     * 音符 id 重新编号：本进程可能已经画过几个音，直接用旧 id 有撞号风险。 */
    const per = Math.max(1, Math.min(12, Math.round(p.settings.beatsPerBar)))
    const pickup = Math.max(0, Math.min(per - 1, Math.round(p.settings.pickupBeats)))
    const dur = get().durationMs || Number.POSITIVE_INFINITY
    set({
      notes: p.notes.map((n) => ({ ...n, id: nextId() })),
      bpm: Math.max(20, Math.min(300, p.settings.bpm)),
      beatsPerBar: per,
      pickupBeats: pickup,
      firstBeatMs: Math.max(0, p.settings.firstBeatMs),
      tonic: Math.max(0, Math.min(11, Math.round(p.settings.tonic))),
      autoTonic: p.settings.autoTonic,
      title: p.settings.title,
      gain: Math.max(0.1, Math.min(6, p.settings.gain)),
      contrast: Math.max(0.2, Math.min(4, p.settings.contrast)),
      bandOnly: p.settings.bandOnly,
      suppress: Math.max(0, Math.min(1, p.settings.suppress)),
      autoNotes: p.settings.autoNotes,
      pitchMode: p.settings.pitchMode,
      mode: p.settings.mode,
      snap: p.settings.snap,
      loop: p.settings.loop,
      loopOn: p.settings.loopOn && !!p.settings.loop,
      autoPage: p.settings.autoPage,
      lockPitch: p.settings.lockPitch,
      playMode: p.settings.playMode,
      view: {
        zoom: Math.max(1, Math.min(64, p.settings.view.zoom)),
        panMs: Math.max(0, p.settings.view.panMs),
      },
      currentMs: Math.max(0, Math.min(dur, p.settings.currentMs)),
      history: [],
      future: [],
    })
    gestureDepth = 0
    gestureSaved = false
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
  setPageSec: (sec) => {
    /* 滑条要的是"一屏几秒"，换算成 zoom 存；比整首还宽时 zoom 停在 1（整曲铺满） */
    const s = Math.max(PAGE_SEC_MIN, Math.min(PAGE_SEC_MAX, Math.round(sec * 10) / 10))
    const dur = get().durationMs
    const d = Math.max(400, dur)
    const span = Math.min(d, s * 1000)
    const zoom = Math.max(1, Math.min(64, d / Math.max(1, span)))
    const maxPan = Math.max(0, dur - d / zoom)
    set({
      pageSec: s,
      view: { zoom, panMs: Math.max(0, Math.min(maxPan, get().view.panMs)) },
    })
  },
  setRowH: (h) =>
    set({ rowH: Math.round(Math.max(ROW_H_MIN, Math.min(ROW_H_MAX, h))) }),
  setTopMidi: (m) =>
    set({ topMidi: Math.round(Math.max(MIDI_LOW, Math.min(MIDI_HIGH, m))) }),
  setPlayRate: (r) =>
    set({ playRate: Math.round(Math.max(PLAY_RATE_MIN, Math.min(PLAY_RATE_MAX, r)) * 100) / 100 }),
  setChords: (c) => set({ chords: c }),
  setShowChords: (b) => set({ showChords: b }),
  setLoop: (r) => set({ loop: r }),
  setLoopOn: (b) => set({ loopOn: b }),
  setAutoPage: (b) => set({ autoPage: b }),
  setLockPitch: (b) => set({ lockPitch: b }),
  setGain: (g) => set({ gain: Math.max(0.1, Math.min(6, g)) }),
  setSuppress: (v) => set({ suppress: Math.max(0, Math.min(1, v)) }),
  setAutoNotes: (b) => set({ autoNotes: b }),
  runRhythm: () => {
    const s = get()
    const spec = s.analysis?.spectrum
    if (!spec) return
    const r = analyzeRhythm(spec, s.beatsPerBar)
    set({
      bpm: r.bpm,
      firstBeatMs: r.firstBeatMs,
      rhythm: {
        bpm: r.bpm,
        firstBeatMs: r.firstBeatMs,
        confidence: r.confidence,
        downbeat: r.downbeat,
        beatCount: r.beats.length,
      },
    })
    applyDerived(set, get)
  },
  setContrast: (c) => set({ contrast: Math.max(0.2, Math.min(4, c)) }),
  setBandOnly: (b) => set({ bandOnly: b }),
  setTonic: (t) => {
    set({ tonic: t, autoTonic: false })
    applyDerived(set, get)
  },
  setBpm: (b) => {
    set({ bpm: Math.max(20, Math.min(300, b)) })
    applyDerived(set, get)
  },
  setBeatsPerBar: (b) => {
    const per = Math.max(1, Math.min(12, b))
    /* 弱起必须比一小节少：拍号改小后顺手把弱起钳回来，避免出现"弱起 5 拍 / 每小节 4 拍" */
    set({ beatsPerBar: per, pickupBeats: Math.min(get().pickupBeats, per - 1) })
    applyDerived(set, get)
  },
  setPickupBeats: (n) => {
    const per = Math.max(1, Math.min(12, get().beatsPerBar))
    set({ pickupBeats: Math.max(0, Math.min(per - 1, Math.round(n))) })
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
    pushUndo(set, get)
    const startMs = Math.max(0, Math.min(n.startMs, n.endMs))
    /* 最短 20ms：只是防 0 长度，不再卡 40ms —— 最小绘制格是 1/16 拍（120bpm 下 31ms） */
    const endMs = Math.max(startMs + 20, Math.max(n.startMs, n.endMs))
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
    pushUndo(set, get)
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
    pushUndo(set, get)
    set({ notes: get().notes.filter((n) => n.id !== id) })
    applyDerived(set, get)
  },
  toggleConfirmed: (id) => {
    pushUndo(set, get)
    set({
      notes: get().notes.map((n) =>
        n.id === id ? { ...n, confirmed: !n.confirmed } : n,
      ),
    })
    applyDerived(set, get)
  },
  setAllConfirmed: (b) => {
    pushUndo(set, get)
    set({ notes: get().notes.map((n) => ({ ...n, confirmed: b })) })
    applyDerived(set, get)
  },
  snapshotNotes: () => {
    if (get().notes.length === 0) return
    pushUndo(set, get)
  },
  resetNotes: () => {
    const a = get().analysis
    pushUndo(set, get)
    set({ notes: a ? a.notes.map((n) => ({ ...n, confirmed: false })) : [] })
    applyDerived(set, get)
  },

  /* ── 撤销 ── */
  beginEdit: () => {
    gestureDepth += 1
    gestureSaved = false
  },
  endEdit: () => {
    gestureDepth = 0
    gestureSaved = false
  },
  undo: () => {
    const s = get()
    if (s.history.length === 0) return
    gestureDepth = 0
    gestureSaved = false
    const prev = s.history[s.history.length - 1]
    set({
      history: s.history.slice(0, -1),
      /* 撤销出去的这一份进重做栈，重做时原样塞回来 */
      future: [...s.future, s.notes].slice(-MAX_UNDO),
      notes: prev,
    })
    applyDerived(set, get)
  },
  redo: () => {
    const s = get()
    if (s.future.length === 0) return
    gestureDepth = 0
    gestureSaved = false
    const next = s.future[s.future.length - 1]
    set({
      future: s.future.slice(0, -1),
      history: [...s.history, s.notes].slice(-MAX_UNDO),
      notes: next,
    })
    applyDerived(set, get)
  },
}))
