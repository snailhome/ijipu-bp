/**
 * audio/wav.ts — 把 AudioBuffer 编成 16-bit PCM WAV（录音保存用）
 *
 * 为什么自己写：录音来自 `MediaRecorder`（webm/opus），保存时用户要一个**通用**
 * 音频文件；WAV 不需要任何编码器依赖，Windows/手机/别的软件都能直接打开。
 *
 * 纯函数：只吃 `WavSource`（`AudioBuffer` 满足它），不碰 DOM / AudioContext，
 * 所以 Node 冒烟能直接给一段假 PCM 断言文件头与采样值。
 */

/** `AudioBuffer` 里本模块要用的部分（做窄接口，Node 里用假对象也能测） */
export interface WavSource {
  numberOfChannels: number
  length: number
  sampleRate: number
  getChannelData: (channel: number) => Float32Array
}

/** 写 ASCII 到 DataView（RIFF 头） */
function ascii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i) & 0xff)
}

/** 浮点采样 → 16-bit 有符号整数（正负分开缩放，避免 +1 溢出成 -1） */
function toInt16(v: number): number {
  const clamped = v < -1 ? -1 : v > 1 ? 1 : v
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
}

/**
 * 编码为 WAV（RIFF/WAVE，fmt=1 PCM，16-bit，多声道按 L R L R… 交错）。
 * 返回可直接写盘的 `ArrayBuffer`。
 */
export function encodeWav(source: WavSource): ArrayBuffer {
  const channels = Math.max(1, source.numberOfChannels)
  const frames = Math.max(0, source.length)
  const sampleRate = Math.max(1, Math.round(source.sampleRate))
  const blockAlign = channels * 2
  const dataBytes = frames * blockAlign
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  ascii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(view, 8, 'WAVE')
  ascii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块长度
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // 字节率
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // 位深
  ascii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  const data = new Int16Array(buffer, 44)
  for (let c = 0; c < channels; c++) {
    const ch = source.getChannelData(c)
    for (let i = 0; i < frames; i++) {
      data[i * channels + c] = toInt16(ch[i] ?? 0)
    }
  }
  return buffer
}
