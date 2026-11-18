/**
 * analysis/pitchNames.ts — 音高/音名/简谱数字 的换算
 *
 * 三件事常被混在一起，这里分开：
 *  1. MIDI ↔ 音名（`C#4` 风格，供播放与显示）
 *  2. MIDI + 调号 → 简谱数字（`1`..`7` + 升降号 + 八度点）
 *  3. 调号 → jps 的 `D:` 写法（大调用 `C`/`F#`，降号用 `$` 前缀，如 `$B`）
 *
 * 八度点约定（与 jps 一致）：数字不带点 = 主音所在那一组；
 * 比它高一个八度加一个 `'`，低一个八度加一个 `,`。主音固定放在 C4–B4 这一组
 * （即 60 + 音级），这样 C 大调的 `1` 就是 C4，跟大多数简谱习惯一致。
 */
import type { KeyCandidate } from '../model/types'

export const MIDI_LOW = 21 // A0
export const MIDI_HIGH = 108 // C8
export const BIN_COUNT = MIDI_HIGH - MIDI_LOW + 1 // 88

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
/** 界面上的调号名（用习惯写法：降号写 b） */
const KEY_DISPLAY = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
/** jps `D:` 的写法：升号用 #，降号用 $ */
const KEY_JPS = ['C', 'C#', 'D', '$E', 'E', 'F', 'F#', 'G', '$A', 'A', '$B', 'B']

/** 大调音阶相对主音的半音数 */
const MAJOR = [0, 2, 4, 5, 7, 9, 11]

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440)
}

export function midiToName(midi: number): string {
  const m = Math.round(midi)
  const pc = ((m % 12) + 12) % 12
  return `${SHARP_NAMES[pc]}${Math.floor(m / 12) - 1}`
}

export function nameToMidi(name: string): number | null {
  const m = /^([A-G])(#|b)?(-?\d+)$/.exec(name.trim())
  if (!m) return null
  const base = SHARP_NAMES.indexOf(m[1])
  if (base < 0) return null
  const alter = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  return (Number(m[3]) + 1) * 12 + base + alter
}

export function keyDisplayName(tonic: number): string {
  return KEY_DISPLAY[((tonic % 12) + 12) % 12]
}

/** jps `D:` 的值 */
export function keyJpsName(tonic: number): string {
  return KEY_JPS[((tonic % 12) + 12) % 12]
}

export interface NumberNote {
  /** 1..7 */
  digit: number
  /** '' | '#' | '$' */
  accidental: '' | '#' | '$'
  /** 八度点：正数加 `'`，负数加 `,` */
  dots: number
  /** 拼好的简谱写法，如 `6#'` */
  text: string
}

/**
 * MIDI + 调号 → 简谱数字。
 * 调外音按"最近的音级 + 升降号"处理（`#` 表示高半音、`$` 表示低半音），
 * 与 jps 的变音写法一致。
 */
export function midiToNumber(midi: number, tonic: number): NumberNote {
  const tonicMidi = 60 + (((tonic % 12) + 12) % 12)
  const rel = midi - tonicMidi
  const dots = Math.floor(rel / 12)
  const pc = ((rel % 12) + 12) % 12

  const exact = MAJOR.indexOf(pc)
  if (exact >= 0) {
    return { digit: exact + 1, accidental: '', dots, text: `${exact + 1}${dotText(dots)}` }
  }
  // 调外：先看低半音、再看高半音，都没有就退回最近的音级
  const lower = MAJOR.indexOf((pc + 11) % 12)
  if (lower >= 0) {
    // 该音比音级高半音 → `#`
    return { digit: lower + 1, accidental: '#', dots, text: `${lower + 1}#${dotText(dots)}` }
  }
  const upper = MAJOR.indexOf((pc + 1) % 12)
  if (upper >= 0) {
    return { digit: upper + 1, accidental: '$', dots, text: `${upper + 1}$${dotText(dots)}` }
  }
  return { digit: 1, accidental: '', dots, text: `1${dotText(dots)}` }
}

function dotText(dots: number): string {
  if (dots > 0) return "'".repeat(Math.min(3, dots))
  if (dots < 0) return ','.repeat(Math.min(3, -dots))
  return ''
}

/** 音名或数字，看当前显示模式 */
export function noteLabel(midi: number, tonic: number, mode: 'name' | 'number'): string {
  return mode === 'number' ? midiToNumber(midi, tonic).text : midiToName(midi)
}

/** 候选调排序后取前 N 个（分析模块产出，界面直接渲染） */
export function topKeys(candidates: KeyCandidate[], n = 6): KeyCandidate[] {
  return [...candidates].sort((a, b) => b.share - a.share).slice(0, n)
}
