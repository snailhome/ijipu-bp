/**
 * preview/stripSvg.ts — 用引擎把当前视窗里的谱排成一条「流线谱」SVG
 *
 * 为什么走引擎：以前 `ui/StripPreview.tsx` 自己画数字、减时线、八度点、附点、连音弧，
 * 等于把引擎的谱面规范又抄了一遍，两边迟早对不上。现在改成：
 *   1. 只取视窗附近几小节的音符，`toJps` 成一小段 jps（口径仍由 `jps/toJps.ts` 管）；
 *   2. `parseJps` → `layoutScore` → `buildPlaySequence` → `buildLinearStrip`
 *      让引擎把这一小段排成一条单行谱（字形/减时线/八度点/变音/附点/连音线全由引擎画）；
 *   3. `renderScoreToSvg` 出 SVG，宿主只负责把这条谱**按时间轴**摆到对应位置。
 *
 * 时间对齐：`buildLinearStrip` 的 `timedStretch` 会把每小节拉成「拍数 × 每拍像素」，
 * 所以每根小节线都正好落在时间轴的小节起点上；小节内部音符的位置由引擎按拍缩放。
 *
 * ⚠ 引擎的 `k = Math.max(1, …)` 不允许把小节压得比自然排版更窄。
 * 缩得很小（一屏几十秒）时用「参考每拍像素」排一遍再整体等比缩小，
 * 这样小节线仍然对得上时间轴，只是整条谱一起变小。
 */
import {
  buildLinearStrip,
  buildPlaySequence,
  layoutScore,
  parseJps,
  renderScoreToSvg,
} from '@engine'
import { defaultPageConfig, type PageConfig, type ScoreLayout } from '@engine-types'
import { barBeats, barStartTick } from '../jps/bars'
import { TICKS_PER_BEAT } from '../jps/ticks'
import { toJps, type JpsOptions } from '../jps/toJps'
import type { GridNote } from '../model/types'

/** 流线谱字号（比排版页大一点，预览条里才看得清） */
export const STRIP_NOTE_SIZE = 18

export interface StripImage {
  /** 一段完整的 `<svg …>` */
  svg: string
  /** 这条谱的原始宽高（CSS 像素） */
  width: number
  height: number
  /** 画的时候再乘这个系数（缩得很小时 < 1，正常是 1） */
  scale: number
  /** 图左缘对应的时间（毫秒） */
  startMs: number
  /** 从第几小节开始（0 起） */
  barFrom: number
}

export interface StripImageOptions {
  grid: GridNote[]
  /** jps 头信息（标题/调/BPM/拍号/弱起）与音符同源 */
  jps: JpsOptions
  /** 视窗左边缘/右边缘（毫秒），用来决定取哪几小节 */
  fromMs: number
  toMs: number
  /** 目标：每拍多少像素（= 屏幕上一拍的实际宽度） */
  pxPerBeat: number
  /** 视窗右边多留一小节，滚动时不会看到半截空白 */
  marginBars?: number
}

function beatsOf(srcBar: number, pickup: number, per: number): number {
  /* srcBar 是引擎条带里的 1 基小节号 */
  return barBeats(srcBar - 1, { beatsPerBar: per, pickupBeats: pickup })
}

/**
 * 造一张流线谱图；没有音符、或这一小段 jps 过不了引擎的解析就看不出东西，返回 null。
 */
export function buildStripImage(opts: StripImageOptions): StripImage | null {
  const { grid, jps } = opts
  if (grid.length === 0) return null

  const per = Math.max(1, Math.round(jps.beatsPerBar))
  const pickup = Math.max(0, Math.min(per - 1, Math.round(jps.pickupBeats ?? 0)))
  const barOpt = { beatsPerBar: per, pickupBeats: pickup }
  const beatMs = 60000 / Math.max(20, jps.bpm)
  const tickMs = beatMs / TICKS_PER_BEAT

  const tickFrom = Math.max(0, (opts.fromMs - jps.firstBeatMs) / tickMs)
  const tickTo = Math.max(tickFrom + 1, (opts.toMs - jps.firstBeatMs) / tickMs)

  /* 取整小节：多留一小节，避免滚动时右边缘突然空一截 */
  const margin = Math.max(0, opts.marginBars ?? 1)
  const maxBar = Math.max(0, ...grid.map((n) => barIndexOfTick(n.startTick + n.ticks - 1, barOpt)))
  const barFrom = Math.max(0, barIndexOfTick(tickFrom, barOpt) - margin)
  const barTo = Math.max(barFrom, Math.min(maxBar, barIndexOfTick(tickTo, barOpt) + margin))

  const offsetTick = barStartTick(barFrom, barOpt)
  const endTick = barStartTick(barTo + 1, barOpt)
  const slice = grid
    .filter((n) => n.startTick >= offsetTick && n.startTick < endTick)
    .map((n) => ({ ...n, startTick: n.startTick - offsetTick }))
  if (slice.length === 0) return null

  /* 这一小段自己的 jps：第一小节若是整首的开头才带弱起 */
  const subPickup = barFrom === 0 ? pickup : 0
  const text = toJps(slice, {
    ...jps,
    firstBeatMs: 0,
    pickupBeats: subPickup,
  })

  const parsed = parseJps(text)
  if (parsed.errors.length > 0) return null

  /* 时值优先排版：音符宽度与拍数成正比，按时间轴拉伸后每个音才落在它该响的时刻。
   * 空间优先（引擎默认）会把音符挤在左边、右边留白，伸得再准也会整体偏晚（实测 1 拍差 22px+）。 */
  const config: PageConfig = { ...defaultPageConfig, note_size: STRIP_NOTE_SIZE, noteSpaceLayout: 'duration' }
  const layout = layoutScore(parsed, config)
  const seq = buildPlaySequence(parsed, layout, jps.bpm)

  /* 先按自然排版量一遍：引擎的 k 不能小于 1，缩得比自然宽还小时要整体等比缩 */
  const natural = buildLinearStrip(layout, seq, config, {
    timedStretch: false,
    lyrics: false,
    barNumbers: false,
  })
  let naturalPerBeat = 0
  for (const run of natural.runs) {
    const beats = beatsOf(run.sourceBar, subPickup, per)
    const w = Math.max(1, run.x1 - run.x0)
    naturalPerBeat = Math.max(naturalPerBeat, w / Math.max(1, beats))
  }
  naturalPerBeat = Math.max(8, naturalPerBeat)

  const stretch = opts.pxPerBeat >= naturalPerBeat
  const refPx = stretch ? opts.pxPerBeat : naturalPerBeat
  const strip = buildLinearStrip(layout, seq, config, {
    timedStretch: true,
    pxPerBeat: refPx,
    lyrics: false,
    barNumbers: false,
  })

  const scale = stretch ? 1 : opts.pxPerBeat / refPx
  const onePage: ScoreLayout = { ...layout, pages: [strip.page] }
  const svg = renderScoreToSvg(onePage)[0]
  if (!svg) return null

  return {
    svg,
    width: strip.width,
    height: strip.height,
    scale,
    startMs: jps.firstBeatMs + barStartTick(barFrom, barOpt) * tickMs,
    barFrom,
  }
}

/** tick 落在第几小节（0 起）——只在这里用一下，避免再引一个导出 */
function barIndexOfTick(tick: number, opt: { beatsPerBar: number; pickupBeats: number }): number {
  const per = Math.max(1, Math.round(opt.beatsPerBar))
  const first = barBeats(0, opt) * TICKS_PER_BEAT
  const t = Math.max(0, tick)
  return t < first ? 0 : 1 + Math.floor((t - first) / (per * TICKS_PER_BEAT))
}
