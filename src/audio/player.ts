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

function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

export function setAudioBuffer(b: AudioBuffer | null): void {
  buffer = b
}

/** 把播放头停在某处（拖动进度、点频谱都用它） */
export function seek(ms: number): void {
  startMs = Math.max(0, ms)
  startAt = mode === 'audio' ? audioCtx().currentTime : performance.now() / 1000
}

export function stop(): void {
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
): Promise<void> {
  stop()
  mode = playMode
  onTick = hooks.onTick
  onEnd = hooks.onEnd ?? null
  const ctxNow = audioCtx()
  await ctxNow.resume()
  startMs = Math.max(0, fromMs)
  endMs = durationMs

  if (playMode === 'audio') {
    if (!buffer) {
      onTick(startMs)
      return
    }
    source = ctxNow.createBufferSource()
    source.buffer = buffer
    source.connect(ctxNow.destination)
    const t0 = ctxNow.currentTime + 0.05
    source.start(t0, startMs / 1000)
    startAt = t0 - startMs / 1000
    source.onended = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      onEnd?.()
    }
  } else {
    synth = createBackend('synth')
    await synth.ready?.()
    startAt = performance.now() / 1000
    for (const n of notes) {
      if (n.endMs <= startMs) continue
      const at = Math.max(0, n.startMs - startMs)
      const dur = Math.max(60, n.endMs - Math.max(startMs, n.startMs))
      void synth.play(midiToName(n.midi), at, dur, 0.35)
    }
  }

  const tick = () => {
    if (!onTick) return
    const now = mode === 'audio' ? audioCtx().currentTime : performance.now() / 1000
    const pos = startMs + (now - startAt) * 1000
    if (pos >= endMs) {
      onTick(endMs)
      raf = 0
      onEnd?.()
      return
    }
    onTick(pos)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}
