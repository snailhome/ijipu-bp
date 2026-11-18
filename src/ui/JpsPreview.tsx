/**
 * ui/JpsPreview.tsx — 表格下面那一行简谱（走 iJipu 引擎渲染）
 *
 * 与 iJipu 应用里打开同一份 jps 得到的是**同一个**排版结果：同一套 layoutScore /
 * renderScoreToSvg。所以这里看到的就是交出去的谱。
 */
import { useMemo } from 'react'
import { jpsToSvgPages } from '../preview/jpsSvg'
import { COPY } from '../brand/copy'

export function JpsPreview({ jps }: { jps: string }) {
  const { pages, errors } = useMemo(() => jpsToSvgPages(jps), [jps])

  return (
    <div className="pane preview" style={{ flex: '1 1 26%', minHeight: 190 }}>
      <div className="pane-head">{COPY.previewTitle}</div>
      <div className="jps">
        {pages.length > 0 ? (
          <div dangerouslySetInnerHTML={{ __html: pages[0] }} />
        ) : (
          <div className="hint" style={{ padding: 8 }}>
            还没有音符，谱面空着。
          </div>
        )}
        {errors.length > 0 && (
          <div className="err" style={{ padding: '6px 8px' }}>
            {errors.slice(0, 3).map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
