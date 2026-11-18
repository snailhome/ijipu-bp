/**
 * audio/decode.ts — 打开音频并解码成 PCM
 *
 * 两条路：
 *  · 桌面壳（Tauri）：Rust 侧 `bp_pick_audio` 弹系统对话框，`bp_read_audio` 把字节读回来
 *    ——浏览器拿不到任意路径，只能走这条（与 iJipu 的 `sync_read_audio` 同一思路）
 *  · 浏览器：`<input type=file>` 降级，方便 `npm run dev` 里调界面
 *
 * 解码统一用 `OfflineAudioContext.decodeAudioData`：不需要用户手势，也不会建常驻 ctx。
 */
import { invoke, isTauriShell } from '../brand/env'
import { mixdown } from '../analysis/analyze'

export interface LoadedAudio {
  name: string
  path: string | null
  /** 原样保留（播放要它；多声道不被混单影响） */
  buffer: AudioBuffer
  /** 分析用单声道 PCM */
  samples: Float32Array
  sampleRate: number
  durationMs: number
}

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|webm)$/i

export async function pickAndLoadAudio(): Promise<LoadedAudio | null> {
  if (isTauriShell()) {
    const picked = (await invoke<string | null>('bp_pick_audio')) ?? null
    if (!picked) return null
    const bytes = await invoke<ArrayBuffer>('bp_read_audio', { path: picked })
    if (!bytes) throw new Error('读不到音频文件：' + picked)
    const name = picked.split(/[\\/]/).pop() ?? picked
    return decodeBytes(bytes, name, picked)
  }
  const file = await pickFileInBrowser()
  if (!file) return null
  const bytes = await file.arrayBuffer()
  return decodeBytes(bytes, file.name, null)
}

/**
 * 按磁盘路径读并解码（桌面上用于"启动参数带文件"和以后的"最近打开"）。
 * 浏览器里没有这个能力，调用方要先判 `isTauriShell()`。
 */
export async function loadAudioFromPath(path: string): Promise<LoadedAudio | null> {
  const bytes = await invoke<ArrayBuffer>('bp_read_audio', { path })
  if (!bytes) throw new Error('读不到音频文件：' + path)
  const name = path.split(/[\\/]/).pop() ?? path
  return decodeBytes(bytes, name, path)
}

function pickFileInBrowser(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'audio/*,.mp3,.wav,.m4a,.flac,.ogg'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

export async function decodeBytes(
  bytes: ArrayBuffer,
  name: string,
  path: string | null,
): Promise<LoadedAudio> {
  const ctx = new OfflineAudioContext(1, 1, 44100)
  const buffer = await ctx.decodeAudioData(bytes.slice(0))
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice())
  const samples = mixdown(channels)
  return {
    name,
    path,
    buffer,
    samples,
    sampleRate: buffer.sampleRate,
    durationMs: buffer.duration * 1000,
  }
}

/** 这个后缀能不能读（给「打开」按钮的 accept 与提示用） */
export function looksLikeAudio(name: string): boolean {
  return AUDIO_EXT.test(name)
}
