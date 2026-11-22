/**
 * ui/selection.ts — 框选三种模式的**纯计算**（用户 2026-11-22，参考 NoteDigger）
 *
 * NoteDigger 的选择工具是"在空白处按下拖一个框，松手时选框里的音"：
 *  · `block` 块选：矩形框——音的**起点**落在时间范围里、音高落在音高范围里；
 *  · `col`   列选：只按时间——音的**时值区间与选中时间重叠**就选（长音跨过整列也算）；
 *  · `row`   行选：只按音高——同一行的音全选（不看时间）。
 *
 * 纯函数，不碰 DOM / canvas；NoteRoll 只负责把像素换成"时间 + 音高"两段范围。
 */
import type { RawNote } from '../model/types'
import type { SelMode } from '../model/store'

export interface SelectionRange {
  mode: SelMode
  /** 时间范围（毫秒；端点顺序无所谓，函数里会归一化） */
  startMs: number
  endMs: number
  /** 音高范围（含端点；端点顺序无所谓） */
  midiLo: number
  midiHi: number
}

/** 按三种模式挑出选中的音符 id；空范围返回空数组 */
export function selectNotes(notes: readonly RawNote[], range: SelectionRange): string[] {
  const t0 = Math.min(range.startMs, range.endMs)
  const t1 = Math.max(range.startMs, range.endMs)
  const m0 = Math.min(range.midiLo, range.midiHi)
  const m1 = Math.max(range.midiLo, range.midiHi)
  return notes
    .filter((n) => {
      if (range.mode === 'row') return n.midi >= m0 && n.midi <= m1
      if (range.mode === 'col') {
        /* 列选看时值重叠：起点在范围内、或尾端越过起点、或整段跨过范围 */
        return n.startMs <= t1 && n.endMs >= t0
      }
      /* 块选看"音头"（NoteDigger 的口径：x1 落在框里），音高也必须在行范围内 */
      return n.startMs >= t0 && n.startMs <= t1 && n.midi >= m0 && n.midi <= m1
    })
    .map((n) => n.id)
}
