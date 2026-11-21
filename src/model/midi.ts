/**
 * model/midi.ts — 标准 MIDI 文件（SMF）的读和写
 *
 * 为什么不引第三方库：这里只用得到"读音符 + 速度/拍号"和"写一个单轨 MIDI"，
 * 自己按 SMF 规范实现更小、也不给打包添依赖（跟 noteDigger 的 lib/midi.js 一个思路）。
 *
 * 读：支持 format 0/1、running status、meta（tempo / time signature）、
 *     note on/off（含 velocity=0 的 note on 当关音）。
 * 写：format 1、单轨（第 0 轨只放 tempo/拍号），480 ticks/四分音符；
 *     音符按毫秒换算成 tick，同 tick 先关后开，避免叠在一起。
 */
import type { RawNote } from './types'

const TICKS_PER_QUARTER = 480
const END_OF_TRACK = [0xff, 0x2f, 0x00]
const MAX_DELTA = 0x0fffffff

/** 读一个变长整数，返回值和下一个位置 */
function readVar(data: DataView, start: number): { v: number; next: number } {
  let v = 0
  let i = start
  for (let n = 0; n < 4; n++) {
    const b = data.getUint8(i++)
    v = (v << 7) | (b & 0x7f)
    if (!(b & 0x80)) return { v, next: i }
  }
  return { v, next: i }
}

function writeVar(out: number[], v: number): void {
  const bytes = [v & 0x7f]
  v >>= 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  out.push(...bytes)
}

/** 读出来的 MIDI 内容（只要扒谱用得上的） */
export interface ParsedMidi {
  notes: RawNote[]
  bpm: number
  beatsPerBar: number
  /** 最后一个音的结束时间（毫秒） */
  durationMs: number
}

/**
 * 解析 SMF。
 * 只认 note on/off 和 tempo/time-signature；通道、力度保留（力度换算成 0..1）。
 * 遇到不认识的 meta/sysex 直接跳过（SMF 的长度字段就是干这个的）。
 */
export function parseMidi(buffer: ArrayBuffer): ParsedMidi {
  const view = new DataView(buffer)
  if (view.byteLength < 14) throw new Error('MIDI 文件太短，读不出头')
  const ascii = (p: number, n: number) =>
    Array.from({ length: n }, (_, i) => String.fromCharCode(view.getUint8(p + i))).join('')
  if (ascii(0, 4) !== 'MThd') throw new Error('不是标准 MIDI 文件（缺 MThd）')
  const headerLen = view.getUint32(4)
  const division = view.getUint16(12)
  if (division & 0x8000) throw new Error('不支持 SMPTE 时基的 MIDI，请导出成 ticks/拍 的格式')
  const ticksPerQuarter = division || TICKS_PER_QUARTER
  let pos = 8 + headerLen
  let bpm = 120
  let beatsPerBar = 4
  const notes: RawNote[] = []
  let seq = 0

  /* 每个 (通道,音高) 一个"开着的音"：note on 记下来，note off 配对成 RawNote */
  const open = new Map<string, { startTick: number; velocity: number }>()

  while (pos + 8 <= view.byteLength) {
    const id = ascii(pos, 4)
    const len = view.getUint32(pos + 4)
    const end = pos + 8 + len
    if (id !== 'MTrk') {
      pos = end
      continue
    }
    let i = pos + 8
    let tick = 0
    let running = 0
    while (i < end) {
      const dv = readVar(view, i)
      tick += dv.v
      i = dv.next
      const b = view.getUint8(i)
      let status = b
      if (b & 0x80) {
        i++
        if (status !== 0xff && status !== 0xf0 && status !== 0xf7) running = status
      } else {
        status = running
      }
      if (status === 0xff) {
        const type = view.getUint8(i++)
        const lv = readVar(view, i)
        const l = lv.v
        i = lv.next
        const d = i
        i += l
        if (type === 0x51 && l >= 3) {
          const us = (view.getUint8(d) << 16) | (view.getUint8(d + 1) << 8) | view.getUint8(d + 2)
          if (us > 0) bpm = Math.round((60e6 / us) * 10) / 10
        } else if (type === 0x58 && l >= 1) {
          beatsPerBar = view.getUint8(d) || 4
        }
        continue
      }
      if (status === 0xf0 || status === 0xf7) {
        const lv = readVar(view, i)
        i = lv.next + lv.v
        continue
      }
      const kind = status & 0xf0
      const channel = status & 0x0f
      /* 0xC0/0xD0 只有一个数据字节，其它两个 */
      const dataLen = kind === 0xc0 || kind === 0xd0 ? 1 : 2
      if (i + dataLen > end) break
      const d1 = view.getUint8(i)
      const d2 = dataLen === 2 ? view.getUint8(i + 1) : 0
      i += dataLen
      if (kind === 0x90 && d2 > 0) {
        open.set(`${channel}:${d1}`, { startTick: tick, velocity: d2 / 127 })
      } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
        const key = `${channel}:${d1}`
        const on = open.get(key)
        if (!on) continue
        open.delete(key)
        const startMs = (on.startTick / ticksPerQuarter) * (60000 / bpm)
        const endMs = (tick / ticksPerQuarter) * (60000 / bpm)
        if (endMs - startMs < 20) continue
        notes.push({
          id: `m${++seq}`,
          midi: d1,
          startMs: Math.round(startMs),
          endMs: Math.round(endMs),
          velocity: Math.max(0.05, Math.min(1, on.velocity)),
          confirmed: true,
        })
      }
    }
    pos = end
  }
  notes.sort((a, b) => a.startMs - b.startMs || a.midi - b.midi)
  const durationMs = notes.reduce((m, n) => Math.max(m, n.endMs), 0)
  return { notes, bpm, beatsPerBar, durationMs }
}

/** 写一个单轨 MIDI（format 1）。音符按毫秒换算成 tick，bpm 决定 tick 的时长。 */
export function writeMidi(
  notes: RawNote[],
  opts: { bpm: number; beatsPerBar: number; title?: string },
): Uint8Array {
  const bpm = Math.max(20, Math.min(300, opts.bpm || 120))
  const beats = Math.max(1, Math.min(16, opts.beatsPerBar || 4))
  const msPerTick = 60000 / bpm / TICKS_PER_QUARTER
  const tickOf = (ms: number) => Math.max(0, Math.round(ms / msPerTick))

  type Ev = { tick: number; order: number; bytes: number[] }
  const evs: Ev[] = []
  /* 0 轨：tempo + time signature */
  const us = Math.round(60e6 / bpm)
  evs.push({ tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] })
  evs.push({ tick: 0, order: 1, bytes: [0xff, 0x58, 0x04, beats, 2, 24, 8] })
  for (const n of notes) {
    const on = tickOf(n.startMs)
    const off = Math.max(on + 1, tickOf(n.endMs))
    const vel = Math.max(1, Math.min(127, Math.round((n.velocity || 0.8) * 127)))
    evs.push({ tick: on, order: 2, bytes: [0x90, n.midi & 0x7f, vel] })
    evs.push({ tick: off, order: 0, bytes: [0x80, n.midi & 0x7f, 0] })
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[1] - b.bytes[1])

  const track: number[] = []
  let last = 0
  for (const e of evs) {
    writeVar(track, Math.min(MAX_DELTA, e.tick - last))
    last = e.tick
    track.push(...e.bytes)
  }
  writeVar(track, 0)
  track.push(...END_OF_TRACK)

  const out: number[] = []
  const push32 = (v: number) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  const push16 = (v: number) => out.push((v >>> 8) & 0xff, v & 0xff)
  /* MThd：format 1、1 轨、480 ticks/四分 */
  out.push(0x4d, 0x54, 0x68, 0x64)
  push32(6)
  push16(1)
  push16(1)
  push16(TICKS_PER_QUARTER)
  /* MTrk */
  out.push(0x4d, 0x54, 0x72, 0x6b)
  push32(track.length)
  out.push(...track)
  return new Uint8Array(out)
}
