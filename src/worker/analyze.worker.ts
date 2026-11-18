/**
 * worker/analyze.worker.ts — 分析线程
 *
 * 频谱 + 音符跟踪是纯计算，放 worker 里，主线程只负责画。
 * 传回时把频谱的 buffer transfer 回去（几 MB，不复制）。
 */
import { analyzeSamples } from '../analysis/analyze'

interface WorkerScope {
  onmessage: ((e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => void) | null
  postMessage: (msg: unknown, transfer?: Transferable[]) => void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (e) => {
  try {
    const { samples, sampleRate } = e.data
    const result = analyzeSamples(samples, sampleRate)
    scope.postMessage({ ok: true, result }, [result.spectrum.data.buffer as ArrayBuffer])
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
