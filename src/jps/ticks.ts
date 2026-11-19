/**
 * jps/ticks.ts — 拍轴最小单位
 *
 * 单独一层是为了打破依赖环：`quantize` 要按小节统计总小节数（`bars.ts`），
 * 而 `bars.ts` 又要用"每拍几 tick"。常量放这里，两边都引它，谁也不用引谁。
 */

/** 每拍多少 tick（1 tick = 1/4 拍 = 16 分音符） */
export const TICKS_PER_BEAT = 4
