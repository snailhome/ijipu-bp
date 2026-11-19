// 人声/伴奏分离的前端入口（桌面专属）。
//
// 分工：前端已经能解码音频（decodeAudioData），所以把 PCM 交给 Rust，Rust 只做推理；
// 推理结果写成 wav 落盘再读回来，比把上千万个 float 塞进 JSON 省得多。
import { invoke, isTauriShell } from '../brand/env'
import { decodeBytes } from './decode'

export interface Stems {
  vocals: Float32Array
  instrumental: Float32Array
  seconds: number
}

/** 桌面壳里才有分离能力（网站/插件端隐藏入口） */
export function canSeparate(): boolean {
  return isTauriShell()
}

/** 模型装在哪儿；返回 null 表示还没装 */
export async function sepModelPath(): Promise<string | null> {
  if (!isTauriShell()) return null
  return (await invoke<string | null>('bp_sep_model')) ?? null
}

/** 模型应该放到哪（给用户提示用） */
export async function sepModelTarget(): Promise<string | null> {
  if (!isTauriShell()) return null
  return (await invoke<string | null>('bp_sep_model_target')) ?? null
}

/** 分离要用的两样东西：模型 + ONNX Runtime 动态库。少一样就提示去装模型包 */
export interface SepReady {
  model: boolean
  dll: boolean
}

export async function sepReady(): Promise<SepReady> {
  if (!isTauriShell()) return { model: false, dll: false }
  const r = await invoke<[boolean, boolean]>('bp_sep_ready')
  return r ? { model: r[0], dll: r[1] } : { model: false, dll: false }
}

/** 用系统浏览器打开下载页 */
export async function openUrl(url: string): Promise<void> {
  if (!isTauriShell()) {
    window.open(url, '_blank', 'noopener')
    return
  }
  await invoke<void>('bp_open_url', { url })
}

/** 应用内直接下模型（302 MB），返回落地路径 */
export async function downloadModel(url: string): Promise<string | null> {
  if (!isTauriShell()) return null
  return (await invoke<string>('bp_download_model', { url })) ?? null
}

/** 下载进度（已下字节, 总字节；总字节 0 表示服务端没给 Content-Length） */
export function onDownloadProgress(cb: (done: number, total: number) => void): () => void {
  const t = (window as unknown as { __TAURI__?: { event?: { listen: (...a: unknown[]) => Promise<() => void> } } })
  const listen = t.__TAURI__?.event?.listen
  if (!listen) return () => {}
  let off: (() => void) | null = null
  void listen('bp-sep-download', (e: { payload: [number, number] }) => {
    const [done, total] = e.payload
    cb(done, total)
  }).then((u) => {
    off = u as () => void
  })
  return () => off?.()
}

async function readAndDecode(path: string): Promise<Float32Array | null> {
  const bytes = await invoke<ArrayBuffer | null>('bp_read_audio', { path })
  if (!bytes) return null
  const loaded = await decodeBytes(bytes, path, path)
  return loaded.samples
}

/**
 * 跑一次两轨分离。`samples` 是交错立体声（L,R,L,R…）。
 * 内部会写两轨 wav 再读回来，所以返回的是单声道 PCM（位深/采样率跟 wav 一致：44.1k）。
 */
export async function separateStems(
  samples: Float32Array,
  sampleRate: number,
): Promise<Stems | null> {
  if (!isTauriShell()) return null
  const r = await invoke<{ vocals_path: string; instrumental_path: string; seconds: number }>(
    'bp_separate',
    { samples: Array.from(samples), sampleRate },
  )
  if (!r) return null
  const vocals = await readAndDecode(r.vocals_path)
  const instrumental = await readAndDecode(r.instrumental_path)
  if (!vocals || !instrumental) return null
  return { vocals, instrumental, seconds: r.seconds }
}

/** 订阅后端的分段进度（done, total）；返回取消函数 */
export function onSepProgress(cb: (done: number, total: number) => void): () => void {
  const t = (window as unknown as { __TAURI__?: { event?: { listen: (...a: unknown[]) => Promise<() => void> } } })
  const listen = t.__TAURI__?.event?.listen
  if (!listen) return () => {}
  let off: (() => void) | null = null
  void listen('bp-sep-progress', (e: { payload: [number, number] }) => {
    const [done, total] = e.payload
    cb(done, total)
  }).then((u) => {
    off = u as () => void
  })
  return () => off?.()
}
