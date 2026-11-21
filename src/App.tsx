/**
 * App.tsx — 爱扒谱的主界面
 *
 * 布局（用户 m01788 之后的形态）：上面工具条；中间左边「音符表 + 简谱流线谱」占满，
 * 右边有三种页签（用户 m02483）：调节（吸附 / 调号 / 生成参数 / jps 源码）、
 * 分析（调性分析候选 / 节奏与谐波 / 分轨）、设置（显示组 / 一次性开关 / 关于），顶栏只有一颗右栏开关。
 *
 * 独立的频谱面板已经撤掉 —— 频谱能量直接铺在音符表的格子里当热力图，
 * 把纵向空间全让给"音高 × 时间"的表格（对照 noteDigger 的信息密度）。
 *
 * 数据流：打开音频 → worker 分析 → store 出 grid/jps → 画布与预览都读 store。
 * 播放两种模式（原音频 / 合成音）共用播放头；Tab 随时切换；空格播放；反引号切点击模式。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { keyColor, keyDisplayName } from './analysis/pitchNames'
import { loadAudioFromPath, pickAndLoadAudio, type LoadedAudio } from './audio/decode'
import { play, setAudioBuffer, setStemBuffers, setPlayTrack, makeAudioBuffer, stop, audition, type PlayMode } from './audio/player'
import {
  canSeparate,
  downloadModel,
  onDownloadProgress,
  openUrl,
  separateStems,
  sepModelPath,
  sepModelTarget,
  sepReady,
  type SepReady,
} from './audio/separate'
import { computeSpectrum } from './analysis/spectrum'
import type { ChordSegment } from './analysis/chords'
import { COPY } from './brand/copy'
import { APP_VERSION } from './brand/version'
import { invoke, isTauriShell } from './brand/env'
import { PAGE_SEC_MAX, PAGE_SEC_MIN, ROW_H_MAX, ROW_H_MIN, useBp } from './model/store'
import { buildProject, parseProject, projectPathFor, serializeProject } from './model/project'
import type { ProjectFile } from './model/project'
import { barIndexOf, barStartTick } from './jps/bars'
import { spanMs } from './ui/timeAxis'
import type { AnalyzeResult, LoopRange, SnapMode, Spectrum } from './model/types'
import { NoteRoll } from './ui/NoteRoll'
import { StripPreview } from './ui/StripPreview'

/** 分析拿哪一路音频：跟着右栏"混音 / 人声 / 伴奏"的当前选择走（用户 m00810） */
type AnalyzeSource = 'mix' | 'vocals' | 'instrumental'
const SOURCE_LABEL: Record<AnalyzeSource, string> = { mix: '混音', vocals: '人声', instrumental: '伴奏' }

/** 浏览器/开发环境下方案的 localStorage 键前缀（桌面壳走真实文件，不碰它） */
const PROJECT_LS_PREFIX = 'bp.project:'

/** 「随时保存」那份本机缓存（不是方案文件，用户 m02483） */
const CACHE_KEY = 'bp.cache'

/** 危险操作（清空确认 / 回到初稿 / 重新分析）之前的恢复快照（用户 m02483：辛苦识别的谱要能找回来） */
const RECOVERY_KEY = 'bp.recovery'

/** range 滑条的"已填充"比例（CSS 里 --fill 决定渐变停在哪；值到顶时颜色真的顶到尽头） */
function fillStyle(pct: number): Record<string, string> {
  const v = Math.max(0, Math.min(100, pct))
  return { ['--fill']: v.toFixed(1) + '%' }
}

/** ISO 时间 → 本地 HH:MM:SS（方案提示、状态栏"已存"用） */
function clockOfIso(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
}

/** 「有没有未保存的修改」的指纹（用户 m02483）：只看谱面内容（音符 + 生成参数）；
 *  视野/循环/播放模式这些"导航"不算，免得滚一下表格、圈个练习区间就变橙。 */
function contentSig(s: ReturnType<typeof useBp.getState>): string {
  return JSON.stringify({
    notes: s.notes,
    bpm: s.bpm,
    beatsPerBar: s.beatsPerBar,
    pickupBeats: s.pickupBeats,
    firstBeatMs: s.firstBeatMs,
    tonic: s.tonic,
    autoTonic: s.autoTonic,
    title: s.title,
  })
}


/** 顶栏图标：16×16 线性图标，自己画（用户 m06232：顶栏按钮尽量图标化，风格照 noteDigger） */
function Icon({ name }: { name: string }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'folder':
      return (
        <svg {...common}>
          <path d="M2 4.5h4l1.4 1.6H14v6.4H2z" />
        </svg>
      )
    case 'analyze':
      /* 频谱柱 + 一点高光：对当前这一轨"自动判音" */
      return (
        <svg {...common}>
          <path d="M2.6 12V9M5.4 12V6.4M8.2 12V8.6M11 12V4.4M13.6 12V7.2" />
          <circle cx="11" cy="2.6" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'analysisPanel':
      /* 频谱柱 + 放大镜：右栏的「分析」页签（节奏 / 分轨） */
      return (
        <svg {...common}>
          <path d="M2 13V9.6M4.6 13V6.8M7.2 13V8.4" />
          <circle cx="10.6" cy="8.8" r="2.5" />
          <path d="M12.5 10.7l2 2" />
        </svg>
      )
    case 'tune':
      /* 三条滑杆：右栏的「调节」页签 */
      return (
        <svg {...common}>
          <path d="M2.4 4.6h11.2M2.4 8h11.2M2.4 11.4h11.2" />
          <circle cx="5.6" cy="4.6" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="9.6" cy="8" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="6.6" cy="11.4" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'settings':
      /* 齿轮：右栏的「设置」页签 */
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.1" />
          <path d="M8 2.2v1.7M8 12.1v1.7M2.2 8h1.7M12.1 8h1.7M3.9 3.9l1.2 1.2M10.9 10.9l1.2 1.2M12.1 3.9l-1.2 1.2M5.1 10.9l-1.2 1.2" />
        </svg>
      )
    case 'save':
      /* 软盘：立刻存一次方案 */
      return (
        <svg {...common}>
          <path d="M2.6 2.6h8.1l2.7 2.7v8.1H2.6z" />
          <path d="M5.2 2.6v3.7h4.4V2.6" />
          <path d="M5.2 11.4V8.6h5.2v2.8" />
        </svg>
      )
    case 'openProject':
      /* 文件夹 + 向上箭头：打开方案 */
      return (
        <svg {...common}>
          <path d="M2 4.5h4l1.4 1.6H14v6.4H2z" />
          <path d="M8 11.2V7.8M6.5 9.3L8 7.8l1.5 1.5" />
        </svg>
      )
    case 'play':
      return (
        <svg {...common}>
          <path d="M5 3.2l7 4.8-7 4.8z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'pause':
      return (
        <svg {...common}>
          <rect x="4.6" y="3.4" width="2.4" height="9.2" fill="currentColor" stroke="none" />
          <rect x="9" y="3.4" width="2.4" height="9.2" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'wave':
      return (
        <svg {...common}>
          <path d="M2 8h2l1.4-3.4L8 12l1.6-6.6L11 8h3" />
        </svg>
      )
    case 'note':
      return (
        <svg {...common}>
          <circle cx="5.6" cy="11.2" r="1.9" />
          <path d="M7.5 11.2V4l5 1.2v2" />
        </svg>
      )
    case 'chord':
      /* 三颗叠起来的音头：和弦识别（从 noteDigger 的 chordEst 复刻） */
      return (
        <svg {...common}>
          <circle cx="5.4" cy="4.6" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="5.4" cy="8" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="5.4" cy="11.4" r="1.6" fill="currentColor" stroke="none" />
          <path d="M7.2 4.6h4.4M7.2 8h4.4M7.2 11.4h4.4" />
        </svg>
      )
    case 'pencil':
      return (
        <svg {...common}>
          <path d="M11.2 2.6l2.2 2.2L5.8 12.4 3 13l.6-2.8z" />
        </svg>
      )
    case 'cursor':
      return (
        <svg {...common}>
          <path d="M4 2.8l8.2 4.4-3.6 1.1-1.2 3.6z" />
        </svg>
      )
    case 'magnet':
      return (
        <svg {...common}>
          <path d="M4 12V7a4 4 0 018 0v5" />
          <path d="M4 12h2.6M9.4 12H12" />
        </svg>
      )
    case 'loop':
      return (
        <svg {...common}>
          <path d="M3.2 7.2A4.2 4.2 0 017.4 3H11" />
          <path d="M9.4 1.6L11.6 3 9.4 4.4" />
          <path d="M12.8 8.8A4.2 4.2 0 018.6 13H5" />
          <path d="M6.6 11.6L4.4 13l2.2 1.4" />
        </svg>
      )
    case 'page':
      return (
        <svg {...common}>
          <path d="M3.4 3.2h5.4l3.8 3.8v5.8H3.4z" />
          <path d="M8.6 3.4V7h3.6" />
        </svg>
      )
    case 'undo':
      return (
        <svg {...common}>
          <path d="M5.6 5.2H11a3.4 3.4 0 010 6.8H7" />
          <path d="M7.4 3L5 5.2l2.4 2.2" />
        </svg>
      )
    case 'redo':
      return (
        <svg {...common}>
          <path d="M10.4 5.2H5a3.4 3.4 0 000 6.8h4" />
          <path d="M8.6 3L11 5.2 8.6 7.4" />
        </svg>
      )
    case 'home':
      return (
        <svg {...common}>
          <path d="M4 3.4v9.2" />
          <path d="M12 3.6L5.8 8l6.2 4.4z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'checkAll':
      return (
        <svg {...common}>
          <rect x="2.4" y="3.4" width="8.6" height="8.6" rx="1.6" />
          <path d="M4.6 7.8l1.9 1.9 3.4-3.6" />
          <path d="M12.6 4.6v6.8a1.6 1.6 0 01-1.6 1.6H4.8" opacity=".55" />
        </svg>
      )
    case 'checkNone':
      return (
        <svg {...common}>
          <rect x="2.4" y="3.4" width="8.6" height="8.6" rx="1.6" />
          <path d="M12.6 4.6v6.8a1.6 1.6 0 01-1.6 1.6H4.8" opacity=".55" />
        </svg>
      )
    case 'gear':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" />
        </svg>
      )
    case 'reset':
      return (
        <svg {...common}>
          <path d="M3.6 8a4.4 4.4 0 104.4-4.4H5.4" />
          <path d="M7 1.8L4.8 3.6 7 5.4" />
        </svg>
      )
    case 'export':
      return (
        <svg {...common}>
          <path d="M8 2.6v7" />
          <path d="M5.2 6.8L8 9.6l2.8-2.8" />
          <path d="M2.8 11.4v1.8h10.4v-1.8" />
        </svg>
      )
    /* 音名 / 简谱数字：这两颗用文字当图标（A 和 1），比画抽象符号好认 */
    case 'pitchName':
      return (
        <svg {...common}>
          <text x="8" y="12" textAnchor="middle" fontSize="11.5" fontWeight="600" fill="currentColor" stroke="none">
            A
          </text>
        </svg>
      )
    case 'pitchNumber':
      return (
        <svg {...common}>
          <text x="8" y="12" textAnchor="middle" fontSize="11.5" fontWeight="600" fill="currentColor" stroke="none">
            1
          </text>
        </svg>
      )
    default:
      return null
  }
}

/**
 * 悬浮提示（用户 m02483）：比浏览器原生 title 快得多（120ms 就出来），
 * 内容固定是"控件名称"在上、"功能说明"在下；名称取 aria-label / data-name，说明取 title。
 * 顶栏和左右侧栏的按钮/滑条/输入框都走同一套。
 *
 * 为什么不给每个控件套一层组件：顶栏几十颗按钮、侧栏几十个控件，加包裹会改一堆 DOM 结构，
 * 而且 `.seg` 里 overflow:hidden 会把浮层裁掉。这里用事件委托 + 固定定位的顶层浮层，
 * 新加控件只要照旧写 aria-label / data-name / title 就自动有提示。
 */
function HoverTip() {
  const [tip, setTip] = useState<{ name: string; desc: string; x: number; y: number; above: boolean } | null>(null)
  useEffect(() => {
    let target: HTMLElement | null = null
    let timer = 0
    /* 原生 title 大约 1 秒后还会弹一个，跟这个重复：hover 时先摘掉，离开再挂回去 */
    let savedTitle: string | null = null

    const restoreTitle = () => {
      if (target && savedTitle !== null) {
        target.setAttribute('title', savedTitle)
        savedTitle = null
      }
      target = null
    }
    const hide = () => {
      window.clearTimeout(timer)
      restoreTitle()
      setTip(null)
    }
    const show = () => {
      if (!target) return
      const name = (target.getAttribute('aria-label') || target.getAttribute('data-name') || '').trim()
      const desc = (target.getAttribute('title') || target.dataset.tip || '').trim()
      if (savedTitle === null) {
        savedTitle = target.getAttribute('title')
        target.removeAttribute('title')
      }
      if (!name && !desc) return
      const r = target.getBoundingClientRect()
      const above = r.top > 96
      const x = Math.max(150, Math.min(window.innerWidth - 150, r.left + r.width / 2))
      setTip({ name, desc: desc === name ? '' : desc, x, y: above ? r.top - 8 : r.bottom + 8, above })
    }

    /* 顶栏按钮 + 左右侧栏的按钮 / 滑条 / 输入框 / 复选框；分组标题（小三角）不弹，免得挡视线 */
    const TIP_SEL = '.toolbar button, .side button:not(.group-head), .side .field, .side .check'
    const hit = (e: Event) => (e.target as HTMLElement | null)?.closest?.(TIP_SEL) as HTMLElement | null

    const onOver = (e: PointerEvent) => {
      const el = hit(e)
      if (!el || el === target) return
      hide()
      target = el
      timer = window.setTimeout(show, 120)
    }
    const onOut = (e: PointerEvent) => {
      if (!target) return
      /* 在控件内部从 svg 挪到 button 也会触发 pointerout，那种不算离开 */
      const to = (e.relatedTarget as HTMLElement | null)?.closest?.(
        '.toolbar button, .side button:not(.group-head), .side .field, .side .check',
      )
      if (!to || to !== target) hide()
    }
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('wheel', hide, true)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('wheel', hide, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
      hide()
    }
  }, [])

  if (!tip) return null
  return (
    <div className={tip.above ? 'tb-tip above' : 'tb-tip'} style={{ left: tip.x, top: tip.y }} role="tooltip">
      {tip.name && <strong className="tb-tip-name">{tip.name}</strong>}
      {tip.desc && <span className="tb-tip-desc">{tip.desc}</span>}
    </div>
  )
}
/** 帮助面板的内容（用户 m05893：顶栏键盘图标点开就能查按键 / 快捷键 / 鼠标操作） */
const HELP_SECTIONS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: '播放',
    rows: [
      ['空格', '播放 / 暂停；圈了播放区就在区间里循环'],
      ['Tab', '原音频 / 合成音 互换'],
      ['L', '重复区间开关'],
      ['Home', '回开头（没选播放区回曲子开头，选了回播放区开头）'],
      ['Ctrl + ← / →', '退 / 进一个小节'],
    ],
  },
  {
    title: '编辑',
    rows: [
      ['` 反引号', '绘制 / 选择 互换（默认选择）'],
      ['按住 Alt', '选择模式下临时当绘制用，松开恢复'],
      ['拖空白处', '画一个音（只在绘制模式；起点落在光标那一格，按住往右拖加长）'],
      ['拖音符中间', '上下改音高、左右改位置（两种模式都能拖）'],
      ['拖音符右缘', '改时值（光标会变左右箭头；两种模式都能拖）'],
      ['点已有音符', '确认 / 取消确认（只在绘制模式；只有确认过的音才会导出）'],
      ['↑ / ↓', '选中的音符升 / 降半音（Shift 一个八度）'],
      ['Delete / Backspace', '删掉选中的音符（只在绘制模式）；绘制模式下右键点音符也能删'],
      ['Ctrl + Z', '撤销（最多 200 步，一次拖动算一步）'],
      ['Ctrl + Shift + Z / Ctrl + Y', '重做'],
      ['Ctrl + A', '全选确认'],
      ['Ctrl + S', '真正存盘（写 <音频名>.bp.json）；平时的改动只写本机缓存'],
    ],
  },
  {
    title: '鼠标与视野',
    rows: [
      ['滚轮', '上下换音区（键列上的锁锁住后改成左右平移）'],
      ['Shift + 滚轮', '左右平移'],
      ['Ctrl + 滚轮', '横向缩放（以光标那一拍为锚点；Mac 上 Cmd 也行）'],
      ['拖时间尺', '框播放区间；点一下 = 取消区间并挪播放头'],
      ['拖区间两端握柄', '改区间起止'],
      ['右栏滑条上滚轮', '微调这条滑条（按住 Shift 五倍步长）'],
      ['Ctrl + ]', '收起 / 展开右侧栏'],
      ['点钢琴键', '试听该音高'],
    ],
  },
]
const KEY_CHOICES = Array.from({ length: 12 }, (_, i) => i)
const SNAP_CHOICES: Array<{ v: SnapMode; label: string }> = [
  { v: 'off', label: COPY.snapOff },
  { v: 'grid', label: COPY.snapGrid },
  { v: 'beat', label: COPY.snapBeat },
  { v: 'bar', label: COPY.snapBar },
]

const SEP_URL = {
  mirror: 'https://hf-mirror.com/StemSplitio/htdemucs-ft-vocals-onnx/resolve/main/htdemucs_ft_vocals.onnx',
  mirrorPage: 'https://hf-mirror.com/StemSplitio/htdemucs-ft-vocals-onnx',
  officialPage: 'https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx',
}

/** 右侧栏的一个分组：标题可点，收起/展开；组与组之间有分隔线（用户 m06889） */
function SideGroup({
  title,
  children,
  defaultOpen = true,
  open: openProp,
  onToggle,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  open?: boolean
  onToggle?: () => void
}) {
  const [selfOpen, setSelfOpen] = useState(defaultOpen)
  const open = openProp ?? selfOpen
  const toggle = onToggle ?? (() => setSelfOpen((v) => !v))
  return (
    <section className="sgroup">
      <button className="group-head" onClick={toggle} aria-expanded={open}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="group-title">{title}</span>
      </button>
      {open && <div className="group-body">{children}</div>}
    </section>
  )
}

export default function App() {
  const fileName = useBp((s) => s.fileName)
  const filePath = useBp((s) => s.filePath)
  const durationMs = useBp((s) => s.durationMs)
  const analysis = useBp((s) => s.analysis)
  const busy = useBp((s) => s.busy)
  const error = useBp((s) => s.error)
  const playing = useBp((s) => s.playing)
  const currentMs = useBp((s) => s.currentMs)
  const playMode = useBp((s) => s.playMode)
  const pitchMode = useBp((s) => s.pitchMode)
  const mode = useBp((s) => s.mode)
  const snap = useBp((s) => s.snap)
  const view = useBp((s) => s.view)
  const loop = useBp((s) => s.loop)
  const loopOn = useBp((s) => s.loopOn)
  const autoPage = useBp((s) => s.autoPage)
  const lockPitch = useBp((s) => s.lockPitch)
  const historyLen = useBp((s) => s.history.length)
  const futureLen = useBp((s) => s.future.length)
  const gain = useBp((s) => s.gain)
  const contrast = useBp((s) => s.contrast)
  const bandOnly = useBp((s) => s.bandOnly)
  const suppress = useBp((s) => s.suppress)
  const autoNotes = useBp((s) => s.autoNotes)
  const rhythm = useBp((s) => s.rhythm)
  const tonic = useBp((s) => s.tonic)
  const autoTonic = useBp((s) => s.autoTonic)
  const bpm = useBp((s) => s.bpm)
  const beatsPerBar = useBp((s) => s.beatsPerBar)
  const pickupBeats = useBp((s) => s.pickupBeats)
  const firstBeatMs = useBp((s) => s.firstBeatMs)
  const title = useBp((s) => s.title)
  const jps = useBp((s) => s.jps)
  const grid = useBp((s) => s.grid)
  const notes = useBp((s) => s.notes)
  /* 显示尺寸（用户 m02483）：行高、一屏秒数、表格顶行、和弦结果 */
  const rowH = useBp((s) => s.rowH)
  const topMidi = useBp((s) => s.topMidi)
  const pageSec = useBp((s) => s.pageSec)
  const chords = useBp((s) => s.chords)
  const showChords = useBp((s) => s.showChords)

  const set = useBp
  const [notice, setNotice] = useState<string | null>(null)
  /* 两种保存各记一个时间（用户 m02483）：缓存 = 随时保存那份，已存 = 真正写了 .bp.json */
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [cachedAt, setCachedAt] = useState<string | null>(null)
  /* 危险操作的二次确认（用户 m02483：清掉辛苦识别的谱不能一点就没） */
  const [confirmAsk, setConfirmAsk] = useState<{
    title: string
    body: string
    ok: string
    run: () => void
  } | null>(null)
  /* 上一次危险操作前的快照（状态栏给一个「恢复」入口） */
  const [recovery, setRecovery] = useState<{ label: string; at: string; count: number } | null>(null)
  /* 有修改未保存（用户 m02483）：橙点 / 绿点，保存按钮描橙边 */
  const [dirty, setDirty] = useState(false)
  /* 上次真正存盘时的内容指纹；null = 这首还没存过盘 */
  const savedSigRef = useRef<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  /* 右侧栏两种视图：扒谱用的「编辑」与前期一次性的「设置」（用户 m06889） */
  /* 右栏三种视图：编辑（当前谱）/ 分析（调性、节奏、分轨）/ 设置（一次性） */
  const [sideView, setSideView] = useState<'edit' | 'analysis' | 'settings'>('edit')
  /* 三页共用同一个 .side 容器：切页时把滚动位置拉回顶部，别停在上页的中间 */
  const sidePanelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    sidePanelRef.current?.scrollTo({ top: 0 })
  }, [sideView])
  /* 右侧栏宽度可拖（用户 m07044）；存 localStorage，下次进来还是这个宽度 */
  const [sideW, setSideW] = useState(() => {
    /* SSR（smoke 里 renderToString）没有 localStorage，先判一下 */
    if (typeof localStorage === 'undefined') return 300
    const v = Number(localStorage.getItem('bp.sideW') ?? '')
    return Number.isFinite(v) && v >= 240 && v <= 760 ? v : 300
  })
  /* 模型下载进度：0..1，null 表示没在下 */
  const [dl, setDl] = useState<number | null>(null)

  /* 帮助弹层：Esc 关掉（点外面关在 backdrop 的 onClick 里） */
  useEffect(() => {
    if (!helpOpen) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        setHelpOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [helpOpen])

  /* 行高 / 一屏秒数 / 表格顶行：这是"看谱的习惯"，跟具体某首歌无关，所以不写进方案，
   * 只落 localStorage（用户 m02483）。下次打开（哪怕没有方案）也照旧。 */
  useEffect(() => {
    try {
      localStorage.setItem('bp.rowH', String(rowH))
      localStorage.setItem('bp.pageSec', String(pageSec))
      localStorage.setItem('bp.topMidi', String(topMidi))
    } catch {
      /* 隐私模式禁用 localStorage：不影响用，只是记不住 */
    }
  }, [rowH, pageSec, topMidi])
  /* 右侧栏（调性/参数/显示/源码）能不能收起来——宽屏看谱时把它关掉能多出一大块 */
  const [showSide, setShowSide] = useState(true)
  /* 调性分析那一组能不能折起来（调号选择挪进组里了） */
  const [keyOpen, setKeyOpen] = useState(true)
  const workerRef = useRef<Worker | null>(null)
  /* 分析用过的样本留着：调'去谐波'要把同一段音频重跑一遍，不能重新选文件 */
  const samplesRef = useRef<{ samples: Float32Array; sampleRate: number } | null>(null)
  /* 分轨那两轨的 PCM 也留着：分析"当前这一轨"时直接拿它重跑，不再解码一遍（用户 m00810） */
  const stemPcmRef = useRef<{ vocals: Float32Array; instrumental: Float32Array; sampleRate: number } | null>(null)
  /* 混音那份频谱单独留底：分析人声/伴奏之后 analysis.spectrum 会变成那一轨，混音热力图不能跟着换 */
  const mixSpecRef = useRef<Spectrum | null>(null)
  /* 这一轮分析是"哪一轨、要不要全部当谱音"：worker 回来时按它处理 */
  const pendingAnalyzeRef = useRef<{ confirm: boolean; source: AnalyzeSource } | null>(null)
  /* 打开音频时读到的方案：等分析结果回来再盖上去（setAnalysis 会清空音符） */
  const pendingRestoreRef = useRef<ProjectFile | null>(null)
  /* 这份恢复是从哪来的：本机缓存还是 .bp.json（决定状态栏显示"缓存"还是"已存"） */
  const restoreKindRef = useRef<'cache' | 'file'>('file')
  /* 自动（缓存）保存的节流定时器（同一时间只挂一个，连续拖动最多每 1.2 秒写一次） */
  const saveTimerRef = useRef<number | null>(null)

  /* 所有滑条：鼠标悬浮在上面滚轮就能调，而且那一刻不滚动面板（用户 m05454、m02483）。
   * React 的 onWheel 是 passive 的，preventDefault 拦不住滚动，所以这里挂原生监听。
   * 挂在 document 上而不是右栏上：设置页、弹层里的滑条也要一样能滚（用户 m02483 追加要求）。
   * 命中区放宽到"整行 label.field"：光在 18px 高的轨道上滚太难对准，指着"行高 14px"这行滚也算。
   * 直接写 el.value 会被 React 的 value tracker 认为"没变"，得用原生 setter 再派发 input 事件。 */
  useEffect(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    const onWheel = (ev: WheelEvent) => {
      const target = ev.target as HTMLElement | null
      const el = (target?.closest?.('input[type="range"]') ??
        target?.closest?.('label.field')?.querySelector('input[type="range"]')) as HTMLInputElement | null
      if (!el || el.disabled) return
      ev.preventDefault() // 只调滑条，不滚面板
      const step = Number(el.step) || 1
      const min = Number(el.min)
      const max = Number(el.max)
      const dir = ev.deltaY > 0 ? -1 : 1
      const next = Math.min(max, Math.max(min, Number(el.value) + dir * step * (ev.shiftKey ? 5 : 1)))
      if (next === Number(el.value)) return
      if (setter) setter.call(el, String(next))
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    document.addEventListener('wheel', onWheel, { passive: false })
    return () => document.removeEventListener('wheel', onWheel)
  }, [])

  const confirmedCount = useMemo(() => notes.filter((n) => n.confirmed).length, [notes])
  const warnings = useBp((s) => s.warnings)
  /* 一屏实际显示几秒（随 Ctrl+滚轮缩放变化）：屏宽滑条绑的是这个值，拖动时换算回 zoom。
   * 上限 60 秒、下限 2 秒，跟 store 里的常量一致（用户 m02483 第 2 条）。 */
  const pageSpanSec = useMemo(() => {
    const s = spanMs(view, durationMs) / 1000
    return Math.round(Math.max(0.4, Math.min(3600, s)) * 10) / 10
  }, [view, durationMs])
  /* 屏宽滑条的值：有音频时跟着实际视野走；没音频时显示"设置里记的那个偏好值" */
  const pageSliderSec = useMemo(() => {
    if (!durationMs) return pageSec
    return Math.max(PAGE_SEC_MIN, Math.min(PAGE_SEC_MAX, Math.round(pageSpanSec)))
  }, [durationMs, pageSec, pageSpanSec])

  /* ---------- 分析 worker ---------- */
  useEffect(() => {
    const w = new Worker(new URL('./worker/analyze.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (
      e: MessageEvent<{
        ok: boolean
        kind?: 'analyze' | 'chords'
        result?: AnalyzeResult
        chords?: ChordSegment[]
        error?: string
      }>,
    ) => {
      const msg = e.data
      const st = set.getState()
      /* 和弦识别（用户 m02483 第 3 条）：跟音频分析共用这个线程，回来只更新和弦带 */
      if (msg.kind === 'chords') {
        if (msg.ok && msg.chords) {
          const named = msg.chords.filter((c) => c.name !== 'N').length
          st.setChords(msg.chords)
          st.setShowChords(true)
          setNotice(
            named > 0
              ? `和弦识别完成：${named} 段（画在表格底部；${COPY.chordOnlyHint}）`
              : '没识别出和弦（静音太多或太吵），试试换一轨或调「去谐波」',
          )
        } else {
          st.setError(msg.error ?? '和弦识别失败')
        }
        st.setBusy(null)
        return
      }
      if (msg.ok && msg.result) {
        const pending = pendingAnalyzeRef.current
        pendingAnalyzeRef.current = null
        /* 重新分析不该把播放头弹回开头：setAnalysis 会把它归零，先记下再放回去 */
        const backMs = st.currentMs
        st.setAnalysis(msg.result)
        /* 频谱归位：分析混音 → 混音留底；分析人声/伴奏 → 只换那一轨的热力图 */
        if (!pending || pending.source === 'mix') mixSpecRef.current = msg.result.spectrum
        else if (stemSpecRef.current) stemSpecRef.current[pending.source] = msg.result.spectrum
        /* 打开音频时读到了方案：分析结果一回来，就把参数、音符、视野盖回去（用户 m01794）。
         * 必须等 setAnalysis 之后，因为它会把 notes 换成机器初稿。 */
        const restore = pendingRestoreRef.current
        pendingRestoreRef.current = null
        if (restore) {
          st.applyProject(restore)
          st.setBusy(null)
          /* 从缓存恢复就显示"缓存"，从 .bp.json 恢复就显示"已存"（用户 m02483） */
          const fromCache = restoreKindRef.current === 'cache'
          if (fromCache) {
            savedSigRef.current = null
            setDirty(true) /* 缓存里的改动还没写进 .bp.json */
            setCachedAt(restore.savedAt || null)
          } else {
            savedSigRef.current = contentSig(set.getState())
            setDirty(false)
            setSavedAt(restore.savedAt || null)
          }
          setNotice(
            `已恢复${fromCache ? '本机缓存' : '方案'}：${restore.audio.name}${
              restore.savedAt ? `（上次存于 ${clockOfIso(restore.savedAt)}）` : ''
            }`,
          )
          return
        }
        const n = msg.result.notes.length
        if (pending?.confirm) {
          st.setAllConfirmed(true)
          st.setCurrentMs(backMs)
          setNotice(
            n > 0
              ? `分析完成（${SOURCE_LABEL[pending.source]}）：BPM ${msg.result.bpm}，${n} 个音已全部当谱音，jps 已生成 —— 接着人工听、改`
              : `分析完成（${SOURCE_LABEL[pending.source]}）：没找到音。试试调「去谐波」，或者换一轨再分析`,
          )
        } else {
          setNotice(
            `分析完成${pending ? `（${SOURCE_LABEL[pending.source]}）` : ''}：BPM ${msg.result.bpm}，${
              n > 0 ? `自动填入 ${n} 个音` : '没自动填音（在表格里点着画）'
            }`,
          )
        }
        st.setBusy(null)
      } else {
        pendingAnalyzeRef.current = null
        st.setError(msg.error ?? '分析失败')
        st.setBusy(null)
      }
    }
    w.onerror = () => {
      set.getState().setError('分析线程出错')
      set.getState().setBusy(null)
    }
    workerRef.current = w
    return () => {
      w.terminate()
      workerRef.current = null
    }
  }, [set])

  /* ---------- 打开音频 ---------- */
  /** 读音频旁边的方案（`.bp.json`）。第一次打开没有这个文件，属正常情况，返回 null。 */
  const readProjectFile = useCallback(async (projectPath: string): Promise<ProjectFile | null> => {
    try {
      let text: string | null = null
      if (isTauriShell()) text = await invoke<string>('bp_read_text', { path: projectPath })
      else if (typeof localStorage !== 'undefined') text = localStorage.getItem(`${PROJECT_LS_PREFIX}${projectPath}`)
      if (!text) return null
      const r = parseProject(text)
      if ('error' in r) {
        setNotice(`方案读不了：${r.error}（这次按新开处理）`)
        return null
      }
      return r.project
    } catch {
      /* 文件不存在 / 读不了：第一次打开的常态，不打扰用户 */
      return null
    }
  }, [])

  /** 本机缓存（随时保存那份）：读写都在这里，跟 `.bp.json` 完全分开（用户 m02483） */
  const writeCache = useCallback((p: ProjectFile) => {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(CACHE_KEY, serializeProject(p))
    } catch {
      /* 配额满 / 隐私模式：缓存写不进去不影响编辑 */
    }
  }, [])

  const readCache = useCallback((): ProjectFile | null => {
    if (typeof localStorage === 'undefined') return null
    try {
      const text = localStorage.getItem(CACHE_KEY)
      if (!text) return null
      const r = parseProject(text)
      if ('error' in r) {
        localStorage.removeItem(CACHE_KEY)
        return null
      }
      return r.project
    } catch {
      return null
    }
  }, [])

  /** 打开这段音频时该恢复什么：同一首的缓存优先（含没存盘的改动），否则读旁边的 `.bp.json` */
  const readRestoreFor = useCallback(
    async (audioPath: string): Promise<ProjectFile | null> => {
      const cache = readCache()
      if (cache && cache.audio.path === audioPath) {
        restoreKindRef.current = 'cache'
        return cache
      }
      restoreKindRef.current = 'file'
      return readProjectFile(projectPathFor(audioPath))
    },
    [readCache, readProjectFile],
  )

  /** 装载 + 起分析：选文件、"启动参数带文件"、恢复方案都走这一条，避免两套逻辑。
   *  restoreArg 不传 = 自动找该音频的缓存 / 旁边的方案；传 null = 明确不恢复。 */
  const applyLoaded = useCallback(
    async (loaded: LoadedAudio, restoreArg?: ProjectFile | null) => {
      const st = set.getState()
      const restore =
        restoreArg === undefined
          ? loaded.path
            ? await readRestoreFor(loaded.path)
            : null
          : restoreArg
      pendingRestoreRef.current = restore ?? null
      stop()
      st.setPlaying(false)
      /* 换歌：上一首的"已存/缓存"时间先清掉，等恢复完再按来源补上 */
      setSavedAt(null)
      setCachedAt(null)
      /* 换歌/重新装载：指纹作废（恢复成功时由 worker 回来的分支重新对齐） */
      savedSigRef.current = null
      setDirty(false)
      st.setLoaded({ fileName: loaded.name, filePath: loaded.path, durationMs: loaded.durationMs })
      setAudioBuffer(loaded.buffer)
      st.setBusy(COPY.analyzing)
      const w = workerRef.current
      if (!w) throw new Error('分析线程没起来')
      /* 存一份副本：worker 拿走的是 transfer 过去的 buffer，主线程这边就没数据了 */
      samplesRef.current = {
        samples: new Float32Array(loaded.samples),
        sampleRate: loaded.sampleRate,
      }
      /* 打开文件这一轮永远分析混音：清掉上一轮的"分析哪一轨"标记 */
      pendingAnalyzeRef.current = null
      w.postMessage(
        {
          samples: loaded.samples,
          sampleRate: loaded.sampleRate,
          suppress: st.suppress,
          beatsPerBar: st.beatsPerBar,
          notes: st.autoNotes,
        },
        [loaded.samples.buffer as ArrayBuffer],
      )
    },
    [readRestoreFor, set],
  )

  const openAudio = useCallback(async () => {
    const st = set.getState()
    st.setError(null)
    setNotice(null)
    st.setBusy('正在读文件…')
    try {
      const loaded = await pickAndLoadAudio()
      if (!loaded) {
        st.setBusy(null)
        return
      }
      await applyLoaded(loaded)
    } catch (e) {
      st.setError(e instanceof Error ? e.message : String(e))
      st.setBusy(null)
    }
  }, [applyLoaded, set])

  /* ---------- 方案：两种保存（用户 m02483） ----------
   *  · 缓存保存：改动 1.2 秒后写到本机缓存（localStorage 的 `bp.cache`），**不碰 .bp.json**；
   *    下次打开先恢复它，没存盘的工作不会丢。
   *  · 真正保存：Ctrl+S 或顶栏「保存方案」，才写音频旁边的 `.bp.json`（浏览器里存 localStorage）。
   *  读缓存的 readCache / readRestoreFor 在 applyLoaded 之前（启动恢复要用）。 */

  /** 真正保存：写音频旁边的 `.bp.json`，同时把缓存刷成同一份（下次打开不会取到旧缓存）。
   *  返回路径（浏览器里返回伪路径）。 */
  const saveProject = useCallback(async (): Promise<string | null> => {
    const st = set.getState()
    const p = buildProject(st)
    if (!p) return null
    const path = projectPathFor(p.audio.path)
    const text = serializeProject(p)
    if (isTauriShell()) {
      await invoke('bp_write_text', { path, text })
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`${PROJECT_LS_PREFIX}${path}`, text)
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('bp.lastProject', path)
      localStorage.setItem(CACHE_KEY, text)
    }
    /* 真正存过盘了：指纹对齐、状态栏变绿 */
    savedSigRef.current = contentSig(set.getState())
    setDirty(false)
    setSavedAt(p.savedAt)
    return path
  }, [set])

  /** 自动（缓存）保存：连续改动时最多每 1.2 秒写一次缓存；只更新状态栏的"缓存"时间。
   *  分析中/正在恢复方案时不写：此时 notes 还是空的（或机器初稿），一写就把好缓存盖掉。 */
  const scheduleSave = useCallback(() => {
    const st = set.getState()
    if (!st.filePath) return
    if (st.busy || pendingRestoreRef.current) return
    if (saveTimerRef.current !== null) return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      const cur = set.getState()
      if (cur.busy || pendingRestoreRef.current) return
      const p = buildProject(cur)
      if (!p) return
      writeCache(p)
      setCachedAt(p.savedAt)
    }, 1200)
  }, [set, writeCache])

  /** 打开一个已有方案 / 本机缓存：按里面记的音频路径重新装载，再恢复状态 */
  const restoreProject = useCallback(
    async (p: ProjectFile, kind: 'cache' | 'file' = 'file') => {
      const st = set.getState()
      restoreKindRef.current = kind
      st.setError(null)
      setNotice(null)
      st.setBusy(kind === 'cache' ? '正在恢复本机缓存…' : '正在打开方案…')
      try {
        const loaded = await loadAudioFromPath(p.audio.path)
        if (!loaded) throw new Error(`方案里的音频不在了：${p.audio.path}`)
        await applyLoaded(loaded, p)
      } catch (e) {
        st.setError(e instanceof Error ? e.message : String(e))
        st.setBusy(null)
      }
    },
    [applyLoaded, set],
  )

  /* ---------- 危险操作的恢复快照（用户 m02483：辛苦识别的谱不能一点就没） ----------
   * 清空确认 / 回到初稿 / 重新分析之前，先把当前整份方案存到 `bp.recovery`；
   * 状态栏会出现「恢复」入口，点它先确认再铺回去。Ctrl+Z 也仍然有效（store 里另存了撤销步）。 */
  const readRecovery = useCallback((): { label: string; project: ProjectFile } | null => {
    if (typeof localStorage === 'undefined') return null
    try {
      const text = localStorage.getItem(RECOVERY_KEY)
      if (!text) return null
      const o = JSON.parse(text) as { label?: unknown; project?: unknown }
      const r = parseProject(JSON.stringify(o.project))
      if ('error' in r) return null
      return { label: typeof o.label === 'string' && o.label ? o.label : '上次操作', project: r.project }
    } catch {
      return null
    }
  }, [])

  const rememberForRecovery = useCallback(
    (label: string) => {
      const p = buildProject(set.getState())
      if (!p) return
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(RECOVERY_KEY, JSON.stringify({ label, at: p.savedAt, project: p }))
        } catch {
          /* 配额满：至少还有 Ctrl+Z */
        }
      }
      setRecovery({ label, at: p.savedAt, count: p.notes.length })
    },
    [set],
  )

  const applyRecovery = useCallback(() => {
    const slot = readRecovery()
    const st = set.getState()
    if (!slot) {
      st.setError('没有可恢复的快照')
      return
    }
    if (typeof localStorage !== 'undefined') localStorage.removeItem(RECOVERY_KEY)
    setRecovery(null)
    if (st.filePath && slot.project.audio.path === st.filePath) {
      /* 同一首：直接铺回音符/参数，不用重新分析 */
      st.applyProject(slot.project)
      setNotice(`已恢复：${slot.label}`)
    } else {
      /* 换过歌了：按快照里的音频路径重新打开再恢复 */
      void restoreProject(slot.project, 'cache')
    }
  }, [readRecovery, restoreProject, set])

  /* 重启后也把上一次的快照挂在状态栏（点的时候还会再确认一次） */
  useEffect(() => {
    const slot = readRecovery()
    if (slot) setRecovery({ label: slot.label, at: slot.project.savedAt, count: slot.project.notes.length })
  }, [readRecovery])

  /* 确认弹层：Esc 关掉 */
  useEffect(() => {
    if (!confirmAsk) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        setConfirmAsk(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirmAsk])

  const openProject = useCallback(async () => {
    if (!isTauriShell()) return
    try {
      const path = await invoke<string | null>('bp_pick_project')
      if (!path) return
      const text = (await invoke<string>('bp_read_text', { path })) ?? ''
      if (!text) {
        set.getState().setError(`方案是空的：${path}`)
        return
      }
      const r = parseProject(text)
      if ('error' in r) {
        set.getState().setError(`方案读不了：${r.error}`)
        return
      }
      await restoreProject(r.project)
    } catch (e) {
      set.getState().setError(e instanceof Error ? e.message : String(e))
      set.getState().setBusy(null)
    }
  }, [restoreProject, set])

  /* ---------- 启动：带音频参数就开那个；否则接着上次的方案干 ---------- */
  const bootedRef = useRef(false)
  useEffect(() => {
    if (!isTauriShell()) return
    /* StrictMode 下 effect 会跑两趟（第二趟紧跟着第一趟的 cleanup）。
     * 这里只认第一趟：不要按 cleanup 的 cancelled 把第一趟掐掉，否则两趟都不干活。 */
    if (bootedRef.current) return
    bootedRef.current = true
    void (async () => {
      try {
        const arg = (await invoke<string | null>('bp_initial_audio')) ?? null
        if (arg) {
          const loaded = await loadAudioFromPath(arg)
          if (!loaded) return
          set.getState().setError(null)
          await applyLoaded(loaded)
          return
        }
        /* 没有启动参数：先接着本机缓存（随时保存那份，可能没存过盘），没有再退回上次的方案文件 */
        const cache = readCache()
        if (cache) {
          await restoreProject(cache, 'cache')
          return
        }
        /* 没有缓存：读"上次存过的那条方案"的路径（真正保存时记在 localStorage） */
        const last = typeof localStorage !== 'undefined' ? localStorage.getItem('bp.lastProject') : null
        if (!last) return
        let text = ''
        try {
          text = (await invoke<string>('bp_read_text', { path: last })) ?? ''
        } catch {
          /* 文件被删了：清了标记，当作新开 */
          localStorage.removeItem('bp.lastProject')
          return
        }
        const r = parseProject(text)
        if ('error' in r) {
          set.getState().setError(`上次的方案读不了：${r.error}`)
          return
        }
        await restoreProject(r.project)
      } catch (e) {
        set.getState().setError(e instanceof Error ? e.message : String(e))
        set.getState().setBusy(null)
      }
    })()
  }, [applyLoaded, restoreProject, set])

  /* ---------- 自动（缓存）保存：参数、音符、视野一变，1.2 秒内写成本机缓存 ----------
   * **不写 .bp.json**（用户 m02483）：要存成文件得按 Ctrl+S 或点「保存方案」。
   * currentMs 故意不列进依赖：播放时它每帧都在变，不然会一直在写；
   * 暂停时（下面那个 effect）再补存一次，把播放头位置记下来。 */
  useEffect(() => {
    /* 顺手更新"有没有未保存的修改"（用户 m02483）：跟上次真正存盘的指纹比 */
    if (filePath) {
      if (!busy && !pendingRestoreRef.current) {
        const sig = contentSig(set.getState())
        if (savedSigRef.current === null) {
          savedSigRef.current = sig
          setDirty(true) /* 这首还没真正存过盘 */
        } else {
          setDirty(sig !== savedSigRef.current)
        }
      }
    } else {
      setDirty(false)
    }
    scheduleSave()
  }, [
    notes,
    bpm,
    beatsPerBar,
    pickupBeats,
    firstBeatMs,
    tonic,
    autoTonic,
    title,
    gain,
    contrast,
    bandOnly,
    suppress,
    autoNotes,
    pitchMode,
    mode,
    snap,
    loop,
    loopOn,
    autoPage,
    lockPitch,
    playMode,
    view,
    busy,
    filePath,
    scheduleSave,
    set,
  ])

  useEffect(() => {
    if (!playing) scheduleSave()
  }, [playing, scheduleSave])

  /* ---------- 分轨（桌面专属）：人声 / 伴奏 ----------
   * 前端解码 → PCM 交给 Rust 跑 ONNX → 两轨 wav 落盘再读回来 → 各算一份频谱。
   * 切「人声/伴奏」只换热力图用的那份频谱，不动音符，也不重算分析。 */
  const stemSpecRef = useRef<{ vocals?: Spectrum; instrumental?: Spectrum } | null>(null)
  const [stemsReady, setStemsReady] = useState(false)
  const [sepOk, setSepOk] = useState<SepReady | null>(null)
  const [sepTarget, setSepTarget] = useState<string | null>(null)
  const [stemMode, setStemMode] = useState<'mix' | 'vocals' | 'instrumental'>('mix')
  /* 换歌：上一首的分轨结果作废（player 里的两轨已由 setAudioBuffer 清掉，这里清界面） */
  useEffect(() => {
    stemSpecRef.current = null
    stemPcmRef.current = null
    mixSpecRef.current = null
    pendingAnalyzeRef.current = null
    setStemsReady(false)
    setStemMode('mix')
  }, [fileName])

  /* ---------- 分析：对"当前选中的那一轨"重跑 ----------
   * 为什么不是"打开时自动分析一遍就完了"（用户 m00741）：勾了「分析后自动填入音符」之后，
   * 用户希望点一下顶栏就出初稿；而且分轨之后要能只分析人声 / 只分析伴奏。
   * 所以入口收成这一个函数：按 stemMode 取 PCM（分轨了就取那一轨，否则取混音），
   * 强制 notes:true 重跑 worker，回来后铺到表上；要不要"全部当谱音"由调用方定。 */
  const analyzeSource = useCallback(
    (opts: { confirm: boolean; notes: boolean; suppress: number }) => {
      const st = set.getState()
      const w = workerRef.current
      if (!w) return
      const stemPcm = stemPcmRef.current
      const source: AnalyzeSource = stemMode !== 'mix' && stemPcm ? stemMode : 'mix'
      const pcm =
        source === 'mix'
          ? samplesRef.current
            ? { samples: samplesRef.current.samples, sampleRate: samplesRef.current.sampleRate }
            : null
          : {
              samples: source === 'vocals' ? stemPcm!.vocals : stemPcm!.instrumental,
              sampleRate: stemPcm!.sampleRate,
            }
      if (!pcm) {
        st.setError('先打开一段音频')
        return
      }
      st.setError(null)
      /* 重新分析会整张换掉音符表：先记一步撤销，别让手工改动一点就没（用户 m02483） */
      st.snapshotNotes()
      st.setBusy(COPY.analyzing)
      pendingAnalyzeRef.current = { confirm: opts.confirm, source }
      /* 复制一份再 transfer：ref 里那份要留着给下一次分析 / 去谐波用 */
      const copy = new Float32Array(pcm.samples)
      w.postMessage(
        {
          samples: copy,
          sampleRate: pcm.sampleRate,
          suppress: opts.suppress,
          beatsPerBar: st.beatsPerBar,
          notes: opts.notes,
        },
        [copy.buffer as ArrayBuffer],
      )
    },
    [set, stemMode],
  )

  /** 顶栏「分析」：当前这一轨重跑一遍，音符铺到表上并全部当谱音 → jps 立刻出来 */
  const runAnalyze = useCallback(() => {
    const st = set.getState()
    analyzeSource({ confirm: true, notes: true, suppress: st.suppress })
  }, [analyzeSource, set])

  /* ---------- 会"清谱"的三颗按钮：先问一句，并留一份恢复快照（用户 m02483） ---------- */

  /** 「全不选」：有确认过的音才值得问 */
  const doClearAll = useCallback(() => {
    const st = set.getState()
    const n = st.notes.filter((x) => x.confirmed).length
    if (n === 0) {
      st.setAllConfirmed(false)
      return
    }
    setConfirmAsk({
      title: COPY.clearAllTitle,
      body: `确认过的 ${n} 个音会从导出和简谱预览里消失（音还在表上，只是变灰）。\n可以用状态栏的「恢复」或 Ctrl+Z 找回来。`,
      ok: COPY.clearAllOk,
      run: () => {
        rememberForRecovery('取消全部确认')
        set.getState().setAllConfirmed(false)
      },
    })
  }, [rememberForRecovery, set])

  /** 「回到初稿」：手画的音和确认全会被分析初稿替换 */
  const doResetDraft = useCallback(() => {
    const st = set.getState()
    if (st.notes.length === 0) return
    const conf = st.notes.filter((x) => x.confirmed).length
    setConfirmAsk({
      title: COPY.resetDraftTitle,
      body: `当前 ${st.notes.length} 个音（确认 ${conf} 个）会被分析初稿替换。\n可以用状态栏的「恢复」或 Ctrl+Z 找回来。`,
      ok: COPY.resetDraftOk,
      run: () => {
        rememberForRecovery('回到初稿')
        set.getState().resetNotes()
        setSelectedId(null)
      },
    })
  }, [rememberForRecovery, set])

  /** 「分析」：重新判音会把整张音符表换成机器初稿 */
  const doAnalyze = useCallback(() => {
    const st = set.getState()
    if (st.notes.length === 0) {
      runAnalyze()
      return
    }
    const conf = st.notes.filter((x) => x.confirmed).length
    setConfirmAsk({
      title: COPY.analyzeOverwriteTitle,
      body: `重新判音会把整张音符表换成机器初稿（现在 ${st.notes.length} 个音、确认 ${conf} 个）。\n可以用状态栏的「恢复」或 Ctrl+Z 找回来。`,
      ok: COPY.analyzeOverwriteOk,
      run: () => {
        rememberForRecovery('重新分析之前')
        runAnalyze()
      },
    })
  }, [rememberForRecovery, runAnalyze, set])

  /** 顶栏「和弦」：对当前看的那一轨识别和弦（Note Digger 的 chordEst 复刻）。
   * 频谱已经在内存里，直接拷给 worker；不重算频谱、不改音符、不进 jps。 */
  const runChordAnalysis = useCallback(() => {
    const st = set.getState()
    const w = workerRef.current
    const spec =
      stemMode === 'mix'
        ? (mixSpecRef.current ?? st.analysis?.spectrum ?? null)
        : (stemSpecRef.current?.[stemMode] ?? st.analysis?.spectrum ?? null)
    if (!spec) {
      st.setError('先「分析」一遍，有频谱才能识别和弦')
      return
    }
    if (!w) {
      st.setError('分析线程没起来')
      return
    }
    st.setError(null)
    st.setBusy('正在识别和弦…')
    /* 不 transfer：主线程还要用这份频谱画热力图，worker 拿拷贝就够了 */
    w.postMessage({ kind: 'chords', spectrum: spec })
  }, [set, stemMode])

  /* ---------- 去谐波：把当前这一轨带着新的强度重跑一遍 ---------- */
  const applySuppress = useCallback(
    (v: number) => {
      const st = set.getState()
      st.setSuppress(v)
      analyzeSource({ confirm: false, notes: st.autoNotes, suppress: v })
    },
    [analyzeSource, set],
  )
  /* 桌面壳里进界面时先问一句：模型和 onnxruntime.dll 都在不在。
   * 缺东西就显示"装模型包 / 去下载"，而不是等用户点了才报错。 */
  useEffect(() => {
    if (!canSeparate()) return
    let alive = true
    void sepReady().then((r) => {
      if (alive) setSepOk(r)
    })
    void sepModelTarget().then((p) => {
      if (alive) setSepTarget(p)
    })
    return () => {
      alive = false
    }
  }, [])
  const handleSeparate = useCallback(async () => {
    const src = samplesRef.current
    const st = set.getState()
    if (!src) {
      st.setError('先打开一段音频')
      return
    }
    if (!canSeparate()) {
      st.setError('分离只在桌面版里有')
      return
    }
    st.setError(null)
    st.setBusy('正在分离人声…')
    setNotice('分离中：模型第一次加载要几秒，之后每 7.8 秒一段')
    try {
      const model = await sepModelPath()
      if (!model) {
        const target = await sepModelTarget()
        st.setBusy(null)
        st.setError(`还没装分离模型。把 htdemucs_ft_vocals.onnx 放到：${target ?? '应用数据目录/models/'}`)
        return
      }
      // 单声道复制成左右两路：模型要立体声，器乐/人声都在中间，够用
      const mono = src.samples
      const inter = new Float32Array(mono.length * 2)
      for (let i = 0; i < mono.length; i++) {
        inter[i * 2] = mono[i]
        inter[i * 2 + 1] = mono[i]
      }
      const r = await separateStems(inter, src.sampleRate)
      if (!r) {
        st.setBusy(null)
        st.setError('分离没返回结果')
        return
      }
      /* 两轨 PCM 留一份：之后「分析」/「去谐波」可以只针对当前这一轨重跑（用户 m00810） */
      stemPcmRef.current = { vocals: r.vocals, instrumental: r.instrumental, sampleRate: r.sampleRate }
      stemSpecRef.current = {
        vocals: computeSpectrum(r.vocals, r.sampleRate, {}),
        instrumental: computeSpectrum(r.instrumental, r.sampleRate, {}),
      }
      /* 两轨 PCM 也存给播放层：之后点哪轨，热力图和声音一起切（用户 m00413） */
      setStemBuffers({
        vocals: makeAudioBuffer(r.vocals, r.sampleRate),
        instrumental: makeAudioBuffer(r.instrumental, r.sampleRate),
      })
      setStemsReady(true)
      setStemMode('vocals')
      st.setBusy(null)
      setNotice(`分离完成（推理 ${r.seconds.toFixed(1)}s）：现在看/听的是人声音轨，可切「伴奏」或「混音」`)
    } catch (e) {
      st.setBusy(null)
      st.setError(e instanceof Error ? e.message : String(e))
    }
  }, [set])

  /* 应用内下载模型（用户 m06888）：302 MB，走 hf-mirror，带进度。
   * 下完自动重新检测一次，用户不用手动点「重新检测」。 */
  const downloadSepModel = useCallback(async () => {
    const st = set.getState()
    if (!canSeparate()) return
    st.setError(null)
    setDl(0)
    setNotice('开始下载分离模型（约 300 MB，镜像 hf-mirror）…')
    const off = onDownloadProgress((done, total) => {
      if (total > 0) setDl(Math.min(1, done / total))
    })
    try {
      const path = await downloadModel(SEP_URL.mirror)
      if (!path) {
        st.setError('下载没返回路径')
        return
      }
      const r = await sepReady()
      setSepOk(r)
      setNotice(`模型已下载到 ${path}`)
    } catch (e) {
      st.setError(e instanceof Error ? e.message : String(e))
    } finally {
      off()
      setDl(null)
    }
  }, [set])

  /* ---------- 播放 ----------
   * 注意"先置 playing 再 await"：`play()` 里有 await（AudioContext.resume / 合成器 ready）。
   * 如果等 await 完才 setPlaying(true)，用户在这几十毫秒里连按两次空格，第二次看到的
   * 还是 playing=false，会再启动一路播放 —— 两路 tick 同时存在，stop() 又只管得到最新的
   * raf 变量，表现就是"播了就停不下来 / 越按越乱"。 */
  const startPlay = useCallback(async (fromMs: number, m: PlayMode) => {
    const st = set.getState()
    if (!st.analysis) return
    set.getState().setPlaying(true)
    const ok = await play(fromMs, m, st.notes, st.durationMs, {
      onTick: (ms) => set.getState().setCurrentMs(ms),
      onEnd: () => set.getState().setPlaying(false),
    })
    /* play() 返回 false = 这一路在 await 期间被 stop()/另一次 play() 顶掉了，别再动状态 */
    if (!ok) return
  }, [set])

  /* 分轨切换：热力图（NoteRoll 的 spectrum）和播放音源用同一个 stemMode。
   * 正在播就停下来、按当前位置在新轨续上，否则会出现"看人声、听混音"。
   * 合成音模式不受影响（它放的是音符，不是音频）。 */
  useEffect(() => {
    setPlayTrack(stemMode)
    const st = set.getState()
    if (!st.playing || st.playMode !== 'audio') return
    stop()
    void startPlay(st.currentMs, st.playMode)
  }, [stemMode, set, startPlay])

  const togglePlay = useCallback(() => {
    const st = set.getState()
    if (st.playing) {
      stop()
      st.setPlaying(false)
      return
    }
    if (!st.analysis) return
    /* 圈了播放区间就从区间开头放（用户：画完区间按播放，应该在区间里循环听，而不是从头放） */
    let from = st.currentMs >= st.durationMs ? 0 : st.currentMs
    if (st.loopOn && st.loop) {
      const inside = from >= st.loop.startMs - 5 && from < st.loop.endMs - 5
      if (!inside) from = st.loop.startMs
    }
    void startPlay(from, st.playMode)
  }, [set, startPlay])

  const switchMode = useCallback(
    (m: PlayMode) => {
      const st = set.getState()
      st.setPlayMode(m)
      if (st.playing) {
        stop()
        void startPlay(st.currentMs, m)
      }
    },
    [set, startPlay],
  )

  const seek = useCallback(
    (ms: number) => {
      const st = set.getState()
      st.setCurrentMs(ms)
      if (st.playing) {
        stop()
        void startPlay(ms, st.playMode)
      }
    },
    [set, startPlay],
  )

  /* 回开头：没选播放区就回曲子开头，选了播放区就回播放区开头（用户 m05893） */
  const goStart = useCallback(() => {
    const st = set.getState()
    seek(st.loopOn && st.loop ? st.loop.startMs : 0)
  }, [seek, set])

  /* Ctrl+左右：按小节跳（用户 m05893）；弱起时第 1 小节只有 pickupBeats 拍，要按真实边界算 */
  const jumpBar = useCallback(
    (dir: -1 | 1) => {
      const st = set.getState()
      const barOpt = { beatsPerBar: st.beatsPerBar, pickupBeats: st.pickupBeats }
      const tickMs = 60000 / Math.max(1, st.bpm) / 4
      const tick = Math.max(0, (st.currentMs - st.firstBeatMs) / tickMs)
      const bar = Math.max(0, barIndexOf(tick, barOpt) + dir)
      const target = Math.max(
        0,
        Math.min(st.durationMs, st.firstBeatMs + barStartTick(bar, barOpt) * tickMs),
      )
      seek(target)
    },
    [seek, set],
  )


  /* ---------- 重复区间：播放到区间末尾就跳回区间开头 ---------- */
  useEffect(() => {
    if (!playing || !loopOn || !loop) return
    if (currentMs < loop.endMs - 12) return
    stop()
    set.getState().setCurrentMs(loop.startMs)
    void startPlay(loop.startMs, playMode)
  }, [currentMs, playing, loopOn, loop, playMode, set, startPlay])

  /* ---------- 自动翻页：播放头碰到右边缘才翻一页 ----------
   * 用户 2026-11-18 的口径：时点线走到视界边上就翻页（不是提前 82% 就推）。
   * 整首都在视野里时（zoom=1）根本没得推，所以开关一打开就先切到"一屏那么多秒"（默认 20）。
   * 翻页后把播放头放在左边 6% 的位置，前面留出一点"刚过去"的上下文。
   *
   * 注意（adj 级教训）：这个 effect 的依赖里有 view，而它自己又会 setView ——
   * 只要有一次 setView 传进去的值和当前值一样，状态对象仍是新引用、effect 会重跑，
   * 就变成死循环（React 会报 "Maximum update depth exceeded" 并整页白屏）。
   * 所以每次 setView 之前先比一遍数，没变化就直接 return；整首比一屏还短时干脆不动。 */
  useEffect(() => {
    if (!playing || !autoPage || !durationMs) return
    /* 一屏多少秒是设置里的滑条（用户 m02483）；整首比它还短就翻页没有意义，
     * 也不许在这里 setView（会自激） */
    const pageMs0 = Math.min(durationMs, Math.max(1000, pageSec * 1000))
    if (durationMs <= pageMs0) return
    const span = spanMs(view, durationMs)
    if (span >= durationMs - 1) {
      const pageMs = pageMs0
      const zoom = durationMs / Math.max(1, pageMs)
      const panMs = Math.max(0, Math.min(durationMs - pageMs, currentMs - pageMs * 0.2))
      if (Math.abs(view.zoom - zoom) < 1e-6 && Math.abs(view.panMs - panMs) < 1) return
      set.getState().setView({ zoom, panMs })
      return
    }
    /* 右边缘再留 1 像素的余量：线一贴边就翻，别等它真的画出去 */
    const rightEdge = view.panMs + span - 1
    if (currentMs >= rightEdge || currentMs < view.panMs) {
      const panMs = Math.max(0, currentMs - span * 0.06)
      if (Math.abs(panMs - view.panMs) < 1) return
      set.getState().setView({ zoom: view.zoom, panMs })
    }
  }, [currentMs, playing, autoPage, durationMs, pageSec, view, set])

  /** 删音符：顺手把选中态清掉（否则 Delete 会去删一个已经不存在的 id） */
  const removeNote = useCallback((id: string) => {
    useBp.getState().removeNote(id)
    setSelectedId((cur) => (cur === id ? null : cur))
  }, [])

  /* ---------- 热键 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      /* 只有"要打字"的控件才吞掉热键；滑条/复选框/按钮上的空格照样能启停播放 */
      const typing =
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes((el as HTMLInputElement).type))
      if (typing) return
      const st = set.getState()
      if (e.code === 'Space') {
        /* 关键：按钮/滑条上有焦点时，空格还会触发它们自己的激活（按钮 = 再来一次 click），
         * 结果一次空格切换两遍 —— 用户看到的"空格好像跳跃播放"就是这么来的。
         * 用捕获阶段 + stopPropagation 把事件截在窗口这一层，控件收不到。 */
        e.preventDefault()
        e.stopPropagation()
        togglePlay()
      } else if (e.code === 'Tab') {
        e.preventDefault()
        switchMode(st.playMode === 'audio' ? 'synth' : 'audio')
      } else if (e.code === 'Backquote') {
        /* 反引号：绘制 / 选择 互换（跟 noteDigger 的铅笔/箭头一个意思） */
        e.preventDefault()
        st.setMode(st.mode === 'draw' ? 'select' : 'draw')
      } else if (e.code === 'KeyL') {
        st.setLoopOn(!st.loopOn)
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        /* 删音只在绘制模式（用户 m02483）；选择模式只挪不改数量 */
        if (selectedId && st.mode === 'draw') {
          e.preventDefault()
          removeNote(selectedId)
        }
      } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        /* Ctrl+Shift+Z 跟 Ctrl+Y 一样是重做 */
        e.preventDefault()
        st.redo()
      } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        st.undo()
      } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        st.redo()
      } else if (e.code === 'Home') {
        e.preventDefault()
        goStart()
      } else if (e.code === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        jumpBar(-1)
      } else if (e.code === 'ArrowRight' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        jumpBar(1)
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        /* 选中音符上下改音高（Shift 一个八度，用户 m05736 第 1 条） */
        if (!selectedId) return
        const cur = st.notes.find((n) => n.id === selectedId)
        if (!cur) return
        e.preventDefault()
        const step = e.shiftKey ? 12 : 1
        st.patchNote(selectedId, { midi: cur.midi + (e.code === 'ArrowUp' ? step : -step) })
      } else if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        st.setAllConfirmed(true)
      } else if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        /* Ctrl+S = 真正保存（写 .bp.json）；平时那 1.2 秒一次只是本机缓存（用户 m02483） */
        e.preventDefault()
        if (!st.filePath) {
          setNotice('还没有打开音频，没地方存方案')
          return
        }
        void saveProject()
          .then((p) => setNotice(p ? `${COPY.projectSavedTip}：${p}` : null))
          .catch((err: unknown) => {
            st.setError(`方案存不下来：${err instanceof Error ? err.message : String(err)}`)
          })
      } else if (e.code === 'BracketRight' && (e.ctrlKey || e.metaKey)) {
        /* Ctrl+] = 收起 / 展开右侧栏（用户 m02483） */
        e.preventDefault()
        setShowSide((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey, true) // 捕获阶段：先于控件自己的默认行为
    return () => window.removeEventListener('keydown', onKey, true)
  }, [goStart, jumpBar, removeNote, saveProject, selectedId, set, switchMode, togglePlay])

  /* ---------- 导出 ---------- */
  const exportJps = useCallback(async () => {
    const st = set.getState()
    const name = `${st.title || '爱扒谱导出'}.jps`
    if (isTauriShell()) {
      const saved = await invoke<string | null>('bp_save_jps', { suggested: name, text: st.jps })
      setNotice(saved ? `已保存：${saved}` : null)
      return
    }
    const blob = new Blob([st.jps], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
    setNotice(`已下载：${name}`)
  }, [set])

  const candidates = analysis?.keyCandidates.slice(0, 6) ?? []
  const setLoop = useCallback(
    (r: LoopRange | null) => {
      const s = set.getState()
      s.setLoop(r)
      /* 划出区间就自动开循环；取消区间（时间尺上点一下）顺手把循环关掉，
       * 否则一个空区间会一直挡着播放（用户 m03936 第 4 条）。 */
      s.setLoopOn(!!r)
    },
    [set],
  )

  return (
    <div className="app">
      <div className="toolbar">
        <div className="tb-side tb-left">
          <span className="brand">
            {/* 顶栏图标 = 品牌图标（logo-bp.png；窗口/任务栏图标由 src-tauri/icons 决定） */}
            <img className="brand-logo" src="/icons/logo-bp.png" alt={COPY.appName} />
            <span className="brand-text">
              {COPY.appName}
              <small>
                {COPY.appNameEn} {APP_VERSION}
              </small>
            </span>
          </span>

          {/* 文件操作（用户 m02483 第 5 条，习惯上放最前面）：
           * 打开音频 / 打开方案 / 保存方案 / 导出 —— 一个组里，都是"进出一个文件"。 */}
          <span className="tgroup" title="文件">
            <button
              className="icon-btn"
              onClick={() => void openAudio()}
              disabled={!!busy}
              title="选一段音频（wav / mp3 / m4a / flac…）打开，马上开始分析"
              aria-label={COPY.openAudio}
            >
              <Icon name="folder" />
            </button>
            <button
              className="icon-btn"
              onClick={() => void openProject()}
              disabled={!!busy}
              title={COPY.projectOpenTip}
              aria-label={COPY.projectOpen}
            >
              <Icon name="openProject" />
            </button>
            <button
              className={dirty ? 'icon-btn dirty' : 'icon-btn'}
              onClick={() => {
                void saveProject()
                  .then((p) => setNotice(p ? `${COPY.projectSavedTip}：${p}` : null))
                  .catch((e: unknown) => {
                    set.getState().setError(`方案存不下来：${e instanceof Error ? e.message : String(e)}`)
                  })
              }}
              disabled={!filePath || !!busy}
              title={dirty ? '有修改未保存：点一下写进 .bp.json（Ctrl+S）' : COPY.projectSaveTip}
              aria-label={COPY.projectSave}
            >
              <Icon name="save" />
            </button>
            <button
              className="icon-btn"
              onClick={() => void exportJps()}
              disabled={confirmedCount === 0}
              title="只导出确认过的音，存成 .jps 文本"
              aria-label={COPY.exportJps}
            >
              <Icon name="export" />
            </button>
          </span>

          {/* 判音 / 谱音（用户 m02483 第 5 条）：自动判音、和弦识别、全当谱音、全不选、丢掉改动 */}
          <span className="tgroup" title="判音 / 谱音">
            <button
              className="icon-btn"
              onClick={doAnalyze}
              disabled={!analysis || !!busy}
              title={COPY.analyzeTip}
              aria-label={COPY.analyze}
            >
              <Icon name="analyze" />
            </button>
            <button
              className={chords.length > 0 ? 'icon-btn on' : 'icon-btn'}
              onClick={runChordAnalysis}
              disabled={!analysis || !!busy}
              title={COPY.chordTip}
              aria-label={COPY.chord}
            >
              <Icon name="chord" />
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                /* 用户 m00741/m00810：勾了"分析后自动填入音符"后点这颗按钮，若还没有音，
                 * 期望的是"分析一遍、把音都当谱音"；有音时仍是原来的"全部当谱音"。 */
                if (notes.length === 0) runAnalyze()
                else useBp.getState().setAllConfirmed(true)
              }}
              disabled={notes.length === 0 ? !analysis || !!busy : false}
              title={notes.length === 0 ? COPY.confirmAllEmptyTip : COPY.confirmAllTip}
              aria-label={COPY.confirmAll}
            >
              <Icon name="checkAll" />
            </button>
            <button
              className="icon-btn"
              onClick={doClearAll}
              disabled={!notes.length}
              title={COPY.clearAllTip}
              aria-label={COPY.clearAll}
            >
              <Icon name="checkNone" />
            </button>
            <button
              className="icon-btn"
              onClick={doResetDraft}
              disabled={!analysis}
              title={COPY.resetDraftTip}
              aria-label={COPY.resetDraft}
            >
              <Icon name="reset" />
            </button>
          </span>
        </div>

        {/* 播放：单独一颗、放顶栏正中、比别的按钮大（用户 m02483 第 6 条） */}
        <button
          className={playing ? 'play-btn on' : 'play-btn'}
          onClick={togglePlay}
          disabled={!analysis}
          title={playing ? '暂停（空格）' : '播放（空格）'}
          aria-label={playing ? COPY.pause : COPY.play}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>

        <div className="tb-side tb-right">
          {/* 绘制 / 选择（用户 m02483 第 5 条：一组） */}
          <div className="seg" title={mode === 'draw' ? COPY.modeDrawTip : COPY.modeSelectTip}>
            <button
              className={mode === 'draw' ? 'on' : ''}
              onClick={() => useBp.getState().setMode('draw')}
              aria-label={COPY.modeDraw}
              title={COPY.modeDrawTip}
            >
              <Icon name="pencil" />
            </button>
            <button
              className={mode === 'select' ? 'on' : ''}
              onClick={() => useBp.getState().setMode('select')}
              aria-label={COPY.modeSelect}
              title={COPY.modeSelectTip}
            >
              <Icon name="cursor" />
            </button>
          </div>

          {/* 音名 / 数字 */}
          <div className="seg" title="表格里写字用音名还是简谱数字（换调号数字跟着变）">
            <button
              className={pitchMode === 'name' ? 'on' : ''}
              onClick={() => useBp.getState().setPitchMode('name')}
              aria-label={COPY.pitchName}
              title="用音名写格子（C4、D4…）"
            >
              <Icon name="pitchName" />
            </button>
            <button
              className={pitchMode === 'number' ? 'on' : ''}
              onClick={() => useBp.getState().setPitchMode('number')}
              aria-label={COPY.pitchNumber}
              title="用简谱数字写格子（1、2、3…，换调号跟着变）"
            >
              <Icon name="pitchNumber" />
            </button>
          </div>

          {/* 原音频 / 合成音（用户 m02483 第 5 条：一组，方便 A/B） */}
          <div className="seg" title={COPY.abTip}>
            <button
              className={playMode === 'audio' ? 'on' : ''}
              onClick={() => switchMode('audio')}
              aria-label={COPY.sourceAudio}
              title="听原音频（跟合成音对比着听，Tab 切换）"
            >
              <Icon name="wave" />
            </button>
            <button
              className={playMode === 'synth' ? 'on' : ''}
              onClick={() => switchMode('synth')}
              aria-label={COPY.sourceSynth}
              title="听合成音（按当前谱子发声，Tab 切换）"
            >
              <Icon name="note" />
            </button>
          </div>

          {/* 回开头 / 循环 / 跟随（自动翻页）：一组导航（用户 m02483 第 5 条） */}
          <span className="tgroup" title="导航">
            <button className="icon-btn" onClick={goStart} title={COPY.goStartTip} aria-label={COPY.goStart}>
              <Icon name="home" />
            </button>
            <button
              className={loopOn ? 'icon-btn on' : 'icon-btn'}
              onClick={() => useBp.getState().setLoopOn(!loopOn)}
              title={COPY.loopTip}
              aria-label={COPY.loop}
              disabled={!loop}
            >
              <Icon name="loop" />
            </button>
            <button
              className={autoPage ? 'icon-btn on' : 'icon-btn'}
              onClick={() => useBp.getState().setAutoPage(!autoPage)}
              title={COPY.autoPageTip}
              aria-label={COPY.autoPage}
            >
              <Icon name="page" />
            </button>
          </span>

          {/* 撤销 / 重做 */}
          <span className="tgroup" title="撤销 / 重做">
            <button
              className="icon-btn"
              onClick={() => useBp.getState().undo()}
              disabled={historyLen === 0}
              title={COPY.undoTip}
              aria-label={COPY.undo}
            >
              <Icon name="undo" />
            </button>
            <button
              className="icon-btn"
              onClick={() => useBp.getState().redo()}
              disabled={futureLen === 0}
              title={COPY.redoTip}
              aria-label={COPY.redo}
            >
              <Icon name="redo" />
            </button>
          </span>

          {/* 帮助 + 右栏开关（用户 m02483）：右栏只留一颗图标，三个页签在栏内切换 */}
          <span className="tgroup tb-util" title="帮助 / 侧栏">
            {/* 帮助：按键 / 快捷键 / 鼠标操作（用户 m05893） */}
            <button
              className={helpOpen ? 'icon-btn on' : 'icon-btn'}
              onClick={() => setHelpOpen(true)}
              title="列出全部按键、快捷键、鼠标操作"
              aria-label="按键与鼠标操作"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.5" y="4" width="13" height="8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <rect x="3.4" y="6" width="1.6" height="1.6" fill="currentColor" />
                <rect x="6" y="6" width="1.6" height="1.6" fill="currentColor" />
                <rect x="8.6" y="6" width="1.6" height="1.6" fill="currentColor" />
                <rect x="11.2" y="6" width="1.6" height="1.6" fill="currentColor" />
                <rect x="4.6" y="9" width="6.8" height="1.5" rx="0.5" fill="currentColor" />
              </svg>
            </button>
            {/* 右侧栏开关：图标与 iJipu BP 的兄弟项目「爱出片」用同一个
                （public/icons/右侧边栏.svg，靠 CSS mask 上色，打开=亮、收起=灰） */}
            <button
              className={showSide ? 'icon-btn side-toggle' : 'icon-btn side-toggle off'}
              onClick={() => setShowSide((v) => !v)}
              title={showSide ? '把右侧栏收起来，给看谱多留点地方' : '把右侧栏展开（调节 / 分析 / 设置）'}
              aria-label={showSide ? '收起右侧栏' : '展开右侧栏'}
            >
              <span className="side-toggle-icon" />
            </button>
          </span>
        </div>
      </div>

      <div className={showSide ? "body" : "body noside"} style={showSide ? ({ gridTemplateColumns: `minmax(0,1fr) ${sideW}px`, "--side-w": `${sideW}px` } as React.CSSProperties) : undefined}>
        {/* 右栏宽度拖拽条（用户 m07044）：只在右栏打开时出现 */}
        {showSide && (
          <div
            className="side-resize"
            title="拖动调整右栏宽度（双击恢复 300）"
            onDoubleClick={() => {
              setSideW(300)
              if (typeof localStorage !== 'undefined') localStorage.setItem('bp.sideW', '300')
            }}
            onPointerDown={(e) => {
              e.preventDefault()
              const startX = e.clientX
              const startW = sideW
              const move = (ev: PointerEvent) => {
                const w = Math.min(760, Math.max(240, startW - (ev.clientX - startX)))
                setSideW(w)
              }
              const up = () => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', up)
                setSideW((w) => {
                  if (typeof localStorage !== 'undefined') localStorage.setItem('bp.sideW', String(w))
                  return w
                })
              }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', up)
            }}
          />
        )}
        <div className="main">
          <NoteRoll
            notes={notes}
            spectrum={
              stemMode === 'mix'
                ? (mixSpecRef.current ?? analysis?.spectrum ?? null)
                : (stemSpecRef.current?.[stemMode] ?? analysis?.spectrum ?? null)
            }
            durationMs={durationMs}
            bpm={bpm}
            beatsPerBar={beatsPerBar}
            pickupBeats={pickupBeats}
            firstBeatMs={firstBeatMs}
            pitchMode={pitchMode}
            tonic={tonic}
            mode={mode}
            snap={snap}
            view={view}
            loop={loop}
            loopOn={loopOn}
            gain={gain}
            contrast={contrast}
            bandOnly={bandOnly}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onSeek={seek}
            onAudition={(midi) => void audition(midi)}
            onAdd={(n) => useBp.getState().addNote(n)}
            onPatch={(id, patch) => useBp.getState().patchNote(id, patch)}
            onRemove={removeNote}
            onToggleConfirmed={(id) => useBp.getState().toggleConfirmed(id)}
            onBeginEdit={() => useBp.getState().beginEdit()}
            onEndEdit={() => useBp.getState().endEdit()}
            lockPitch={lockPitch}
            onToggleLock={() => useBp.getState().setLockPitch(!lockPitch)}
            onView={(v) => useBp.getState().setView(v)}
            onLoop={setLoop}
            rowH={rowH}
            topMidi={topMidi}
            onTopMidi={(m) => useBp.getState().setTopMidi(m)}
            chords={chords}
            showChords={showChords}
            playMs={currentMs}
          />
          <StripPreview
            grid={grid}
            bpm={bpm}
            beatsPerBar={beatsPerBar}
            pickupBeats={pickupBeats}
            firstBeatMs={firstBeatMs}
            durationMs={durationMs}
            view={view}
            playMs={currentMs}
            tonic={tonic}
            title={title}
            onSeek={seek}
          />
        </div>

        <div
          className={showSide ? "side" : "side off"}
          ref={sidePanelRef}
          style={{ width: sideW }}
        >
          {/* 右栏内的三个页签（用户 m02483）：调节 / 分析 / 设置，各带图标；顶栏只留一颗开关图标 */}
          <div className="side-tabs" role="tablist" aria-label="右侧栏">
            {(
              [
                ['edit', '调节', 'tune', '吸附、调号、生成参数、jps 源码'],
                ['analysis', '分析', 'analysisPanel', '节奏与谐波、分轨'],
                ['settings', '设置', 'settings', '显示组、分析开关、模型安装'],
              ] as const
            ).map(([v, label, icon, tip]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={sideView === v}
                className={sideView === v ? 'on' : ''}
                data-name={label}
                title={tip}
                onClick={() => setSideView(v)}
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </div>
          {/* 吸附：从顶栏挪到右栏（用户 m02483：顶栏省点地方），位置放在编辑页最上面 */}
          {sideView === 'edit' && (
          <label
            className="field"
            data-name="吸附"
            title="画音 / 拖音时吸附到哪一格（默认 1/16 拍）"
            style={{ marginBottom: 10 }}
          >
            吸附
            <select value={snap} onChange={(e) => useBp.getState().setSnap(e.target.value as SnapMode)}>
              {SNAP_CHOICES.map((c) => (
                <option key={c.v} value={c.v}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          )}

          {/* 调号：用户 m02483 只把这一项挪到调节页；调性分析的候选列表还在分析页 */}
          {sideView === 'edit' && (
          <label
            className="field"
            data-name={COPY.keyLabel}
            title="改调号会重算表里的简谱数字，也决定 jps 的 D: 行"
            style={{ marginBottom: 10 }}
          >
            {COPY.keyLabel}
            <select value={tonic} onChange={(e) => useBp.getState().setTonic(Number(e.target.value))}>
              {KEY_CHOICES.map((k) => (
                <option key={k} value={k}>
                  {keyDisplayName(k)} 大调
                </option>
              ))}
            </select>
          </label>
          )}

          {/* 「分析后自动填入音符」从设置页挪到分析页（用户 m02483），不用分组，直接一条开关 */}
          {sideView === 'analysis' && (
            <>
              <label
                className="check"
                data-name="分析后自动填入音符"
                title="关着：分析只出频谱/节奏/调性，音符全靠自己在表格里点；开着：分析完先垫一版灰色的参考音"
                style={{ marginBottom: 4 }}
              >
                <input
                  type="checkbox"
                  checked={autoNotes}
                  onChange={(e) => useBp.getState().setAutoNotes(e.target.checked)}
                />
                分析后自动填入音符
              </label>
              <div className="hint" style={{ marginBottom: 8 }}>
                开着：分析完先垫一版灰色的参考音；关着：只出频谱/节奏/调性。
              </div>
            </>
          )}

          {sideView === 'analysis' && (
          <div>
            <button className="group-head" onClick={() => setKeyOpen((v) => !v)} aria-expanded={keyOpen}>
              <span className="chev">{keyOpen ? '▾' : '▸'}</span>
              <span>{COPY.keyPanelTitle}</span>
            </button>
            {keyOpen && (
              <div className="group-body">
                <div className="keys">
                  {candidates.map((c) => (
                    <div
                      key={c.tonic}
                      className={`key-row${c.tonic === tonic ? ' on' : ''}`}
                      onClick={() => useBp.getState().setTonic(c.tonic)}
                      title="点一下就把调号定成它"
                    >
                      <span className="key-name">{keyDisplayName(c.tonic)}</span>
                      <span className="bar">
                        <i
                          style={{
                            width: `${Math.max(2, c.share * 100)}%`,
                            background: keyColor(c.tonic),
                          }}
                        />
                      </span>
                      <span className="key-share">{(c.share * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  {COPY.keyPanelHint}
                </div>
              </div>
            )}
          </div>
          )}

          {sideView === 'analysis' && (
          <SideGroup title={COPY.rhythmTitle}>
            <div className="row-gap">
              <button
                data-name={COPY.rhythmBtn}
                title="按当前谱重新找拍点与重拍，把 BPM / 首拍写回去"
                onClick={() => useBp.getState().runRhythm()}
                disabled={!analysis}
              >
                {COPY.rhythmBtn}
              </button>
              <span className="hint">
                {rhythm
                  ? `BPM ${rhythm.bpm} · 拍点 ${rhythm.beatCount} 个 · 可信度 ${(rhythm.confidence * 100).toFixed(0)}%`
                  : COPY.rhythmHint}
              </span>
            </div>
            <div className="row-gap" style={{ marginTop: 8 }}>
              <label
                className="field"
                data-name={COPY.harmonicLabel}
                title="把泛音从谱里减掉（0 = 不动，1 = 全减）；松手后会用同一段音频重跑一遍"
                style={{ flex: 1 }}
              >
                {COPY.harmonicLabel}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={suppress}
                  onChange={(e) => useBp.getState().setSuppress(Number(e.target.value))}
                  onPointerUp={(e) => applySuppress(Number((e.target as HTMLInputElement).value))}
                  onKeyUp={(e) => applySuppress(Number((e.currentTarget as HTMLInputElement).value))}
                  style={{ width: 120, ...fillStyle(suppress * 100) }}
                />
                <span className="mono">{suppress.toFixed(2)}</span>
              </label>
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              {COPY.harmonicHint}
            </div>
          </SideGroup>
          )}

          {/* 分轨：桌面专属（重计算），网站/插件端不渲染入口 */}
          {sideView === 'analysis' && canSeparate() && (
            <div>
              <h3>{COPY.stemsTitle}</h3>
              {sepOk && (!sepOk.model || !sepOk.dll) ? (
                <div className="warn" style={{ display: 'grid', gap: 6 }}>
                  <div>
                    {COPY.stemsMissing}
                    {sepOk && !sepOk.dll ? `；${COPY.stemsMissingDll}` : ''}
                  </div>
                  <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>
                    {COPY.stemsInstallHint}
                    {'\n'}
                    {sepTarget ?? ''}
                  </div>
                  <div className="row-gap">
                    <button
                      data-name="下载分离模型"
                      title="从 hf-mirror 下载 htdemucs 人声分离模型（302 MB）"
                      onClick={() => void openUrl(SEP_URL.mirror)}
                    >
                      {COPY.stemsDownload}（镜像）
                    </button>
                    <button
                      data-name="下载分离模型"
                      title="从 HuggingFace 官方地址下载同一个模型"
                      onClick={() => void openUrl(SEP_URL.officialPage)}
                    >
                      {COPY.stemsDownload}（HuggingFace）
                    </button>
                    <button
                      data-name={COPY.stemsRecheck}
                      title="重新检查模型文件和 onnxruntime.dll 在不在"
                      onClick={() => void sepReady().then(setSepOk)}
                    >
                      {COPY.stemsRecheck}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="row-gap">
                  <button
                    data-name={stemsReady ? COPY.stemsAgain : COPY.stemsRun}
                    title="跑 htdemucs 把这首歌拆成人声 / 伴奏（第一次要加载模型，约 10 秒）"
                    onClick={() => void handleSeparate()}
                    disabled={!analysis || !!busy}
                  >
                    {stemsReady ? COPY.stemsAgain : COPY.stemsRun}
                  </button>
                  {stemsReady ? (
                    <div className="seg" title={COPY.stemsTip}>
                      {(['mix', 'vocals', 'instrumental'] as const).map((m) => (
                        <button
                          key={m}
                          className={stemMode === m ? 'on' : ''}
                          data-name={m === 'mix' ? COPY.stemMix : m === 'vocals' ? COPY.stemVocals : COPY.stemInstrumental}
                          title="热力图和播放都切到这一轨（只看/只听，不改音符）"
                          onClick={() => setStemMode(m)}
                        >
                          {m === 'mix' ? COPY.stemMix : m === 'vocals' ? COPY.stemVocals : COPY.stemInstrumental}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="hint">{COPY.stemsHint}</span>
                  )}
                </div>
              )}
            </div>
          )}

          {sideView === 'edit' && (
          <SideGroup title={"生成参数"}>
            <div style={{ display: 'grid', gap: 6 }}>
              <label className="field" data-name="标题" title="导出的 .jps 里 B: 那一行，也是默认文件名">
                标题
                <input
                  style={{ width: 150 }}
                  value={title}
                  onChange={(e) => useBp.getState().setTitle(e.target.value)}
                />
              </label>
              <label className="field" data-name={COPY.bpmLabel} title="每分钟拍数；改它会重算整张拍轴">
                {COPY.bpmLabel}
                <input
                  type="number"
                  value={Math.round(bpm)}
                  min={20}
                  max={300}
                  onChange={(e) => useBp.getState().setBpm(Number(e.target.value))}
                />
              </label>
              <label className="field" data-name={COPY.meterLabel} title="每小节几拍（x/4）；弱起必须比它小">
                {COPY.meterLabel}
                <input
                  type="number"
                  value={beatsPerBar}
                  min={1}
                  max={12}
                  onChange={(e) => useBp.getState().setBeatsPerBar(Number(e.target.value))}
                />
                / 4
              </label>
              <label className="field" data-name={COPY.pickupLabel} title={COPY.pickupTip}>
                {COPY.pickupLabel}
                <select
                  value={pickupBeats}
                  onChange={(e) => useBp.getState().setPickupBeats(Number(e.target.value))}
                >
                  {Array.from({ length: Math.max(1, beatsPerBar) }, (_, i) => (
                    <option key={i} value={i}>
                      {i === 0 ? COPY.pickupNone : `${i} 拍`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" data-name={COPY.firstBeatLabel} title="音频里第 1 拍的位置（毫秒）：谱面从这里开始对齐">
                {COPY.firstBeatLabel}
                <input
                  type="number"
                  value={Math.round(firstBeatMs)}
                  step={10}
                  onChange={(e) => useBp.getState().setFirstBeatMs(Number(e.target.value))}
                />
                ms
              </label>
              <div className="hint">改哪一项都只重算"拍轴"，原始秒轴不动。</div>
            </div>
          </SideGroup>
          )}

          {sideView === 'settings' && (
          <SideGroup title={"显示"}>
            <div style={{ display: 'grid', gap: 6 }}>
              <label className="field" data-name="行高" title="表格每半音一行的高度；左侧钢琴键和音符块跟着变（10–26px）">
                行高
                <input
                  type="range"
                  min={ROW_H_MIN}
                  max={ROW_H_MAX}
                  step={1}
                  value={rowH}
                  onChange={(e) => useBp.getState().setRowH(Number(e.target.value))}
                  style={{
                    width: 120,
                    ...fillStyle(((rowH - ROW_H_MIN) / (ROW_H_MAX - ROW_H_MIN)) * 100),
                  }}
                />
                <span className="hint" style={{ width: 34, textAlign: 'right' }}>
                  {rowH}px
                </span>
              </label>
              <label className="field" data-name="屏宽" title="时间轴上一屏显示多少秒（默认 20 秒，2–60 秒）；比整首还宽就整曲铺满">
                屏宽
                <input
                  type="range"
                  min={PAGE_SEC_MIN}
                  max={PAGE_SEC_MAX}
                  step={1}
                  value={pageSliderSec}
                  onChange={(e) => useBp.getState().setPageSec(Number(e.target.value))}
                  disabled={!durationMs}
                  style={{
                    width: 120,
                    ...fillStyle(((pageSliderSec - PAGE_SEC_MIN) / (PAGE_SEC_MAX - PAGE_SEC_MIN)) * 100),
                  }}
                />
                <span className="hint" style={{ width: 34, textAlign: 'right' }}>
                  {Math.round(pageSliderSec)}s
                </span>
              </label>
              <label className="field" data-name="倍率" title="热力图的亮度倍率：颜色深度 = 值 ^ 对比 × 倍率">
                倍率
                <input
                  type="range"
                  min={0.2}
                  max={5}
                  step={0.1}
                  value={gain}
                  onChange={(e) => useBp.getState().setGain(Number(e.target.value))}
                  style={{ width: 140, ...fillStyle(((gain - 0.2) / 4.8) * 100) }}
                />
                <span className="hint" style={{ width: 30, textAlign: 'right' }}>
                  {gain.toFixed(1)}
                </span>
              </label>
              <label className="field" data-name="对比" title="热力图的对比（指数）：越大，强弱差距拉得越开">
                对比
                <input
                  type="range"
                  min={0.3}
                  max={3}
                  step={0.05}
                  value={contrast}
                  onChange={(e) => useBp.getState().setContrast(Number(e.target.value))}
                  style={{ width: 140, ...fillStyle(((contrast - 0.3) / 2.7) * 100) }}
                />
                <span className="hint" style={{ width: 30, textAlign: 'right' }}>
                  {contrast.toFixed(2)}
                </span>
              </label>
              <label className="check" data-name="只看人声区" title="只把 G3–C6（约 196–1047Hz）的格子画亮：伴奏在低音区/高频的泛音会被压暗">
                <input type="checkbox" checked={bandOnly} onChange={(e) => useBp.getState().setBandOnly(e.target.checked)} />
                只看人声区（G3–C6）
              </label>
              <label className="check" data-name="显示和弦" title={COPY.chordOnlyHint}>
                <input
                  type="checkbox"
                  checked={showChords}
                  disabled={chords.length === 0}
                  onChange={(e) => useBp.getState().setShowChords(e.target.checked)}
                />
                显示和弦（表格底部那条带子）
              </label>
              {chords.length > 0 && (
                <div className="row-gap">
                  <span className="hint">
                    认出 {chords.filter((c) => c.name !== 'N').length} 段 ·{' '}
                    <button
                      data-name="清除和弦"
                      title="把表格底部那条和弦带清掉（不影响音符）"
                      onClick={() => useBp.getState().setChords([])}
                    >
                      清除
                    </button>
                  </span>
                </div>
              )}
              <div className="hint">颜色深度 = 值 ^ 对比 × 倍率。</div>
            </div>
          </SideGroup>
          )}

          {sideView === 'edit' && warnings.length > 0 && (
            <div>
              <h3>{COPY.warnings}</h3>
              <div className="warn">
                {warnings.slice(0, 6).map((w, i) => (
                  <div key={i}>· {w}</div>
                ))}
              </div>
            </div>
          )}

          {sideView === 'edit' && (
          <SideGroup title={COPY.jpsTitle}>
            <pre className="src">{jps || '（还没确认音符）'}</pre>
          </SideGroup>
          )}

          {/* 设置页：前期/一次性的东西都收在这儿（用户 m06889） */}
          {sideView === 'settings' && (
            <>
              {canSeparate() && (
                <SideGroup title={COPY.stemsTitle}>
                  {sepOk && (!sepOk.model || !sepOk.dll) ? (
                    <div className="warn" style={{ display: 'grid', gap: 8 }}>
                      <div>
                        {COPY.stemsMissing}
                        {sepOk && !sepOk.dll ? `；${COPY.stemsMissingDll}` : ''}
                      </div>
                      {dl === null ? (
                        <button
                          className="primary"
                          data-name="下载分离模型"
                          title="应用内下载 htdemucs 人声分离模型（302 MB，走 hf-mirror，带进度）"
                          onClick={() => void downloadSepModel()}
                          disabled={!!busy}
                        >
                          {COPY.stemsDownloadNow}
                        </button>
                      ) : (
                        <div className="dl-wrap" title="从 hf-mirror 下载（302 MB）">
                          <div className="dl-bar">
                            <i style={{ width: `${Math.round(dl * 100)}%` }} />
                          </div>
                          <span className="mono">{Math.round(dl * 100)}%</span>
                        </div>
                      )}
                      <div className="row-gap">
                        <button
                          data-name="下载分离模型"
                          title="打开镜像网页手动下载同一个模型"
                          onClick={() => void openUrl(SEP_URL.mirrorPage)}
                        >
                          {COPY.stemsDownload}（镜像网页）
                        </button>
                        <button
                          data-name="下载分离模型"
                          title="打开 HuggingFace 官方页面手动下载"
                          onClick={() => void openUrl(SEP_URL.officialPage)}
                        >
                          {COPY.stemsDownload}（HuggingFace）
                        </button>
                        <button
                          data-name={COPY.stemsRecheck}
                          title="重新检查模型文件和 onnxruntime.dll 在不在"
                          onClick={() => void sepReady().then(setSepOk)}
                        >
                          {COPY.stemsRecheck}
                        </button>
                      </div>
                      <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>
                        {COPY.stemsInstallHint}
                        {'\n'}
                        {sepTarget ?? ''}
                      </div>
                    </div>
                  ) : (
                    <div className="hint">
                      模型和 onnxruntime 都就位了，去「分析」页就能用分离按钮。
                    </div>
                  )}
                </SideGroup>
              )}

              <SideGroup title={COPY.settingsAbout} defaultOpen={false}>
                <div className="hint">爱扒谱 iJipu BP {APP_VERSION}</div>
                <div className="hint">分离模型 htdemucs（MIT，Meta AI）只在桌面版可用；网页版不显示分轨。</div>
              </SideGroup>
            </>
          )}
        </div>
      </div>

      {/* 帮助弹层：点外面或按 Esc 关掉 */}
      {helpOpen && (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="按键与鼠标操作">
            <div className="modal-head">
              <strong>按键 · 快捷键 · 鼠标</strong>
              <button className="icon-btn" onClick={() => setHelpOpen(false)} title="关闭（Esc）" aria-label="关闭">
                ×
              </button>
            </div>
            <div className="modal-body">
              {HELP_SECTIONS.map((sec) => (
                <section key={sec.title}>
                  <h4>{sec.title}</h4>
                  {sec.rows.map(([keys, what]) => (
                    <div className="help-row" key={keys}>
                      <span className="help-keys">{keys}</span>
                      <span className="help-what">{what}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 危险操作的确认弹层（用户 m02483）：清确认 / 回初稿 / 重新分析都先问一句 */}
      {confirmAsk && (
        <div className="modal-backdrop" onClick={() => setConfirmAsk(null)}>
          <div
            className="modal modal-confirm"
            role="dialog"
            aria-label={confirmAsk.title}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <strong>{confirmAsk.title}</strong>
            </div>
            <div className="modal-body">
              {confirmAsk.body.split('\n').map((line, i) => (
                <p className="confirm-line" key={i}>
                  {line}
                </p>
              ))}
            </div>
            <div className="modal-foot">
              <button onClick={() => setConfirmAsk(null)}>{COPY.confirmCancel}</button>
              <button
                className="primary"
                onClick={() => {
                  const run = confirmAsk.run
                  setConfirmAsk(null)
                  run()
                }}
              >
                {confirmAsk.ok}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 悬浮提示（用户 m02483）：快、名称在前、说明在后；顶栏和侧栏共用 */}
      <HoverTip />

      <div className="status">
        <span>{fileName ?? COPY.empty}</span>
        <span>{durationMs ? `${(durationMs / 1000).toFixed(1)}s` : ''}</span>
        <span>
          {analysis ? `确认 ${confirmedCount} / 共 ${notes.length} 个音` : ''}
        </span>
        {/* 保存状态（用户 m02483）：橙点 = 有修改没写进 .bp.json，绿点 = 已存 */}
        {filePath && (
          <span
            className={dirty ? 'save-state dirty' : 'save-state clean'}
            title={
              dirty
                ? '有修改还没写进 .bp.json：按 Ctrl+S 或点顶栏「保存方案」'
                : '当前内容已经存进 .bp.json'
            }
          >
            <i className="dot" />
            {dirty ? '未保存' : '已保存'}
          </span>
        )}
        {/* 两种保存各显示一个时间（用户 m02483）：缓存 = 随时保存，已存 = 真的写了 .bp.json */}
        {cachedAt && <span className="hint" title={COPY.projectCacheTip}>缓存 {clockOfIso(cachedAt)}</span>}
        {savedAt && <span className="hint" title={COPY.projectSaveTip}>已存 {clockOfIso(savedAt)}</span>}
        {/* 上一次危险操作前的快照（用户 m02483）：点它先确认再铺回去 */}
        {recovery && (
          <span className="hint" title={`${recovery.label}时共 ${recovery.count} 个音（${clockOfIso(recovery.at)}）`}>
            <button
              className="link-btn"
              onClick={() => {
                setConfirmAsk({
                  title: COPY.recoveryTitle,
                  body: `会把当前音符表换成「${recovery.label}」之前的快照（那时 ${recovery.count} 个音）。`,
                  ok: COPY.recoveryOk,
                  run: applyRecovery,
                })
              }}
            >
              恢复「{recovery.label}」
            </button>
          </span>
        )}
        <span>{busy ?? ''}</span>
        <span className="spacer" />
        {error && <span className="err">{error}</span>}
        {notice && <span className="hint">{notice}</span>}
        <span className="hint">空格播放 · Tab 原音/合成 · ` 绘制/选择 · L 循环 · Shift+滚轮平移 · Ctrl+滚轮缩放</span>
      </div>
    </div>
  )
}
