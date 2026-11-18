/**
 * inspect.ts — 盯着一段音频问"它到底扒出了什么"
 *
 * 用途：分析结果不对时（音高错、时值不对、BPM 离谱），用它把中间量打出来，
 * 不用在界面上猜。默认什么都不传时打印一段合成旋律的诊断。
 *
 *   npm run inspect                     # 内置合成旋律（C4 E4 G4 C5，各 500ms）
 *   npm run inspect -- 某曲.wav          # 只读 16-bit PCM 的 wav（够调试用）
 *
 * 输出四段：原始音符（毫秒）、量化后（tick）、生成的 jps、以及每帧的
 * 峰值 bin/能量（前 40 帧），时值不对时先看最后一段。
 */
import { readFileSync } from 'node:fs'
import { analyzeSamples } from '../src/analysis/analyze'
import { midiToName, BIN_COUNT } from '../src/analysis/pitchNames'
import { quantize, TICKS_PER_BEAT } from '../src/jps/quantize'
import { toJps } from '../src/jps/toJps'
import type { GridOptions } from '../src/model/types'

const RATE = 44100

/** 造一段和 scripts/make-fixture-wav.mjs 一样的旋律，但不落盘 */
function synthMelody(): Float32Array {
  const notes = [
    { midi: 60, ms: 500 },
    { midi: 64, ms: 500 },
    { midi: 67, ms: 500 },
    { midi: 72, ms: 500 },
  ]
  const total = Math.round((notes.reduce((s, n) => s + n.ms, 0) + 500) / 1000 * RATE)
  const out = new Float32Array(total)
  let cursor = 0
  for (const n of notes) {
    const len = Math.round((n.ms / 1000) * RATE)
    const freq = 440 * 2 ** ((n.midi - 69) / 12)
    for (let i = 0; i < len; i++) {
      const env = Math.min(1, i / 660, (len - i) / 2646)
      out[cursor + i] =
        0.28 *
        Math.max(0, env) *
        (Math.sin((2 * Math.PI * freq * i) / RATE) +
          0.35 * Math.sin((2 * Math.PI * freq * 2 * i) / RATE) +
          0.18 * Math.sin((2 * Math.PI * freq * 3 * i) / RATE))
    }
    cursor += len
  }
  return out
}

/** 只认单声道 16-bit PCM。够自己造的夹具用；真曲子请走应用。 */
function readWav(path: string): { samples: Float32Array; rate: number } {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 wav：' + path)
  }
  let pos = 12
  let rate = RATE
  let channels = 1
  let bits = 16
  let dataStart = -1
  let dataLen = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10)
      rate = buf.readUInt32LE(pos + 12)
      bits = buf.readUInt16LE(pos + 22)
    } else if (id === 'data') {
      dataStart = pos + 8
      dataLen = size
      break
    }
    pos += 8 + size + (size % 2)
  }
  if (dataStart < 0) throw new Error('wav 里没有 data 段')
  if (bits !== 16) throw new Error('只支持 16-bit，实际 ' + bits)
  const frames = Math.floor(dataLen / (2 * channels))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += buf.readInt16LE(dataStart + (i * channels + c) * 2)
    samples[i] = sum / channels / 32768
  }
  return { samples, rate }
}

const arg = process.argv.slice(2).find((a) => !a.startsWith('-'))
const { samples, rate } = arg ? readWav(arg) : { samples: synthMelody(), rate: RATE }
console.log(`输入：${arg ?? '内置合成旋律'}，${(samples.length / rate).toFixed(2)} 秒，${rate} Hz`)

const result = analyzeSamples(samples, rate)
console.log(`\n节奏：BPM ${result.bpm.toFixed(1)}，首拍 ${result.firstBeatMs.toFixed(0)}ms`)
console.log(`调性：${result.keyCandidates.map((k) => `${k.tonic}:${(k.share * 100).toFixed(0)}%`).join(' ')}`)
console.log(`\n原始音符（${result.notes.length} 个）：`)
for (const n of result.notes) {
  const dur = n.endMs - n.startMs
  console.log(
    `  ${midiToName(n.midi).padEnd(4)} ${n.startMs.toFixed(0).padStart(6)} → ${n.endMs
      .toFixed(0)
      .padStart(6)}ms  (${dur.toFixed(0)}ms, vel ${n.velocity.toFixed(2)})`,
  )
}

const opt: GridOptions = {
  bpm: result.bpm,
  beatsPerBar: 4,
  firstBeatMs: result.firstBeatMs,
}
const q = quantize(result.notes, opt)
console.log(`\n量化后（1 拍 = ${(60000 / result.bpm).toFixed(1)}ms = ${TICKS_PER_BEAT} tick）：`)
for (const n of q.notes) {
  console.log(
    `  ${midiToName(n.midi).padEnd(4)} tick ${String(n.startTick).padStart(4)} + ${String(
      n.ticks,
    ).padStart(3)}  (${(n.ticks / TICKS_PER_BEAT).toFixed(2)} 拍)`,
  )
}
if (q.warnings.length > 0) console.log('告警：' + q.warnings.join('；'))

const jps = toJps(q.notes, { ...opt, title: '诊断', tonic: result.keyCandidates[0]?.tonic ?? 0 })
console.log('\njps：')
console.log(
  jps
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n'),
)

/* 频谱逐帧峰值：时值/音高不对时先看这段 */
const spec = result.spectrum
const frames = Math.min(40, spec.frames)
console.log(`\n前 ${frames} 帧峰值（峰值 bin 对应音名）：`)
for (let f = 0; f < frames; f++) {
  let best = 0
  let bestVal = 0
  for (let b = 0; b < BIN_COUNT; b++) {
    const v = spec.data[f * BIN_COUNT + b]
    if (v > bestVal) {
      bestVal = v
      best = b
    }
  }
  const ms = f * spec.hopMs
  console.log(`  ${ms.toFixed(0).padStart(5)}ms  ${midiToName(21 + best).padEnd(4)} v=${bestVal.toFixed(2)} rms=${spec.frameRms[f].toFixed(3)}`)
}
