/**
 * make-fixture-wav.mjs — 生成一段"人工合成旋律"的 wav，用来验证整条链路
 *
 * 用途：`node scripts/make-fixture-wav.mjs out.wav` 之后
 * `ijipu-bp.exe out.wav` 能直接打开它，看频谱、音符、简谱是不是对得上。
 *
 * 为什么不用真曲子：这一段每个音的起止时刻、音高、力度都是我们定的，
 * 所以"检测出来几个音、音高是什么、量化到第几拍"全都能当断言；
 * 真曲子只能靠眼睛看。
 *
 * 写法故意只用 node 内置模块：不引第三方，谁都能跑。
 */
import { writeFileSync } from 'node:fs'

const RATE = 44100
/** C4 / E4 / G4 / C5，每个 500ms，最后留 500ms 静音 */
const MELODY = [
  { midi: 60, ms: 500 },
  { midi: 64, ms: 500 },
  { midi: 67, ms: 500 },
  { midi: 72, ms: 500 },
]
const SILENCE_MS = 500
/** 加两次谐波，让它像个乐器（纯正弦的频谱太干净，看不出泛音） */
const HARMONICS = [
  { mul: 1, gain: 1 },
  { mul: 2, gain: 0.35 },
  { mul: 3, gain: 0.18 },
]
const ATTACK_MS = 15
const RELEASE_MS = 60

function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12)
}

function render() {
  const totalMs = MELODY.reduce((s, n) => s + n.ms, 0) + SILENCE_MS
  const total = Math.round((totalMs / 1000) * RATE)
  const out = new Float32Array(total)

  let cursor = 0
  for (const note of MELODY) {
    const len = Math.round((note.ms / 1000) * RATE)
    const freq = midiToFreq(note.midi)
    const attack = Math.round((ATTACK_MS / 1000) * RATE)
    const release = Math.round((RELEASE_MS / 1000) * RATE)
    for (let i = 0; i < len; i++) {
      let env = 1
      if (i < attack) env = i / attack
      else if (i > len - release) env = Math.max(0, (len - i) / release)
      let v = 0
      for (const h of HARMONICS) v += h.gain * Math.sin((2 * Math.PI * freq * h.mul * i) / RATE)
      out[cursor + i] = 0.28 * env * v
    }
    cursor += len
  }
  return { out, totalMs }
}

function toWav(samples) {
  const dataBytes = samples.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(RATE, 24)
  buf.writeUInt32LE(RATE * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return buf
}

const target = process.argv[2] ?? 'fixture.wav'
const { out, totalMs } = render()
writeFileSync(target, toWav(out))
console.log(`已写 ${target}：${(totalMs / 1000).toFixed(2)} 秒，${out.length} 个样本`)
console.log(`音符：${MELODY.map((n) => n.midi).join(' / ')}（MIDI），每音 ${MELODY[0].ms}ms`)
