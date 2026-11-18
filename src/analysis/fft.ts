/**
 * analysis/fft.ts — 基 2 复数 FFT（迭代版，原地）
 *
 * 为什么自己写：iJipu 只有 OMR（图片→谱）这一条线，没有现成的信号处理模块；
 * 而扒谱的频谱是核心手艺，自己写反而可控（noteDigger 也是自己写）。
 * 实数输入直接用 im 置 0 走复数版——分析只用幅度，这点浪费换实现简单，值得。
 */
export class FFT {
  readonly size: number
  private readonly rev: Uint32Array
  private readonly cosTable: Float64Array
  private readonly sinTable: Float64Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT 长度必须是 2 的幂：${size}`)
    this.size = size
    const bits = Math.round(Math.log2(size))
    this.rev = new Uint32Array(size)
    for (let i = 0; i < size; i++) this.rev[i] = reverseBits(i, bits)
    this.cosTable = new Float64Array(size / 2)
    this.sinTable = new Float64Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      const angle = (-2 * Math.PI * i) / size
      this.cosTable[i] = Math.cos(angle)
      this.sinTable[i] = Math.sin(angle)
    }
  }

  /** 原地变换：re/im 长度必须等于 size */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1
      const step = n / len
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const c = this.cosTable[k * step]
          const s = this.sinTable[k * step]
          const a = i + k
          const b = a + half
          const tr = re[b] * c - im[b] * s
          const ti = re[b] * s + im[b] * c
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}

function reverseBits(x: number, bits: number): number {
  let r = 0
  for (let i = 0; i < bits; i++) {
    r = (r << 1) | (x & 1)
    x >>= 1
  }
  return r
}

/** 汉宁窗（周期型） */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size)
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  return w
}
