/**
 * jps/toJps.ts — 拍轴音符 → .jps 文本（可直接喂给 iJipu 引擎）
 *
 * 难点全在"时值怎么写"，因为 jps 只有三种手段：减时线 `/`、增时线 `-`、附点 `.`。
 * 做法：把每个音的 tick 数拆成"能用一个记号写出来的时值"的**和**，多段就用连音线
 * `( … )` 括起来（同音高相邻会被引擎合并成一个音，这正是连音线的语义）。
 *
 * 另一个硬约束：小节必须凑满（否则 `checkMeasureBeats` 告警），所以：
 *  · 音符跨小节 → 在小节线处切开，两段用连音线连起来（`( 6- | 6 )`）
 *  · 空隙 → 休止符 `0` + 同样的时值后缀
 *  · 最后一小节不足 → 用休止补满
 */
import { midiToNumber, keyJpsName } from '../analysis/pitchNames'
import { barCountOf, barIndexOf, barStartTick, barTicksAt } from './bars'
import { TICKS_PER_BEAT } from './quantize'
import type { GridNote, GridOptions } from '../model/types'

export interface JpsOptions extends GridOptions {
  title: string
  /** 主音音级（C=0） */
  tonic: number
}

/** 一个记号能表达的 tick 数（降序，贪心用） */
const CHUNK_TICKS = [64, 56, 48, 32, 28, 24, 16, 14, 12, 8, 7, 6, 4, 3, 2, 1]

/** 时值后缀：增时线 / 减时线 / 附点 */
export function durationSuffix(ticks: number): string {
  if (ticks % TICKS_PER_BEAT === 0 && ticks >= TICKS_PER_BEAT) {
    return '-'.repeat(ticks / TICKS_PER_BEAT - 1)
  }
  const dots = ticks / 1.5
  if (Number.isInteger(dots) && dots >= 1) return `${baseSuffix(dots)}.`
  const ddots = ticks / 1.75
  if (Number.isInteger(ddots) && ddots >= 1) return `${baseSuffix(ddots)}..`
  return baseSuffix(ticks)
}

function baseSuffix(ticks: number): string {
  if (ticks >= TICKS_PER_BEAT) return '-'.repeat(ticks / TICKS_PER_BEAT - 1)
  return '/'.repeat(Math.round(Math.log2(TICKS_PER_BEAT / Math.max(1, ticks))))
}

/** 把一个时值拆成若干能单独写出的块（贪心，块数一般 1–3） */
export function splitDuration(ticks: number): number[] {
  const out: number[] = []
  let left = Math.max(1, ticks)
  for (const c of CHUNK_TICKS) {
    while (left >= c) {
      out.push(c)
      left -= c
    }
  }
  return out
}

interface Segment {
  midi: number
  bar: number
  start: number
  ticks: number
  noteIndex: number
}

/** 主入口：生成 jps 文本 */
export function toJps(notes: GridNote[], opt: JpsOptions): string {
  /* 小节边界含弱起：第 1 小节只有 pickupBeats 拍，从第 2 小节起才是整小节 */
  const barCount = Math.max(
    1,
    ...notes.map((n) => barCountOf(n.startTick + n.ticks, opt)),
  )

  // 1) 按小节切片（跨小节处在小节线切开，后面用连音线连起来）
  const segments: Segment[] = []
  notes.forEach((n, noteIndex) => {
    let cursor = n.startTick
    let left = n.ticks
    while (left > 0) {
      const bar = barIndexOf(cursor, opt)
      const barTicks = barTicksAt(bar, opt)
      const inBar = cursor - barStartTick(bar, opt)
      const take = Math.min(left, barTicks - inBar)
      segments.push({ midi: n.midi, bar, start: inBar, ticks: take, noteIndex })
      cursor += take
      left -= take
    }
  })

  // 2) 每个音总共会被写成几个记号 —— >1 就得用连音线括起来
  const tokenCount = new Map<number, number>()
  for (const seg of segments) {
    const n = tokenCount.get(seg.noteIndex) ?? 0
    tokenCount.set(seg.noteIndex, n + splitDuration(seg.ticks).length)
  }
  const emitted = new Map<number, number>()
  const needTie = (idx: number) => (tokenCount.get(idx) ?? 0) > 1

  // 3) 逐小节出记号
  const lines: string[] = []
  let line: string[] = []
  let lineLen = 0

  const push = (token: string) => {
    if (token === '|') {
      line.push(token)
      lineLen += 2
      return
    }
    line.push(token)
    lineLen += token.length + 1
  }

  for (let bar = 0; bar < barCount; bar++) {
    const barTicks = barTicksAt(bar, opt)
    const items = segments.filter((s) => s.bar === bar).sort((a, b) => a.start - b.start)
    let cursor = 0
    for (const item of items) {
      if (item.start > cursor) emitRest(item.start - cursor)
      const chunks = splitDuration(item.ticks)
      const digit = midiToNumber(item.midi, opt.tonic)
      for (const chunk of chunks) {
        const before = emitted.get(item.noteIndex) ?? 0
        if (needTie(item.noteIndex) && before === 0) push('(')
        push(`${digit.text}${durationSuffix(chunk)}`)
        const after = before + 1
        emitted.set(item.noteIndex, after)
        if (needTie(item.noteIndex) && after === tokenCount.get(item.noteIndex)) push(')')
      }
      cursor = item.start + item.ticks
    }
    if (cursor < barTicks) emitRest(barTicks - cursor)
    if (bar < barCount - 1) push('|')
    if (lineLen > 96 && bar < barCount - 1) {
      lines.push(line.join(' '))
      line = []
      lineLen = 0
    }
  }
  if (line.length > 0) lines.push(line.join(' '))

  function emitRest(ticks: number): void {
    for (const chunk of splitDuration(ticks)) push(`0${durationSuffix(chunk)}`)
  }

  const header = [
    'V: 1.0',
    `B: ${opt.title || '爱扒谱导出'}`,
    `D: ${keyJpsName(opt.tonic)}`,
    `P: ${opt.beatsPerBar}/4`,
    `J: ${Math.round(opt.bpm)}`,
  ]
  // 一个音都没确认时只留头部：让"导出"按钮灰着，也别输出一整行休止符让人误会
  if (notes.length === 0) return header.join('\n')
  return [...header, ...lines.map((l) => `Q: ${l}`)].join('\n')
}
