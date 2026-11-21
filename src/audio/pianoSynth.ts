/**
 * audio/pianoSynth.ts — 钢琴音色（从 noteDigger 的 TinySynth 移植）
 *
 * 查过了：noteDigger 没有加载 .sf2 / 采样音色库，它用的是自带的 TinySynth
 * （改自 g200kg/webaudio-tinysynth）：128 个 GM 音色全是用两三个振荡器叠出来的"合成音色"。
 * 它听起来比 iJipu 引擎自带的 SynthBackend 更像钢琴，差别就在 GM 1「Acoustic Grand Piano」
 * 的那组参数：一层正弦做主体，一层三角波通过 FM 调制正弦的频率做出击弦的金属感，
 * 再配合击弦后 0.7 秒的指数衰减。这里把这两层照抄了一遍（参数见 LAYERS）。
 */
import { midiToFreq, nameToMidi } from '../analysis/pitchNames'

type Layer = {
  wave: OscillatorType
  /** 相对音量 */
  v: number
  /** 振幅衰减时间常数（秒） */
  d: number
  /** 持续电平（0 = 击弦后衰减到静音） */
  s: number
  /** 0 = 直接出声；1 = 用这个振荡器去 FM 调制上一个振荡器 */
  fm: boolean
  /** 起音时间（秒，只在 FM 层用） */
  a: number
  /** 音量随音高变化（八度指数） */
  k: number
  /** 松手释放（秒） */
  r: number
}

/* GM 1 Acoustic Grand Piano：两层 */
const LAYERS: Layer[] = [
  { wave: 'sine', v: 0.4, d: 0.7, s: 0, fm: false, a: 0, k: 0, r: 0.1 },
  { wave: 'triangle', v: 3, d: 0.7, s: 0.1, fm: true, a: 0.01, k: -1.2, r: 0.05 },
]

type Live = { oscs: OscillatorNode[]; gains: GainNode[] }

/** 只用来发声的小合成器；一个实例一条输出链，stop() 停掉自己排过的所有音 */
export class PianoSynth {
  private ctx: AudioContext
  private out: GainNode
  private comp: DynamicsCompressorNode
  private live = new Set<Live>()

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.out = ctx.createGain()
    this.out.gain.value = 0.55
    this.comp = ctx.createDynamicsCompressor()
    this.out.connect(this.comp)
    this.comp.connect(ctx.destination)
  }

  /** 接口对齐：没有异步资源要等 */
  ready(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * 排一个音。pitch 形如 C5；atMs 相对现在；durMs 按住多久；gain 0.35 是默认力度。
   */
  play(pitch: string | null, atMs: number, durMs: number, gain = 0.35): void {
    if (!pitch) return
    const midi = nameToMidi(pitch)
    if (midi == null) return
    const f0 = midiToFreq(midi)
    const t0 = this.ctx.currentTime + Math.max(0, atMs) / 1000
    const hold = Math.max(0.05, durMs / 1000)
    const vel = Math.max(0.05, Math.min(1, gain / 0.35))
    const oscs: OscillatorNode[] = []
    const gains: GainNode[] = []
    let base: OscillatorNode | null = null

    for (const layer of LAYERS) {
      const osc = this.ctx.createOscillator()
      osc.type = layer.wave
      osc.frequency.value = f0
      const g = this.ctx.createGain()
      const volume =
        (layer.fm ? f0 : 1) * layer.v * vel * (layer.k ? Math.pow(f0 / 261.6, layer.k) : 1)
      if (layer.a > 0) {
        g.gain.setValueAtTime(0, t0)
        g.gain.linearRampToValueAtTime(volume, t0 + layer.a)
        g.gain.setTargetAtTime(layer.s * volume, t0 + layer.a + 0.01, layer.d)
      } else {
        g.gain.setValueAtTime(volume, t0)
        g.gain.setTargetAtTime(layer.s * volume, t0 + 0.01, layer.d)
      }
      if (layer.fm && base) {
        /* FM：这一层的增益接上一个振荡器的 frequency（单位 Hz） */
        g.connect(base.frequency)
      } else {
        g.connect(this.out)
        if (!layer.fm) base = osc
      }
      osc.connect(g)
      osc.start(t0)
      oscs.push(osc)
      gains.push(g)
    }
    const end = t0 + hold
    for (const [i, g] of gains.entries()) {
      g.gain.setTargetAtTime(0, end, LAYERS[i].r)
    }
    for (const osc of oscs) osc.stop(end + 0.6)
    const node: Live = { oscs, gains }
    this.live.add(node)
    const last = oscs[0]
    last.onended = () => {
      for (const g of gains) g.disconnect()
      for (const o of oscs) o.disconnect()
      this.live.delete(node)
    }
  }

  /** 停掉这个实例排过的所有音（播放停止 / 切换模式时） */
  stop(): void {
    for (const { oscs, gains } of this.live) {
      try {
        for (const g of gains) g.gain.cancelScheduledValues(this.ctx.currentTime)
        for (const o of oscs) o.stop()
      } catch {
        /* 已经停了 */
      }
    }
    this.live.clear()
  }
}
