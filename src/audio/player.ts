/**
 * audio/player.ts — 播放（原音频 / 合成音 两种，可随时切换）
 *
 * 两个模式共用一套"当前位置"：都用 ctx.currentTime / performance.now 推算，
 * 不靠 rAF 累加（那样会漂）。切换模式时先停旧的，再按当前位置在新模式里续上，
 * 这就是界面上那个 A/B 按钮（热键 Tab）——用来比较扒得准不准。
 *
 * 合成音走本地 `PianoSynth`（从 noteDigger 的 TinySynth 移植的 GM 1 钢琴音色，
 * 见 audio/pianoSynth.ts；noteDigger 也没有用 .sf2 采样库）。
 */
import type { RawNote } from '../model/types'
import { midiToName } from '../analysis/pitchNames'
import { PianoSynth } from './pianoSynth'
import { loadBeatClick } from './beatClick'

export type PlayMode = 'audio' | 'synth'
/** 分轨后播放哪一轨：mix 用原混音，人声/伴奏用分离出来的那一轨 */
export type PlayTrack = 'mix' | 'vocals' | 'instrumental'

let ctx: AudioContext | null = null
let buffer: AudioBuffer | null = null
let stems: { vocals: AudioBuffer; instrumental: AudioBuffer } | null = null
let track: PlayTrack = 'mix'
let source: AudioBufferSourceNode | null = null
let synth: PianoSynth | null = null
let raf = 0
let startAt = 0 // ctx 时间 / performance 时间 的基准
let startMs = 0
let endMs = 0
let mode: PlayMode = 'audio'
let onTick: ((ms: number) => void) | null = null
let onEnd: (() => void) | null = null
/** 播放速度（用户 m02483）：只改快慢，不改音高 */
let rate = 1
/** 合成音改倍率时要按当前位置重排，得留着这一轮的音符 */
let playNotes: RawNote[] = []
/* 节拍器（用户 m02483）：播放时按 BPM 打拍子，每小节第一拍重音 */
let metronomeOn = false
let metroBpm = 120
let metroBeats = 4
let metroFirst = 0
let metroBeat = 0
let metroTimer = 0
/* 节拍器音色：noteDigger 的 mp3 采样；没解码好就先退回振荡器 */
let beatBuffer: AudioBuffer | null = null
/**
 * 每次 play/stop 都递增。异步 play() 里 `await ctx.resume()` / `await synth.ready()`
 * 之后要拿自己的号比对：号变了说明期间又被 stop/play 过一次，这一路就作废。
 * 没有这个号，连续快速按空格会留下两条 tick 循环、且旧的循环不受 stop 管（raf 变量被覆盖），
 * 表现就是"播了就停不下来"。
 */
let runId = 0

function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

/**
 * 换歌时把原混音换掉。分轨结果只属于上一首歌，一并作废（回到 mix）。
 */
export function setAudioBuffer(b: AudioBuffer | null): void {
  buffer = b
  stems = null
  track = 'mix'
}

/** 单声道 PCM → AudioBuffer（分离结果读回来是 Float32Array，播放层要 AudioBuffer） */
export function makeAudioBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
  const c = audioCtx()
  const b = c.createBuffer(1, Math.max(1, samples.length), Math.max(8000, Math.round(sampleRate)))
  b.getChannelData(0).set(samples)
  return b
}

/** 分轨完成时把两轨一起存进来；null = 没有分轨结果 */
export function setStemBuffers(s: { vocals: AudioBuffer; instrumental: AudioBuffer } | null): void {
  stems = s
  if (!s) track = 'mix'
}

/** 选播放音源；和热力图用同一个值（用户 m00413：看哪轨就听哪轨） */
export function setPlayTrack(t: PlayTrack): void {
  track = t
}

function activeBuffer(): AudioBuffer | null {
  return track !== 'mix' && stems ? stems[track] : buffer
}

/**
 * 试听一个音（卷帘上点/拖某一格就响这个音高）。
 * 和播放共用同一个 AudioContext，但用**独立的 backend 实例**：
 * 试听时正在播的曲子不该被打断（`synth.stop()` 会停掉正在播的合成音）。
 */
let auditionSynth: PianoSynth | null = null

/**
 * 把音频上下文叫醒（用户 2026-11-23；2026-11-24 再加"预热"）。
 *
 * 为什么要单独一个函数：AudioContext 在手机上首次创建是 `suspended`，
 * `resume()` 必须在**用户手势**里调用才会被放行。在 `pointerdown` 里先叫醒，
 * 等用户真的点到琴键时上下文已经 running，声音就跟手了。
 *
 * 2026-11-24（"手机端点格子发声还有延迟"）：除了建上下文，这里还
 * ① 预建 `auditionSynth`（第一次试听时不用现场 new 一套节点图）；
 * ② 用 0 增益的极短音把音频图**跑一遍**（振荡器/增益节点首次创建有开销，
 *    手机第一次点格子时会卡在节点创建上）——`warmUp` 全局只做一次。
 */
let warmed = false

function warmUp(c: AudioContext): void {
  if (warmed) return
  warmed = true
  const osc = c.createOscillator()
  const g = c.createGain()
  g.gain.value = 0
  osc.connect(g)
  g.connect(c.destination)
  const t = c.currentTime
  osc.start(t)
  osc.stop(t + 0.02)
}

export function primeAudio(): void {
  const c = audioCtx()
  if (!auditionSynth) auditionSynth = new PianoSynth(c)
  if (c.state !== 'running') void c.resume()
  warmUp(c)
}

export function audition(midi: number, durMs = 320): void {
  const c = audioCtx()
  /* 不再 `await c.resume()`（用户 2026-11-23）：等它 resolve 才排声音，白等一截。
   * 直接排进上下文，resume 一完成就响（排程在 suspended 状态下是允许的）。 */
  if (c.state !== 'running') void c.resume()
  if (!auditionSynth) auditionSynth = new PianoSynth(c)
  auditionSynth.play(midiToName(midi), 0, durMs, 0.5)
}

/** 把播放头停在某处（拖动进度、点频谱都用它） */
export function seek(ms: number): void {
  startMs = Math.max(0, ms)
  startAt = mode === 'audio' ? audioCtx().currentTime : performance.now() / 1000
}

export function stop(): void {
  runId++ // 让所有在途的 play()/tick 作废
  stopMetronome()
  if (source) {
    try {
      source.stop()
    } catch {
      /* 已经停了 */
    }
    source.disconnect()
    source = null
  }
  if (synth) {
    synth.stop()
    synth = null
  }
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  onTick = null
  onEnd = null
}

export function isPlaying(): boolean {
  return raf !== 0
}

/* ---------- 节拍器：播放时按 BPM 打拍子（用户 m02483） ---------- */
function stopMetronome(): void {
  if (metroTimer) {
    window.clearInterval(metroTimer)
    metroTimer = 0
  }
}

/** 排一个"嗒"：**小节第一拍**用 noteDigger 的采样，其余拍子仍用原来的振荡器（用户 m02483） */
function clickAt(at: number, accent: boolean): void {
  const c = audioCtx()
  const t = Math.max(c.currentTime, at)
  if (accent && beatBuffer) {
    const s = c.createBufferSource()
    s.buffer = beatBuffer
    const g = c.createGain()
    g.gain.value = 0.9
    s.connect(g)
    g.connect(c.destination)
    s.start(t)
    return
  }
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = 'square'
  o.frequency.value = accent ? 1568 : 1046
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(accent ? 0.2 : 0.11, t + 0.003)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
  o.connect(g)
  g.connect(c.destination)
  o.start(t)
  o.stop(t + 0.09)
}

/** 每 80ms 排一次未来 0.3 秒内的拍子：按 BPM/首拍算拍点，再按当前倍率换算成声卡时间 */
function scheduleMetronome(): void {
  if (!metronomeOn || !isPlaying()) return
  const c = audioCtx()
  const now = c.currentTime
  const beatLen = 60000 / metroBpm
  for (;;) {
    const beatMs = metroFirst + metroBeat * beatLen
    if (beatMs > endMs) break
    const pos = currentMs()
    const at = c.currentTime + (beatMs - pos) / (1000 * rate)
    if (at > now + 0.3) break
    if (at >= now - 0.02) clickAt(at, metroBeat % metroBeats === 0)
    metroBeat++
  }
}

function startMetronome(): void {
  stopMetronome()
  if (!metronomeOn) return
  const beatLen = 60000 / metroBpm
  metroBeat = Math.max(0, Math.ceil((currentMs() - metroFirst) / beatLen))
  metroTimer = window.setInterval(scheduleMetronome, 80)
  scheduleMetronome()
}

/**
 * 开关节拍器（打开着播放时立即生效）。
 * 改 BPM / 拍号 / 首拍时 App 会再调一次，按新参数重排。
 */
export function setMetronome(on: boolean, bpm: number, beatsPerBar: number, firstBeatMs: number): void {
  metronomeOn = on
  metroBpm = Math.max(20, Math.min(300, bpm || 120))
  metroBeats = Math.max(1, Math.min(16, Math.round(beatsPerBar) || 4))
  metroFirst = Math.max(0, firstBeatMs || 0)
  if (on) {
    void loadBeatClick(audioCtx()).then((b) => {
      beatBuffer = b
    })
  }
  if (on && isPlaying()) startMetronome()
  else stopMetronome()
}

/** 当前播放位置（毫秒）：音频模式看 AudioContext 时钟，合成音看 performance.now */
function currentMs(): number {
  const now = mode === 'audio' ? audioCtx().currentTime : performance.now() / 1000
  return Math.min(endMs, startMs + (now - startAt) * 1000 * rate)
}

/**
 * 改播放速度（0.5×–2×）。
 * 正在播也立刻生效：音频模式直接改 BufferSource 的 playbackRate 并按当前位置重设时间基准；
 * 合成音的音是提前排好时间的，只能按当前位置重新排一遍（会有一瞬间的重新起音）。
 */
export function setPlayRate(r: number): void {
  const next = Math.max(0.5, Math.min(2, r))
  if (Math.abs(next - rate) < 1e-6) return
  if (!isPlaying()) {
    rate = next
    return
  }
  const pos = currentMs()
  rate = next
  if (mode === 'audio' && source) {
    startMs = pos
    startAt = audioCtx().currentTime
    source.playbackRate.value = rate
    if (metronomeOn) startMetronome()
    return
  }
  const hooks = { onTick: onTick ?? (() => {}), onEnd: onEnd ?? undefined }
  const notes = playNotes
  const end = endMs
  stop()
  void play(pos, 'synth', notes, end, hooks)
}

/**
 * 从 fromMs 开始播放。
 * notes 只在 synth 模式下用；音频模式直接播 buffer。
 */
export async function play(
  fromMs: number,
  playMode: PlayMode,
  notes: RawNote[],
  durationMs: number,
  hooks: { onTick: (ms: number) => void; onEnd?: () => void },
): Promise<boolean> {
  stop()
  const my = ++runId
  mode = playMode
  playNotes = notes
  onTick = hooks.onTick
  onEnd = hooks.onEnd ?? null
  const ctxNow = audioCtx()
  await ctxNow.resume()
  /* await 期间又被 stop() 或被另一次 play() 顶掉了：这一路直接作废 */
  if (my !== runId) return false
  startMs = Math.max(0, fromMs)
  endMs = durationMs

  if (playMode === 'audio') {
    const buf = activeBuffer()
    if (!buf) {
      onTick(startMs)
      return true
    }
    source = ctxNow.createBufferSource()
    source.buffer = buf
    source.playbackRate.value = rate
    source.connect(ctxNow.destination)
    const t0 = ctxNow.currentTime + 0.05
    source.start(t0, startMs / 1000)
    /* 基准就是"开始出声的时刻"：tick 里 pos = startMs + (now - startAt)。
     * 这里如果写 t0 - startMs/1000，startMs 会被算两次，从非零位置续播（分轨切换、暂停再播）
     * 会一下跳到 2×startMs，甚至直接到结尾。 */
    startAt = t0
    source.onended = () => {
      if (my !== runId) return
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      onEnd?.()
    }
  } else {
    synth = new PianoSynth(ctxNow)
    await synth.ready()
    if (my !== runId) return false
    startAt = performance.now() / 1000
    for (const n of notes) {
      if (n.endMs <= startMs) continue
      /* 倍率只压时间轴：1.5× 时每个音提前 1/1.5 出现、时值也缩成 1/1.5，音高不变 */
      const at = Math.max(0, (n.startMs - startMs) / rate)
      const dur = Math.max(60, (n.endMs - Math.max(startMs, n.startMs)) / rate)
      void synth.play(midiToName(n.midi), at, dur, 0.35)
    }
  }

  const tick = () => {
    if (my !== runId || !onTick) return
    const now = mode === 'audio' ? audioCtx().currentTime : performance.now() / 1000
    const pos = startMs + (now - startAt) * 1000 * rate
    if (pos >= endMs) {
      onTick(endMs)
      raf = 0
      stopMetronome()
      if (my === runId) onEnd?.()
      return
    }
    onTick(pos)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  if (metronomeOn) startMetronome()
  return true
}
