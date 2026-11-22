/**
 * audio/saveAudio.ts — 把录音保存成 WAV 音频（录音成谱的「保存方案」）
 *
 * 用户 2026-11-22：点文件组的「保存方案」时，录音方案要**先选音频文件**，
 * 保存音频的同时把 `.bp.json` 写在它旁边。
 *
 * 桌面壳：Rust 命令 `bp_save_audio` 弹原生保存对话框 + 写盘 + 回读校验；
 * 浏览器（只用于开发/调试）：优先 `showSaveFilePicker`，没有就退回下载。
 * 两个分支都返回**写到的路径**（浏览器下载返回 `download:<文件名>` 伪路径，
 * 仅供 localStorage 里的方案键使用）。
 */
import { invoke, isTauriShell } from '../brand/env'
import { encodeWav, type WavSource } from './wav'

/** 是否有浏览器的"另存为"文件选择器（Chromium） */
interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName?: string
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
  }) => Promise<{
    name: string
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>
  }>
}

/** 浏览器下载兜底：生成一个 `<a download>` 点一下 */
function downloadWav(bytes: ArrayBuffer, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * 保存录音音频。返回写到的路径；用户取消返回 `null`（调用方不要当成失败）。
 * `buffer` 用窄接口，`AudioBuffer` 可直接传。
 */
export async function saveRecordingAudio(buffer: WavSource, suggested: string): Promise<string | null> {
  const bytes = encodeWav(buffer)
  if (isTauriShell()) {
    const path = await invoke<string | null>('bp_save_audio', {
      suggested,
      bytes: Array.from(new Uint8Array(bytes)),
    })
    return path ?? null
  }

  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: suggested,
        types: [{ description: 'WAV 音频', accept: { 'audio/wav': ['.wav'] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(new Blob([bytes], { type: 'audio/wav' }))
      await writable.close()
      return `download:${handle.name}`
    } catch (e) {
      /* 用户取消（AbortError）不是错误；别的错往上抛，让状态栏说人话 */
      if (e instanceof DOMException && e.name === 'AbortError') return null
      throw e
    }
  }
  downloadWav(bytes, suggested)
  return `download:${suggested}`
}
