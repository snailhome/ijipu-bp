/**
 * jps/marks.ts — 把一个音的 tick 数翻成简谱的"时值记号"
 *
 * 口径必须和 `jps/toJps.ts` 的 `durationSuffix` 一致，否则流线谱和导出的 jps 会打脸：
 *  · 整拍或更长 → 增时线 `-`（每多一拍一条）
 *  · 1.5 倍 → 附点、1.75 倍 → 双附点
 *  · 其余 → 减时线 `/`（1/8 一条、1/16 两条）
 *
 * 返回的是"画法"（几条减时线 / 几条增时线 / 几个附点），不是文本。
 */
export function marks(ticks: number): { under: number; dash: number; dots: number } {
  let base = ticks
  let dots = 0
  const whole = ticks >= 4 && ticks % 4 === 0
  if (!whole) {
    if (ticks > 1.5 && Number.isInteger(ticks / 1.5)) {
      base = ticks / 1.5
      dots = 1
    } else if (ticks > 1.75 && Number.isInteger(ticks / 1.75)) {
      base = ticks / 1.75
      dots = 2
    }
  }
  const dash = base >= 4 ? base / 4 - 1 : 0
  const under = base >= 4 ? 0 : Math.max(0, Math.round(Math.log2(4 / Math.max(1, base))))
  return { under, dash, dots }
}
