/**
 * worker/analyze.worker.ts — 分析线程
 *
 * 频谱 + 音符跟踪是纯计算，放 worker 里，主线程只负责画。
 * 传回时把频谱的 buffer transfer 回去（几 MB，不复制）。
 *
 * 收到 `suppress > 0` 时会先做谐波相减（"去谐波"），再跟踪音符 —— 所以主界面
 * 调那个滑条是把同一段音频**重跑一遍**（样本缓存在 App 里，不用重新选文件）。
 *
 * `kind: 'chords'` 是另一件事：和弦识别要有频谱，但不必重算频谱，
 * 主线程把当前这份频谱拷进来就行（用户 m02483 第 3 条）。
 */
import { detectChords } from '../analysis/chords'
import { analyzeSamples } from '../analysis/analyze'
import type { Spectrum } from '../model/types'

interface AnalyzeJob {
  kind?: 'analyze'
  samples: Float32Array
  sampleRate: number
  suppress?: number
  beatsPerBar?: number
  notes?: boolean
}

interface ChordJob {
  kind: 'chords'
  spectrum: Spectrum
}

type Job = AnalyzeJob | ChordJob

interface WorkerScope {
  onmessage: ((e: MessageEvent<Job>) => void) | null
  postMessage: (msg: unknown, transfer?: Transferable[]) => void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (e) => {
  try {
    const job = e.data
    if (job.kind === 'chords') {
      const chords = detectChords(job.spectrum)
      scope.postMessage({ ok: true, kind: 'chords', chords })
      return
    }
    const { samples, sampleRate, suppress, beatsPerBar, notes } = job
    const result = analyzeSamples(samples, sampleRate, { suppress, beatsPerBar, notes })
    const transfer: Transferable[] = [result.spectrum.data.buffer as ArrayBuffer]
    if (result.spectrum.frameRms?.buffer) transfer.push(result.spectrum.frameRms.buffer as ArrayBuffer)
    scope.postMessage({ ok: true, kind: 'analyze', result }, transfer)
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
