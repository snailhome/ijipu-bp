/**
 * audio/player.ts — 播放（原音频 / 合成音 两种，可随时切换）
 *
 * 两个模式共用一套"当前位置"：都用 ctx.currentTime / performance.now 推算，
 * 不靠 rAF 累加（那样会漂）。切换模式时先停旧的，再按当前位置在新模式里续上，
 * 这就是界面上那个 A/B 按钮（热键 Tab）——用来比较扒得准不准。
 *
 * 合成音走 iJipu 引擎的 `SynthBackend`（Web Audio 泛音叠加，零依赖）。
 * 音色库（spessasynth + SF2）是下一阶段：接上后换 backend 即可，这里不用改。
 */
import { createBackend, type AudioBackend } from '@engine'
import type { RawNote } from '../model/types'
import { midiToName } from '../analysis/pitchNames'

export type PlayMode = 'audio' | 'synth'

let ctx: AudioContext | null = null
let buffer: AudioBuffer | null = null
let source: AudioBufferSourceNode | null = null
let synth: AudioBackend | null = null
let raf = 0
let startAt = 0 // ctx 时间 / performance 时间 的基准
let startMs = 0
let endMs = 0
let mode: PlayMode = 'audio'
let onTick: ((ms: number) => void) | null = null
let onEnd: (() => void) | null = null
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

export function setAudioBuffer(b: AudioBuffer | null): void {
  buffer = b
}

/**
 * 试听一个音（卷帘上点/拖某一格就响这个音高）。
 * 和播放共用同一个 AudioContext，但用**独立的 backend 实例**：
 * 试听时正在播的曲子不该被打断（`synth.stop()` 会停掉正在播的合成音）。
 */
let auditionBackend: AudioBackend | null = null
export async function audition(midi: number, durMs = 320): Promise<void> {
  const c = audioCtx()
  await c.resume()
  if (!auditionBackend) auditionBackend = createBackend('synth')
  await auditionBackend.ready?.()
  await auditionBackend.play(midiToName(midi), 0, durMs, 0.5)
}

/** 把播放头停在某处（拖动进度、点频谱都用它） */
export function seek(ms: number): void {
  startMs = Math.max(0, ms)
  startAt = mode === 'audio' ? audioCtx().currentTime : performance.now() / 1000
}

export function stop(): void {
  runId++ // 让所有在途的 play()/tick 作废
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
  onTick = hooks.onTick
  onEnd = hooks.onEnd ?? null
  const ctxNow = audioCtx()
  await ctxNow.resume()
  /* await 期间又被 stop() 或被另一次 play() 顶掉了：这一路直接作废 */
  if (my !== runId) return false
  startMs = Math.max(0, fromMs)
  endMs = durationMs

  if (playMode === 'audio') {
    if (!buffer) {
      onTick(startMs)
      return true
    }
    source = ctxNow.createBufferSource()
    source.buffer = buffer
    source.connect(ctxNow.destination)
    const t0 = ctxNow.currentTime + 0.05
    source.start(t0, startMs / 1000)
    startAt = t0 - startMs / 1000
    source.onended = () => {
      if (my !== runId) return
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      onEnd?.()
    }
  } else {
    synth = createBackend('synth')
    await synth.ready?.()
    if (my !== runId) return false
    startAt = performance.now() / 1000
    for (const n of notes) {
      if (n.endMs <= startMs) continue
      const at = Math.max(0, n.startMs - startMs)
      const dur = Math.max(60, n.endMs - Math.max(startMs, n.startMs))
      void synth.play(midiToName(n.midi), at, dur, 0.35)
    }
  }

  const tick = () => {
    if (my !== runId || !onTick) return
    const now = mode === 'audio' ? audioCtx().currentTime : performance.now() / 1000
    const pos = startMs + (now - startAt) * 1000
    if (pos >= endMs) {
      onTick(endMs)
      raf = 0
      if (my === runId) onEnd?.()
      return
    }
    onTick(pos)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return true
}
