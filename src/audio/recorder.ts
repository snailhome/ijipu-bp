/**
 * audio/recorder.ts — 麦克风录音（哼唱成谱的输入）
 *
 * 用户 2026-11-22：点「录音」开始缓存音频，可暂停/继续，停止后把这段音频交给现有的
 * 分析链路（`analysis/analyze.ts`）判音。
 *
 * 实现取舍：
 *  · 用 `MediaRecorder` 录成 webm/opus（浏览器/WebView2 都自带），停止后交给
 *    `decodeBytes()` 用 `OfflineAudioContext.decodeAudioData` 解成 AudioBuffer；
 *  · 不自己接 `ScriptProcessor`/`AudioWorklet` —— 那种写法要处理重采样、声道、内存，
 *    而这里只需要一段能分析、能存 WAV 的音频；
 *  · 录音只在**内存**里：没保存音频之前关掉应用就没了（保存方案时会写 WAV 到磁盘）。
 *    `elapsedMs()` 扣掉暂停时间，给小条上的计时用。
 */
import { decodeBytes, type LoadedAudio } from './decode'
import { recordingPathOf } from '../model/recording'

export interface MicRecording {
  /** 暂停采集（再 `resume()` 继续；暂停的空档不会进音频） */
  pause: () => void
  /** 继续采集 */
  resume: () => void
  /** 停止并把已录到的音频解码成 `LoadedAudio`（失败会 reject，中文原因） */
  stop: () => Promise<LoadedAudio>
  /** 当前已录到的原始字节（给 App 定时写 IndexedDB）；还没录到返回 null */
  snapshot: () => Promise<Blob | null>
  /** 放弃这次录音：停轨道、丢掉已录数据 */
  cancel: () => void
  /** 已录时长（毫秒，已扣掉暂停时间） */
  elapsedMs: () => number
}

/** 优先 opus/webm，其次让浏览器自己挑 */
function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
  return cands.find((m) => MediaRecorder.isTypeSupported(m))
}

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝：请在系统 / 浏览器设置里允许麦克风，然后重试'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没找到麦克风：插一个麦克风或检查系统输入设备'
  if (name === 'NotReadableError') return '麦克风被别的程序占用了：关掉占用它的程序再试'
  return `麦克风打不开：${e instanceof Error ? e.message : String(e)}`
}

/** 开始录音；`name` 用来做方案名/合成路径 */
export async function startMicRecording(name: string): Promise<MicRecording> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('这个环境不支持麦克风录音（需要桌面版或新一点的浏览器）')
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('这个环境不支持 MediaRecorder，录不了音')
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      video: false,
    })
  } catch (e) {
    throw new Error(micError(e))
  }
  const mimeType = pickMime()
  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined)
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(`录音器起不来：${e instanceof Error ? e.message : String(e)}`)
  }
  const chunks: Blob[] = []
  let cancelled = false
  let startedAt = performance.now()
  let pausedAt = 0
  let pausedTotal = 0
  let stopReject: ((e: Error) => void) | null = null
  let stopResolve: ((v: LoadedAudio) => void) | null = null

  const cleanup = () => {
    stream.getTracks().forEach((t) => t.stop())
  }
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  rec.onerror = () => {
    stopReject?.(new Error('录音过程中出错（设备被拔掉 / 被占用）'))
    stopReject = null
    stopResolve = null
    cleanup()
  }
  rec.onstop = () => {
    cleanup()
    if (cancelled) return
    if (chunks.length === 0) {
      stopReject?.(new Error('没录到声音：麦克风是不是静音了？'))
      stopReject = null
      stopResolve = null
      return
    }
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
    void (async () => {
      try {
        const bytes = await blob.arrayBuffer()
        const loaded = await decodeBytes(bytes, name, recordingPathOf(name))
        /* 原始压缩字节留着写 IndexedDB（比 WAV 小），恢复时再解码 */
        stopResolve?.({ ...loaded, encodedBytes: bytes, encodedType: blob.type || 'audio/webm' })
      } catch (e) {
        stopReject?.(new Error(`录音解不开：${e instanceof Error ? e.message : String(e)}`))
      } finally {
        stopReject = null
        stopResolve = null
      }
    })()
  }

  const elapsedMs = () => {
    const now = rec.state === 'paused' ? pausedAt : performance.now()
    return Math.max(0, Math.round(now - startedAt - pausedTotal))
  }

  rec.start(250)

  return {
    pause: () => {
      if (rec.state !== 'recording') return
      pausedAt = performance.now()
      rec.pause()
    },
    resume: () => {
      if (rec.state !== 'paused') return
      pausedTotal += performance.now() - pausedAt
      rec.resume()
    },
    stop: () =>
      new Promise<LoadedAudio>((resolve, reject) => {
        stopResolve = resolve
        stopReject = reject
        if (rec.state === 'inactive') {
          rec.onstop?.(new Event('stop'))
          return
        }
        try {
          rec.stop()
        } catch (e) {
          stopReject = null
          stopResolve = null
          cleanup()
          reject(new Error(`停不下来：${e instanceof Error ? e.message : String(e)}`))
        }
      }),
    snapshot: async () => {
      if (cancelled || chunks.length === 0) return null
      return new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' })
    },
    cancel: () => {
      cancelled = true
      stopReject = null
      stopResolve = null
      try {
        if (rec.state !== 'inactive') rec.stop()
      } catch {
        /* 已经停了 */
      }
      cleanup()
    },
    elapsedMs,
  }
}

/** 小条上显示的 `mm:ss`（超过 1 小时给 `h:mm:ss`） */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}
