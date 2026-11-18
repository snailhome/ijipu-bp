/**
 * preview/jpsSvg.ts — 把 jps 文本渲成简谱 SVG（直接用 iJipu 引擎）
 *
 * 这是"我们的引擎比它强"的地方之一：noteDigger 只画自己的钢琴卷帘，
 * 我们画完音符就能看到**真正要交出去的那份简谱**——同一份 jps、同一个引擎，
 * 应用里看到的和 iJipu 里打开的是同一个东西。
 */
import { layoutScore, parseJps, renderScoreToSvg } from '@engine'
import { defaultPageConfig, type PageConfig } from '@engine-types'

export interface PreviewResult {
  pages: string[]
  errors: string[]
}

/** 出 SVG（每页一个字符串；预览条只显示第一页） */
export function jpsToSvgPages(jps: string, overrides: Partial<PageConfig> = {}): PreviewResult {
  if (!jps.trim()) return { pages: [], errors: [] }
  const parsed = parseJps(jps)
  const config: PageConfig = { ...defaultPageConfig, ...overrides }
  const layout = layoutScore(parsed, config)
  return {
    pages: renderScoreToSvg(layout),
    errors: parsed.errors.map((e) => (typeof e === 'string' ? e : (e.message ?? ''))),
  }
}
