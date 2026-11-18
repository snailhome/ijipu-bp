/**
 * scripts/smoke.ts — Node 冒烟（`npm run smoke`）
 *
 * 为什么要在 Node 里跑：DSP 与"生成 jps"这两块全是纯函数，用合成信号当夹具最可靠，
 * 也能在没有人耳、没有界面的情况下守住三条闸门：解析、时值、排版。
 * 断言口径：不是"跑通不报错"，而是"给定已知输入，结果落在已知范围"。
 */
import { defaultPageConfig } from '@engine-types'
import { layoutScore, parseJps, renderScoreToSvg } from '@engine'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import App from '../src/App'
import { analyzeSamples } from '../src/analysis/analyze'
import { estimateTempo } from '../src/analysis/beat'
import { buildLogMap } from '../src/analysis/logmap'
import { FFT, hannWindow } from '../src/analysis/fft'
import { guessKeys } from '../src/analysis/key'
import { midiToNumber, midiToName } from '../src/analysis/pitchNames'
import { quantize } from '../src/jps/quantize'
import { toJps } from '../src/jps/toJps'
import type { RawNote } from '../src/model/types'

const SR = 44100
const results: { name: string; ok: boolean; detail: string }[] = []

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  if (!ok) console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 生成一个带 10ms 淡入淡出的正弦 */
function tone(freq: number, ms: number, amp = 0.6): Float32Array {
  const n = Math.round((ms / 1000) * SR)
  const out = new Float32Array(n)
  const fade = Math.min(n, Math.round(0.01 * SR))
  for (let i = 0; i < n; i++) {
    let g = 1
    if (i < fade) g = i / fade
    else if (i > n - fade) g = (n - i) / fade
    out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp * g
  }
  return out
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((a, p) => a + p.length, 0)
  const out = new Float32Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function silence(ms: number): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * SR))
}

/* ---------------- 1. FFT ---------------- */
{
  const size = 8192
  const fft = new FFT(size)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const freq = 440
  for (let i = 0; i < size; i++) re[i] = Math.sin((2 * Math.PI * freq * i) / SR)
  fft.transform(re, im)
  let peak = 0
  let peakMag = -1
  for (let k = 1; k < size / 2; k++) {
    const m = Math.hypot(re[k], im[k])
    if (m > peakMag) {
      peakMag = m
      peak = k
    }
  }
  const peakHz = (peak * SR) / size
  check('FFT 440Hz 峰值落在 ±6Hz', Math.abs(peakHz - 440) <= 6, `${peakHz.toFixed(1)}Hz`)
}

/* ---------------- 2. 汉宁窗 ---------------- */
{
  const w = hannWindow(1024)
  check('汉宁窗两端为 0、中点为 1', Math.abs(w[0]) < 1e-9 && Math.abs(w[512] - 1) < 1e-6)
}

/* ---------------- 3. 对数谱映射 ---------------- */
{
  const { bins, map } = buildLogMap(SR, 8192)
  let nonEmpty = 0
  for (const b of map) {
    const sum = b.weights.reduce((a, v) => a + v, 0)
    if (sum > 0.99) nonEmpty++
  }
  check('对数谱 88 个半音 bin 全部有能量核', bins === 88 && map.length === 88 && nonEmpty === 88, `${nonEmpty}/88`)
}

/* ---------------- 4. 音名 / 简谱数字 ---------------- */
{
  const a4 = midiToName(69)
  const n = midiToNumber(60, 0)
  const sharp = midiToNumber(61, 0)
  check('MIDI 69 = A4', a4 === 'A4', a4)
  check('C 大调下 MIDI 60 = 简谱 1', n.digit === 1 && n.text === '1', JSON.stringify(n))
  check('调外音给升号而不是丢音', sharp.accidental === '#' && sharp.text === '1#', JSON.stringify(sharp))
}

/* ---------------- 5. 端到端：三个音 → 频谱 → 音符 ---------------- */
const melody = concat([
  tone(261.63, 600), // C4
  silence(120),
  tone(329.63, 600), // E4
  silence(120),
  tone(392.0, 600), // G4
  silence(300),
])
{
  const r = analyzeSamples(melody, SR)
  const got = r.notes.map((x) => midiToName(x.midi))
  check('检出 3 个音（允许边界多检 1 个）', r.notes.length >= 3 && r.notes.length <= 4, got.join(','))
  const want = [60, 64, 67]
  const head = r.notes.slice(0, 3).map((x) => x.midi)
  const near = head.every((m, i) => Math.abs(m - want[i]) <= 1)
  check('前三个音高接近 C4/E4/G4', near, head.join(','))

  /* 6. 调性：C 大调三和弦应把 C 排第一 */
  const keys = guessKeys(r.spectrum)
  check('调性首选 C', keys[0]?.tonic === 0, keys.map((k) => `${k.tonic}:${k.share.toFixed(2)}`).join(' '))

  /* 7. 速度：这里有明显音符，BPM 应是个合理值 */
  const tempo = estimateTempo(r.spectrum)
  check('BPM 落在 55–190', tempo.bpm >= 55 && tempo.bpm <= 190, tempo.bpm.toFixed(1))
}

/* ---------------- 8. 量化：120BPM 下 500ms = 1 拍 = 4 tick ---------------- */
{
  const raws: RawNote[] = [
    { id: 'a', midi: 60, startMs: 0, endMs: 500, velocity: 0.6 },
    { id: 'b', midi: 62, startMs: 500, endMs: 1000, velocity: 0.6 },
    { id: 'c', midi: 64, startMs: 1000, endMs: 1500, velocity: 0.6 },
  ]
  const q = quantize(raws, { bpm: 120, beatsPerBar: 4, firstBeatMs: 0 })
  const ticks = q.notes.map((n) => `${n.startTick}+${n.ticks}`).join(' ')
  check('量化后 tick = 0+4 / 4+4 / 8+4', ticks === '0+4 4+4 8+4', ticks)
  check('量化没有告警', q.warnings.length === 0, q.warnings.join('；'))
}

/* ---------------- 9. 生成 jps → 引擎解析 → 排版 → SVG ---------------- */
{
  const raws: RawNote[] = [
    { id: 'a', midi: 60, startMs: 0, endMs: 500, velocity: 0.6 },
    { id: 'b', midi: 64, startMs: 500, endMs: 1000, velocity: 0.6 },
    { id: 'c', midi: 67, startMs: 1000, endMs: 2000, velocity: 0.6 },
    { id: 'd', midi: 72, startMs: 2000, endMs: 2500, velocity: 0.6 },
  ]
  const q = quantize(raws, { bpm: 120, beatsPerBar: 4, firstBeatMs: 0 })
  const jps = toJps(q.notes, {
    bpm: 120,
    beatsPerBar: 4,
    firstBeatMs: 0,
    tonic: 0,
    title: '冒烟测试',
  })
  check('jps 有头部与 Q 行', /B: 冒烟测试/.test(jps) && /^Q: /m.test(jps), jps.split('\n')[0])
  // 锁死文本：增时线紧贴音符（`5-`）、跨小节补休止（`0--`），这是引擎认的写法
  check("Q 行文本 = 1 3 5- | 1' 0--", jps.includes("Q: 1 3 5- | 1' 0--"), jps.split('\n').pop() ?? '')

  const parsed = parseJps(jps)
  const errors = parsed.errors.map((e) => (typeof e === 'string' ? e : (e.message ?? '')))
  check('引擎解析 0 错误', errors.length === 0, errors.join('；'))

  const layout = layoutScore(parsed, { ...defaultPageConfig })
  const svgs = renderScoreToSvg(layout)
  check('排版出至少 1 页 SVG', svgs.length >= 1 && svgs[0].includes('<svg'), `pages=${svgs.length}`)
}

/* ---------------- 10. 跨小节的长音必须写成连音线 ---------------- */
{
  const raws: RawNote[] = [
    { id: 'a', midi: 60, startMs: 0, endMs: 1500, velocity: 0.6 },
    // 1500ms 起、1000ms 长：120BPM 下从第 3 拍跨到下一小节
    { id: 'b', midi: 67, startMs: 1500, endMs: 2500, velocity: 0.6 },
  ]
  const q = quantize(raws, { bpm: 120, beatsPerBar: 4, firstBeatMs: 0 })
  const jps = toJps(q.notes, { bpm: 120, beatsPerBar: 4, firstBeatMs: 0, tonic: 0, title: '跨小节' })
  const qLine = jps.split('\n').find((l) => l.startsWith('Q: ')) ?? ''
  const parsed = parseJps(jps)
  const errors = parsed.errors.map((e) => (typeof e === 'string' ? e : (e.message ?? '')))
  check('跨小节音符用 ( … ) 连起来且能解析', /\(\s*5/.test(qLine) && errors.length === 0, `${qLine}｜错=${errors.join('；')}`)
  if (process.argv.includes('--show')) console.log(`跨小节样例：${qLine}`)
}

/* ---------------- 11. 空输入不炸 ---------------- */
{
  const r = analyzeSamples(new Float32Array(SR), SR)
  check('静音输入 → 0 个音、无异常', r.notes.length === 0 && Number.isFinite(r.bpm), `${r.notes.length} 个音`)
}

/* ---------------- 12. 界面能挂载（SSR 渲染一次，抓初始渲染的崩溃） ---------------- */
{
  const html = renderToString(createElement(App))
  const ok =
    html.includes('爱扒谱') &&
    html.includes('打开音频') &&
    html.includes('调性分析') &&
    html.includes('简谱预览')
  check('主界面初始渲染出工具条与三个面板', ok, `${html.length} 字符`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n冒烟：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.error(`失败项：${failed.map((f) => f.name).join('；')}`)
  process.exitCode = 1
}
