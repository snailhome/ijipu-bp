/**
 * model/project.ts — 「方案」文件（`<音频文件名>.bp.json`）
 *
 * 为什么要方案：扒一首曲子不可能一次做完（用户 m01794）。关掉再开时应该回到
 * 上次的工作状态 —— 同一个音频、同一套参数、同一份音符表与视野，而不是从零开始，
 * 也不是只能导出 jps。
 *
 * 存什么：
 *  · 音频路径 + 文件名（**不复制音频**；音频挪走了就提示重新选）
 *  · 量化/显示/播放相关参数（BPM、拍号、弱起、首拍、调号、吸附、倍率…）
 *  · 音符表（含 confirmed —— 它决定导出，不能丢）
 *  · 视野（zoom/panMs）、播放头、循环区间
 * 不存什么：
 *  · 频谱/分析结果：打开时重算（几秒，且能跟着「去谐波」变化）
 *  · 分轨两轨 PCM：几十 MB，恢复时重新分离（用户 m01794 选「不存」）
 *  · 撤销栈：只留当前状态
 *
 * 文件跟音频放一起（用户选「跟音频放一起」），所以路径 = `${音频路径}.bp.json`，
 * 例：`D:\music\某曲.wav` → `D:\music\某曲.wav.bp.json`。带上原后缀，
 * 同一个曲子的 mp3/wav 两份不会互相覆盖。
 */
import type { PlayMode } from '../audio/player'
import type { PitchMode } from './store'
import type { EditMode, LoopRange, RawNote, SnapMode } from './types'

export const PROJECT_SUFFIX = '.bp.json'
export const PROJECT_APP = 'ijipu-bp'
export const PROJECT_VERSION = 1

/** 会跟着方案一起恢复的参数（analysis 之外的界面状态） */
export interface ProjectSettings {
  bpm: number
  beatsPerBar: number
  pickupBeats: number
  firstBeatMs: number
  tonic: number
  autoTonic: boolean
  title: string
  gain: number
  contrast: number
  bandOnly: boolean
  suppress: number
  autoNotes: boolean
  pitchMode: PitchMode
  mode: EditMode
  snap: SnapMode
  loop: LoopRange | null
  loopOn: boolean
  autoPage: boolean
  lockPitch: boolean
  playMode: PlayMode
  view: { zoom: number; panMs: number }
  /** 上次停在哪（毫秒） */
  currentMs: number
}

export interface ProjectFile {
  app: string
  version: number
  /** ISO 时间，只给人看/排查用 */
  savedAt: string
  audio: { name: string; path: string }
  settings: ProjectSettings
  notes: RawNote[]
}

/** 构建方案时用到的 state 切片（store 里那份 State 满足它） */
export interface ProjectSource extends ProjectSettings {
  fileName: string | null
  filePath: string | null
  notes: RawNote[]
}

/** `D:\a\b.wav` → `D:\a\b.wav.bp.json` */
export function projectPathFor(audioPath: string): string {
  return `${audioPath}${PROJECT_SUFFIX}`
}

/* 注：原来有个 `projectHasContent`（用户 m02314：有内容才建 `.bp.json`），
 * 现在自动存盘改成写本机缓存、只有 Ctrl+S / 「保存方案」才写文件（用户 m02483），
 * 后台不再需要这个判据，已删。 */

/** 当前 state → 方案对象；没有音频路径（浏览器）时返回 null */
export function buildProject(s: ProjectSource, savedAt = new Date().toISOString()): ProjectFile | null {
  if (!s.filePath || !s.fileName) return null
  return {
    app: PROJECT_APP,
    version: PROJECT_VERSION,
    savedAt,
    audio: { name: s.fileName, path: s.filePath },
    settings: {
      bpm: s.bpm,
      beatsPerBar: s.beatsPerBar,
      pickupBeats: s.pickupBeats,
      firstBeatMs: s.firstBeatMs,
      tonic: s.tonic,
      autoTonic: s.autoTonic,
      title: s.title,
      gain: s.gain,
      contrast: s.contrast,
      bandOnly: s.bandOnly,
      suppress: s.suppress,
      autoNotes: s.autoNotes,
      pitchMode: s.pitchMode,
      mode: s.mode,
      snap: s.snap,
      loop: s.loop,
      loopOn: s.loopOn,
      autoPage: s.autoPage,
      lockPitch: s.lockPitch,
      playMode: s.playMode,
      view: { zoom: s.view.zoom, panMs: s.view.panMs },
      currentMs: s.currentMs,
    },
    notes: s.notes,
  }
}

export function serializeProject(p: ProjectFile): string {
  return JSON.stringify(p, null, 2)
}

/* ── 读：坏文件不该把应用弄崩，逐字段保守取值 ── */

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def
}

function oneOf<T extends string>(v: unknown, all: readonly T[], def: T): T {
  return all.includes(v as T) ? (v as T) : def
}

function normNotes(raw: unknown): RawNote[] {
  if (!Array.isArray(raw)) return []
  const out: RawNote[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const n = raw[i] as Partial<RawNote> | null
    if (!n || typeof n !== 'object') continue
    const midi = Math.round(num(n.midi, NaN, 0, 127))
    const startMs = num(n.startMs, NaN, 0, 24 * 3600 * 1000)
    const endMs = num(n.endMs, NaN, 0, 24 * 3600 * 1000)
    if (!Number.isFinite(midi) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
    out.push({
      id: typeof n.id === 'string' && n.id ? n.id : `p${i.toString(36)}`,
      midi,
      startMs,
      endMs: Math.max(startMs + 1, endMs),
      velocity: num(n.velocity, 0.7, 0, 1),
      confirmed: bool(n.confirmed, false),
    })
  }
  return out
}

export function parseProject(text: string): { project: ProjectFile } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: '方案文件不是合法 JSON' }
  }
  const o = raw as Partial<ProjectFile> | null
  if (!o || typeof o !== 'object') return { error: '方案文件是空的' }
  if (o.app !== PROJECT_APP) return { error: '这不是爱扒谱的方案文件' }
  if (typeof o.version !== 'number' || o.version > PROJECT_VERSION) {
    return { error: `方案版本 ${String(o.version)} 太新，这个版本的爱扒谱读不了` }
  }
  const audio = (o.audio ?? {}) as Partial<ProjectFile['audio']>
  if (typeof audio.path !== 'string' || !audio.path) return { error: '方案里没有音频路径' }
  if (!Array.isArray(o.notes)) return { error: '方案里没有音符表' }

  const st = (o.settings ?? {}) as Partial<ProjectSettings>
  const view = (st.view ?? {}) as Partial<ProjectSettings['view']>
  const loop = (st.loop ?? null) as Partial<LoopRange> | null
  const loopOk =
    loop && Number.isFinite(Number(loop.startMs)) && Number.isFinite(Number(loop.endMs)) && Number(loop.endMs) > Number(loop.startMs)

  return {
    project: {
      app: PROJECT_APP,
      version: PROJECT_VERSION,
      savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
      audio: {
        name: typeof audio.name === 'string' && audio.name ? audio.name : audio.path.split(/[\\/]/).pop() || '音频',
        path: audio.path,
      },
      settings: {
        bpm: num(st.bpm, 100, 20, 300),
        beatsPerBar: num(st.beatsPerBar, 4, 1, 12),
        pickupBeats: num(st.pickupBeats, 0, 0, 11),
        firstBeatMs: num(st.firstBeatMs, 0, 0, 24 * 3600 * 1000),
        tonic: num(st.tonic, 0, 0, 11),
        autoTonic: bool(st.autoTonic, true),
        title: typeof st.title === 'string' ? st.title : '爱扒谱导出',
        gain: num(st.gain, 1, 0.1, 6),
        contrast: num(st.contrast, 1.4, 0.2, 4),
        /* 用户 2026-11-24：新方案默认勾选「只看人声区」（旧方案里没这个字段的也按勾选） */
        bandOnly: bool(st.bandOnly, true),
        suppress: num(st.suppress, 0, 0, 1),
        autoNotes: bool(st.autoNotes, false),
        pitchMode: oneOf<'name' | 'number'>(st.pitchMode, ['name', 'number'], 'number'),
        mode: oneOf<EditMode>(st.mode, ['draw', 'select'], 'select'),
        snap: oneOf<SnapMode>(st.snap, ['off', 'grid', 'beat', 'bar'], 'grid'),
        loop: loopOk ? { startMs: Number(loop!.startMs), endMs: Number(loop!.endMs) } : null,
        loopOn: bool(st.loopOn, false),
        autoPage: bool(st.autoPage, true),
        lockPitch: bool(st.lockPitch, false),
        playMode: oneOf<PlayMode>(st.playMode, ['audio', 'synth'], 'audio'),
        view: { zoom: num(view.zoom, 1, 1, 64), panMs: num(view.panMs, 0, 0, 24 * 3600 * 1000) },
        currentMs: num(st.currentMs, 0, 0, 24 * 3600 * 1000),
      },
      notes: normNotes(o.notes),
    },
  }
}
