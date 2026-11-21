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
import { analyzeRhythm, estimateTempo } from '../src/analysis/beat'
import { buildLogMap, SEMI_R } from '../src/analysis/logmap'
import { suppressHarmonics } from '../src/analysis/harmonics'
import { computeSpectrum } from '../src/analysis/spectrum'
import { detectChords } from '../src/analysis/chords'
import { FFT, hannWindow } from '../src/analysis/fft'
import { guessKeys } from '../src/analysis/key'
import { midiToFreq, midiToNumber, midiToName, MIDI_LOW } from '../src/analysis/pitchNames'
import { quantize } from '../src/jps/quantize'
import { marks } from '../src/jps/marks'
import { snapMs } from '../src/jps/snap'
import { toJps } from '../src/jps/toJps'
import { msToX, spanMs } from '../src/ui/timeAxis'
import { assignLanes } from '../src/ui/noteLanes'
import { buildProject, parseProject, projectPathFor, serializeProject } from '../src/model/project'
import type { ProjectSource } from '../src/model/project'
import { useBp } from '../src/model/store'
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

  /* 半音核的支撑只能到 ±SEMI_R：余弦过了 π 会绕回正值，以前漏了这条判断，
   * 低频相邻半音互相吃能量（F2 → F#2），和弦识别因此把 F 大三判成 Faug。 */
  const binHz = SR / 8192
  let outOfRange = 0
  let positiveWeights = 0
  for (let i = 0; i < map.length; i++) {
    const center = midiToFreq(MIDI_LOW + i)
    const b = map[i]
    /* 最底下几个半音（A0 一带）半音间距比 FFT 分辨率还窄，可能没有 bin 落在 ±2/3 半音内，
     * 这时 logmap 会退化成"最近的 FFT bin 单独作代表"（恰好一个权重 = 1）—— 允许它越界。 */
    const pos: number[] = []
    for (let j = 0; j < b.weights.length; j++) if (b.weights[j] > 0) pos.push(j)
    if (pos.length === 1 && Math.abs(b.weights[pos[0]] - 1) < 1e-9) continue
    for (const j of pos) {
      positiveWeights++
      const semis = Math.abs(12 * Math.log2(((b.start + j) * binHz) / center))
      if (semis > SEMI_R + 1e-9) outOfRange++
    }
  }
  check(
    '半音核只覆盖 ±2/3 半音（没有余弦绕回的越界权重）',
    outOfRange === 0 && positiveWeights > 0,
    `越界 ${outOfRange} 个 / 共 ${positiveWeights} 个权重`,
  )
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
    { id: 'a', midi: 60, startMs: 0, endMs: 500, velocity: 0.6, confirmed: true },
    { id: 'b', midi: 62, startMs: 500, endMs: 1000, velocity: 0.6, confirmed: true },
    { id: 'c', midi: 64, startMs: 1000, endMs: 1500, velocity: 0.6, confirmed: true },
  ]
  const q = quantize(raws, { bpm: 120, beatsPerBar: 4, firstBeatMs: 0 })
  const ticks = q.notes.map((n) => `${n.startTick}+${n.ticks}`).join(' ')
  check('量化后 tick = 0+4 / 4+4 / 8+4', ticks === '0+4 4+4 8+4', ticks)
  check('量化没有告警', q.warnings.length === 0, q.warnings.join('；'))
}

/* ---------------- 9. 生成 jps → 引擎解析 → 排版 → SVG ---------------- */
{
  const raws: RawNote[] = [
    { id: 'a', midi: 60, startMs: 0, endMs: 500, velocity: 0.6, confirmed: true },
    { id: 'b', midi: 64, startMs: 500, endMs: 1000, velocity: 0.6, confirmed: true },
    { id: 'c', midi: 67, startMs: 1000, endMs: 2000, velocity: 0.6, confirmed: true },
    { id: 'd', midi: 72, startMs: 2000, endMs: 2500, velocity: 0.6, confirmed: true },
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
    { id: 'a', midi: 60, startMs: 0, endMs: 1500, velocity: 0.6, confirmed: true },
    // 1500ms 起、1000ms 长：120BPM 下从第 3 拍跨到下一小节
    { id: 'b', midi: 67, startMs: 1500, endMs: 2500, velocity: 0.6, confirmed: true },
  ]
  const q = quantize(raws, { bpm: 120, beatsPerBar: 4, firstBeatMs: 0 })
  const jps = toJps(q.notes, { bpm: 120, beatsPerBar: 4, firstBeatMs: 0, tonic: 0, title: '跨小节' })
  const qLine = jps.split('\n').find((l) => l.startsWith('Q: ')) ?? ''
  const parsed = parseJps(jps)
  const errors = parsed.errors.map((e) => (typeof e === 'string' ? e : (e.message ?? '')))
  check('跨小节音符用 ( … ) 连起来且能解析', /\(\s*5/.test(qLine) && errors.length === 0, `${qLine}｜错=${errors.join('；')}`)
  if (process.argv.includes('--show')) console.log(`跨小节样例：${qLine}`)
}

/* ---------------- 10.5 弱起：第 1 小节只装 pickupBeats 拍 ---------------- */
{
  const raws: RawNote[] = [
    { id: 'a', midi: 60, startMs: 0, endMs: 500, velocity: 0.6, confirmed: true },
    { id: 'b', midi: 64, startMs: 500, endMs: 1000, velocity: 0.6, confirmed: true },
    { id: 'c', midi: 67, startMs: 1000, endMs: 2000, velocity: 0.6, confirmed: true },
    { id: 'd', midi: 72, startMs: 2000, endMs: 2500, velocity: 0.6, confirmed: true },
  ]
  const opt = { bpm: 120, beatsPerBar: 4, pickupBeats: 2, firstBeatMs: 0 }
  const q = quantize(raws, opt)
  const jps = toJps(q.notes, { ...opt, tonic: 0, title: '弱起' })
  const qLine = jps.split('\n').find((l) => l.startsWith('Q: ')) ?? ''
  const errors = parseJps(jps).errors.map((e) => (typeof e === 'string' ? e : (e.message ?? '')))
  check(
    "弱起 2 拍：首小节只装 2 拍（1 3 | 5- 1' 0）且引擎 0 错误",
    qLine === "Q: 1 3 | 5- 1' 0" && errors.length === 0,
    `${qLine}｜错=${errors.join('；')}`,
  )
}

/* ---------------- 11. 空输入不炸 ---------------- */
{
  const r = analyzeSamples(new Float32Array(SR), SR)
  check('静音输入 → 0 个音、无异常', r.notes.length === 0 && Number.isFinite(r.bpm), `${r.notes.length} 个音`)
}

/* ---------------- 11.5 帧的时刻对准帧中心（换音不能提前半个窗） ----------------
 * adj 背景：曾经用"窗口起点"当帧时刻，8192 点窗 ≈ 93ms，导致
 * 500ms 处换音被记成 400ms，量化成 0.75 拍。这条守住"不早于换音时刻"。 */
{
  const parts = [tone(261.63, 500), tone(329.63, 500), tone(392.0, 500), silence(300)]
  const r = analyzeSamples(concat(parts), SR)
  const starts = r.notes.map((n) => Math.round(n.startMs))
  check('4 个音的起点约为 0/500/1000ms', starts.length >= 3 && Math.abs(starts[0]) <= 30 && Math.abs(starts[1] - 500) <= 60 && Math.abs(starts[2] - 1000) <= 60, starts.join(','))
  const durs = r.notes.map((n) => Math.round(n.endMs - n.startMs))
  check(
    '三个音的时长都在 1 拍上下（400–600ms）',
    durs.slice(0, 3).every((d) => d >= 400 && d <= 600),
    durs.join(','),
  )
  const q = quantize(r.notes, { bpm: 120, beatsPerBar: 4, firstBeatMs: r.firstBeatMs })
  const ticks = q.notes.map((n) => n.ticks).join(',')
  check('三音量化后都是 4 tick（一拍）', q.notes.length >= 3 && q.notes.slice(0, 3).every((n) => n.ticks === 4), ticks)
}

/* ---------------- 11.6 端到端：合成的 1 3 5 1' → jps 文本 ---------------- */
{
  const parts = [tone(261.63, 500), tone(329.63, 500), tone(392.0, 500), tone(523.25, 500), silence(300)]
  const r = analyzeSamples(concat(parts), SR)
  const q = quantize(r.notes, { bpm: 120, beatsPerBar: 4, firstBeatMs: r.firstBeatMs })
  const jps = toJps(q.notes, { bpm: 120, beatsPerBar: 4, firstBeatMs: r.firstBeatMs, tonic: 0, title: '冒烟旋律' })
  const qLine = jps.split('\n').find((l) => l.startsWith('Q: ')) ?? ''
  check("端到端生成 Q: 1 3 5 1'", qLine === "Q: 1 3 5 1'", qLine)
  const errors = parseJps(jps).errors.map((e) => (typeof e === 'string' ? e : (e.message ?? '')))
  check('端到端 jps 引擎解析 0 错误', errors.length === 0, errors.join('；'))
}

/* ---------------- 11.7 手工编辑：加 / 改 / 删 / 回初稿 都重算 jps ---------------- */
/* ---------------- 11.6.5 装载音频后的默认视野：一屏 20 秒 ---------------- */
{
  useBp.getState().setLoaded({ fileName: 'long.wav', filePath: null, durationMs: 60000 })
  const zoom60 = useBp.getState().view.zoom
  check('60 秒的歌装进来 → 一屏 20 秒（zoom=3）', Math.abs(zoom60 - 3) < 0.01, String(zoom60))

  useBp.getState().setLoaded({ fileName: 'short.wav', filePath: null, durationMs: 10000 })
  const zoom10 = useBp.getState().view.zoom
  check('10 秒的曲子 → 不放大（zoom=1）', Math.abs(zoom10 - 1) < 0.01, String(zoom10))
}
{
  const parts = [tone(261.63, 500), tone(329.63, 500), silence(300)]
  const r = analyzeSamples(concat(parts), SR)
  const st = useBp.getState()
  st.setAnalysis(r)
  const before = useBp.getState().jps.split('\n').find((l) => l.startsWith('Q: ')) ?? ''

  // 加一个高八度的 C5 在第 3 拍（1200ms 起）
  useBp.getState().addNote({ midi: 72, startMs: 1100, endMs: 1500 })
  const afterAdd = useBp.getState().jps.split('\n').find((l) => l.startsWith('Q: ')) ?? ''
  check('手工加音后 jps 里多出 1̇', afterAdd.includes("1'"), `${before} → ${afterAdd}`)

  // 把这个音往上挪半音 → 变成 #1̇
  const added = useBp.getState().notes.find((n) => n.midi === 72)
  check('加的音进了音符表', added !== undefined, `${useBp.getState().notes.length} 个音`)
  if (added) useBp.getState().patchNote(added.id, { midi: 73 })
  const afterPatch = useBp.getState().jps.split('\n').find((l) => l.startsWith('Q: ')) ?? ''
  check('改音高后 jps 跟着变', afterPatch !== afterAdd, afterPatch)

  // 删掉它
  if (added) useBp.getState().removeNote(added.id)
  const afterRemove = useBp.getState().jps.split('\n').find((l) => l.startsWith('Q: ')) ?? ''
  check('删音后回到原来的谱', afterRemove === before, afterRemove)

  // 回到初稿：音符数回到分析结果的数量
  useBp.getState().addNote({ midi: 60, startMs: 0, endMs: 400 })
  useBp.getState().resetNotes()
  check('回到初稿 = 分析出来的音符数', useBp.getState().notes.length === r.notes.length, `${useBp.getState().notes.length}/${r.notes.length}`)
}

/* ---------------- 11.75 撤销：一次拖动算一步、最多 50 步 ---------------- */
{
  const parts = [tone(261.63, 500), silence(300)]
  const r = analyzeSamples(concat(parts), SR)
  useBp.getState().setAnalysis(r)
  const baseLen = useBp.getState().notes.length

  /* 一次"拖动"：beginEdit → 多次 patchNote → endEdit，撤销一次要回到拖动前 */
  const id = useBp.getState().addNote({ midi: 60, startMs: 0, endMs: 200 })
  useBp.getState().endEdit() /* 把加音这一步收尾，单独算一步 */
  const afterAdd = useBp.getState().notes.find((n) => n.id === id)
  useBp.getState().beginEdit()
  for (const step of [1, 2, 3, 4]) useBp.getState().patchNote(id, { midi: 60 + step })
  useBp.getState().endEdit()
  const afterDrag = useBp.getState().notes.find((n) => n.id === id)
  useBp.getState().undo()
  const afterUndo = useBp.getState().notes.find((n) => n.id === id)
  check('一次拖动只算一步撤销', afterDrag?.midi === 64 && afterUndo?.midi === afterAdd?.midi,
    `${afterAdd?.midi} → 拖到 ${afterDrag?.midi} → 撤销回 ${afterUndo?.midi}`)

  useBp.getState().undo() /* 再撤一步：刚加的那个音没了 */
  check('再撤一步回到加音前', useBp.getState().notes.length === baseLen,
    `${useBp.getState().notes.length}/${baseLen}`)

  /* 上限 200 步（用户 m05893 把 50 提到 200）：连加 220 个音，历史长度不该超过 200 */
  for (let i = 0; i < 220; i++) {
    useBp.getState().addNote({ midi: 48, startMs: i * 100, endMs: i * 100 + 50 })
  }
  const depth = useBp.getState().history.length
  check('撤销栈最多 200 步', depth === 200, String(depth))
}

/* ---------------- 11.8 确认集合：只有确认过的音才进谱 ---------------- */
{
  const parts = [tone(261.63, 500), tone(329.63, 500), silence(300)]
  const r = analyzeSamples(concat(parts), SR)
  useBp.getState().setAnalysis(r)

  const qOf = () =>
    useBp.getState().jps.split('\n').find((l) => l.startsWith('Q: ')) ?? ''
  check('分析出来的音默认未确认 → 谱面空', qOf() === '' || !/[1-7]/.test(qOf()), qOf())
  check(
    '未确认时状态栏的提示文案出现',
    useBp.getState().warnings.some((w) => w.includes('没确认')),
    useBp.getState().warnings.join('；'),
  )

  useBp.getState().setAllConfirmed(true)
  check('全选之后出谱', /[1-7]/.test(qOf()), qOf())
  const confirmedQ = qOf()

  const first = useBp.getState().notes[0]
  if (first) useBp.getState().toggleConfirmed(first.id)
  check('取消确认一个音 → 那个音从谱面消失', qOf() !== confirmedQ, `${confirmedQ} → ${qOf()}`)
  if (first) useBp.getState().toggleConfirmed(first.id)
  check('再确认回来 → 谱面复原', qOf() === confirmedQ, qOf())
}

/* ---------------- 11.9 吸附三档 + 流线谱时值记号 ---------------- */
{
  const opt = { bpm: 120, beatsPerBar: 4, firstBeatMs: 0 } // 一拍 500ms、一小节 2000ms
  check('吸附关：原样返回', snapMs(1234, opt, 'off') === 1234, String(snapMs(1234, opt, 'off')))
  check('吸附拍：1234 → 1000', snapMs(1234, opt, 'beat') === 1000, String(snapMs(1234, opt, 'beat')))
  check('吸附小节：1234 → 最近的小节线 2000', snapMs(1234, opt, 'bar') === 2000, String(snapMs(1234, opt, 'bar')))
  check('吸附格点（1/16 拍 = 31.25ms）：1234 → 1218.75', snapMs(1234, opt, 'grid') === 1218.75, String(snapMs(1234, opt, 'grid')))
  check('吸附格点：正好落在格上就不动（1250）', snapMs(1250, opt, 'grid') === 1250, String(snapMs(1250, opt, 'grid')))

  const m = (t: number) => { const x = marks(t); return `${x.under}/${x.dash}/${x.dots}` }
  check('4 tick = 一拍：无减时线无增时线', m(4) === '0/0/0', m(4))
  check('8 tick = 两拍：一条增时线', m(8) === '0/1/0', m(8))
  check('2 tick = 半拍：一条减时线', m(2) === '1/0/0', m(2))
  check('1 tick = 1/4 拍：两条减时线', m(1) === '2/0/0', m(1))
  check('6 tick = 附点四分：一个附点', m(6) === '0/0/1', m(6))
}

/* ---------------- 11.10 时间轴映射：整曲铺满时首尾正好贴边 ---------------- */
{
  const view = { zoom: 1, panMs: 0 }
  check('zoom=1 时 0ms 在左边界', Math.abs(msToX(0, view, 4000, 66, 500) - 66) < 1e-6, String(msToX(0, view, 4000, 66, 500)))
  check('zoom=1 时末尾在右边界', Math.abs(msToX(4000, view, 4000, 66, 500) - 566) < 1e-6, String(msToX(4000, view, 4000, 66, 500)))
  check('zoom=2 时一屏只显示一半', Math.abs(spanMs({ zoom: 2, panMs: 0 }, 4000) - 2000) < 1e-6, String(spanMs({ zoom: 2, panMs: 0 }, 4000)))
}

/* ---------------- 11.11 同一行重叠的音符分车道（用户 m00741：不能完全盖住） ---------------- */
{
  const note = (id: string, midi: number, startMs: number, endMs: number): RawNote => ({
    id,
    midi,
    startMs,
    endMs,
    velocity: 0.8,
    confirmed: true,
  })
  const single = assignLanes([note('a', 60, 0, 500)])
  check('分车道：单个音占满整行（1 条）', single.get('a')?.lane === 0 && single.get('a')?.lanes === 1)
  const dup = assignLanes([note('a', 60, 0, 500), note('b', 60, 0, 500)])
  check(
    '分车道：同音高同一时刻两个音 → 2 条、各占一条',
    dup.get('a')?.lanes === 2 && dup.get('a')?.lane !== dup.get('b')?.lane,
    JSON.stringify([...dup]),
  )
  const partial = assignLanes([note('a', 60, 0, 500), note('b', 60, 400, 900)])
  check('分车道：部分重叠也是 2 条', partial.get('a')?.lanes === 2 && partial.get('b')?.lanes === 2)
  const apart = assignLanes([note('a', 60, 0, 500), note('b', 60, 500, 900)])
  check('分车道：首尾相接不算撞车（各自整行）', apart.get('a')?.lanes === 1 && apart.get('b')?.lanes === 1)
  const other = assignLanes([note('a', 60, 0, 500), note('b', 62, 0, 500)])
  check('分车道：不同音高本来就分行，不切车道', other.get('a')?.lanes === 1 && other.get('b')?.lanes === 1)
}

/* ---------------- 11.12 方案文件（用户 m01794：存下来、下次接着干） ---------------- */
{
  const notes: RawNote[] = [
    { id: 'n1', midi: 60, startMs: 0, endMs: 500, velocity: 0.8, confirmed: true },
    { id: 'n2', midi: 64, startMs: 500, endMs: 1000, velocity: 0.6, confirmed: false },
  ]
  const src: ProjectSource = {
    fileName: '曲.wav',
    filePath: 'D:\\music\\曲.wav',
    notes,
    bpm: 120,
    beatsPerBar: 3,
    pickupBeats: 2,
    firstBeatMs: 120,
    tonic: 5,
    autoTonic: false,
    title: '我的谱',
    gain: 1.3,
    contrast: 1.8,
    bandOnly: true,
    suppress: 0.25,
    autoNotes: true,
    pitchMode: 'name',
    mode: 'draw',
    snap: 'beat',
    loop: { startMs: 500, endMs: 1500 },
    loopOn: true,
    autoPage: false,
    lockPitch: true,
    playMode: 'synth',
    view: { zoom: 2.5, panMs: 700 },
    currentMs: 900,
  }
  const path = projectPathFor(src.filePath ?? '')
  check('方案路径 = 音频路径 + .bp.json', path === 'D:\\music\\曲.wav.bp.json', path)
  check('没有音频路径（浏览器）不产方案', buildProject({ ...src, filePath: null }) === null)

  const built = buildProject(src, '2026-11-19T20:00:00.000Z')
  const text = built ? serializeProject(built) : ''
  const back = parseProject(text)
  check(
    '方案读回：音符数、拍号、弱起、视野、循环都还在',
    'project' in back &&
      back.project.notes.length === 2 &&
      back.project.settings.beatsPerBar === 3 &&
      back.project.settings.pickupBeats === 2 &&
      back.project.settings.view.zoom === 2.5 &&
      back.project.settings.loop?.endMs === 1500,
    text.slice(0, 80),
  )
  check(
    '方案读回：confirmed 没丢（它决定导出）',
    'project' in back && back.project.notes[0].confirmed === true && back.project.notes[1].confirmed === false,
  )
  check('别的应用的 JSON 不认', 'error' in parseProject('{"app":"ijipu","version":1}'))
  check('方案版本太新不认', 'error' in parseProject(JSON.stringify({ ...(built ?? {}), version: 9 })))
  const messy = parseProject(
    JSON.stringify({
      app: 'ijipu-bp',
      version: 1,
      audio: { path: 'D:\\a.wav' },
      notes: [null, { midi: 60 }, { midi: 61, startMs: 0, endMs: 100 }],
      settings: { bpm: 999, beatsPerBar: 4 },
    }),
  )
  check(
    '坏音符丢掉、越界参数钳回来（bpm 999 → 300）',
    'project' in messy && messy.project.notes.length === 1 && messy.project.notes[0].midi === 61 && messy.project.settings.bpm === 300,
    'project' in messy ? `${messy.project.notes.length} 个音 / bpm ${messy.project.settings.bpm}` : messy.error,
  )
}

/* ---------------- 12. 界面能挂载（SSR 渲染一次，抓初始渲染的崩溃） ---------------- */
{
  const html = renderToString(createElement(App))
  /* 首屏是「编辑」页：吸附、生成参数、jps 源码都在；调性/节奏/分轨收在「分析」页、显示组收在「设置」页，
   * SSR 只渲染当前视图，所以这里不再要求出现「调性分析」（用户 m02483）。 */
  const ok =
    html.includes('爱扒谱') &&
    html.includes('打开音频') &&
    html.includes('生成参数') &&
    html.includes('吸附') &&
    html.includes('简谱预览')
  check('主界面初始渲染出工具条与三个面板', ok, `${html.length} 字符`)
}

/* ---------------- 13. 去谐波：泛音被压下去，基频相对留下来 ---------------- */
{
  /* A3 = 220Hz，带 2/3/4 次泛音（比基频还响一点点，模拟"泛音很重的音色"） */
  const n = Math.round(1.2 * SR)
  const mix = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    mix[i] =
      0.5 * Math.sin(2 * Math.PI * 220 * t) +
      0.42 * Math.sin(2 * Math.PI * 440 * t) +
      0.3 * Math.sin(2 * Math.PI * 660 * t) +
      0.18 * Math.sin(2 * Math.PI * 880 * t)
  }
  const spec = computeSpectrum(mix, SR, {})
  const bins = buildLogMap(SR, 8192).bins
  const binOf = (midi: number) => midi - 21
  const energy = (s: typeof spec, midi: number) => {
    let sum = 0
    for (let f = 0; f < s.frames; f++) sum += s.data[f * bins + binOf(midi)]
    return sum / Math.max(1, s.frames)
  }
  const rawF = energy(spec, 57) // A3
  const rawH2 = energy(spec, 69) // A4
  const rawH3 = energy(spec, 76) // E5（3 倍频）
  const reduced = suppressHarmonics(spec, 0.85)
  const redF = energy(reduced, 57)
  const redH2 = energy(reduced, 69)
  const redH3 = energy(reduced, 76)
  check('去谐波：2 倍频被明显压下', redH2 / rawH2 < 0.4, `${rawH2.toFixed(3)} → ${redH2.toFixed(3)}`)
  check('去谐波：3 倍频也被压下', redH3 / rawH3 < 0.6, `${rawH3.toFixed(3)} → ${redH3.toFixed(3)}`)
  check('去谐波：基频基本不动（至少留一半）', redF / rawF > 0.5, `${rawF.toFixed(3)} → ${redF.toFixed(3)}`)
}

/* ---------------- 14. 节奏分析：120 BPM 的点击声能跟上 ---------------- */
{
  const beat = 500
  const parts: Float32Array[] = []
  for (let i = 0; i < 8; i++) {
    parts.push(tone(1200, 60, 0.8))
    parts.push(silence(beat - 60))
  }
  const clicks = concat(parts)
  const spec = computeSpectrum(clicks, SR, {})
  const r = analyzeRhythm(spec, 4)
  check('节奏分析：BPM 落在 120 附近', Math.abs(r.bpm - 120) <= 8, String(r.bpm))
  check('节奏分析：跟到足够多的拍点', r.beats.length >= 6, `${r.beats.length} 个`)
  check('节奏分析：可信度不为 0', r.confidence > 0.15, String(r.confidence))
  check('节奏分析：首拍在小节第一拍（<半拍）', r.firstBeatMs % beat < beat / 2, `${r.firstBeatMs}ms`)
}

/* ---------------- 15. 和弦识别（从 noteDigger 的 chordEst 复刻） ---------------- */
{
  const C4 = 261.63
  const E4 = 329.63
  const G4 = 392.0
  const F4 = 349.23
  const A4 = 440.0
  const C5 = 523.25
  /** 一段柱式和弦（几路正弦叠加，带 10ms 淡入淡出） */
  const chordBlock = (freqs: number[], ms: number): Float32Array => {
    const n = Math.round((ms / 1000) * SR)
    const out = new Float32Array(n)
    const fade = Math.round(0.01 * SR)
    for (let i = 0; i < n; i++) {
      const t = i / SR
      let v = 0
      for (const f of freqs) v += Math.sin(2 * Math.PI * f * t)
      v /= freqs.length
      let g = 1
      if (i < fade) g = i / fade
      else if (i > n - fade) g = (n - i) / fade
      out[i] = v * 0.7 * g
    }
    return out
  }
  const audio = concat([chordBlock([C4, E4, G4], 1500), chordBlock([F4, A4, C5], 1500)])
  const spec = computeSpectrum(audio, SR, {})
  const chords = detectChords(spec)
  const at = (ms: number) => chords.find((c) => c.startMs <= ms && ms < c.endMs)?.name ?? '?'
  check('和弦：C 大三和弦判成 C', at(700) === 'C', `${at(700)}（共 ${chords.length} 段）`)
  check('和弦：F 大三和弦判成 F', at(2200) === 'F', at(2200))
  check(
    '和弦：分段一直盖到结尾',
    chords.length > 0 && chords[chords.length - 1].endMs >= 2900,
    JSON.stringify(chords[chords.length - 1] ?? null),
  )
}

/* ---------------- 16. 显示尺寸：行高 / 屏宽 / 顶行 的上下限 ---------------- */
{
  const st = useBp.getState()
  st.setLoaded({ fileName: 'x.wav', filePath: null, durationMs: 60000 })
  st.setPageSec(20)
  check(
    '屏宽 20 秒 → 60 秒的歌 zoom=3',
    Math.abs(useBp.getState().view.zoom - 3) < 1e-6,
    String(useBp.getState().view.zoom),
  )
  check(
    '屏宽 20 秒 → 一屏正好 20 秒',
    Math.abs(spanMs(useBp.getState().view, 60000) - 20000) < 1,
    String(spanMs(useBp.getState().view, 60000)),
  )
  st.setPageSec(1)
  check('屏宽下限夹到 2 秒', useBp.getState().pageSec === 2, String(useBp.getState().pageSec))
  st.setPageSec(999)
  check('屏宽上限夹到 60 秒', useBp.getState().pageSec === 60, String(useBp.getState().pageSec))
  st.setRowH(0)
  check('行高下限 10px', useBp.getState().rowH === 10, String(useBp.getState().rowH))
  st.setRowH(999)
  check('行高上限 26px', useBp.getState().rowH === 26, String(useBp.getState().rowH))
  st.setTopMidi(-5)
  check('顶行音高下限 A0=21', useBp.getState().topMidi === 21, String(useBp.getState().topMidi))
  st.setTopMidi(999)
  check('顶行音高上限 C8=108', useBp.getState().topMidi === 108, String(useBp.getState().topMidi))
  st.setChords([{ startMs: 0, endMs: 1000, name: 'C' }])
  check('和弦结果进 store', useBp.getState().chords.length === 1)
  st.setChords([])
  st.setRowH(14)
  st.setTopMidi(96)
  st.setPageSec(20)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n冒烟：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.error(`失败项：${failed.map((f) => f.name).join('；')}`)
  process.exitCode = 1
}
