/**
 * ui/noteLanes.ts — 同一音高行里重叠的音符分"车道"（纯函数，冒烟可测）
 *
 * 为什么要有（用户 m00741）：分析/量化之后，可能出现同一音高、同一时刻的两个音
 * （两段音被四舍五入到同一个 tick），以前都画在行的同一位置，后画的把先画的完全盖住，
 * 用户既看不见，也没法比较、删除。现在把"时间上撞在一起"的音在行内上下错开画。
 *
 * 口径：
 *  1. 只按音高分行（不同音高本来就画在不同行，不做车道切分）。
 *  2. 同一行里，起点递增地扫；"这一簇"的结束 = 簇内最晚的 endMs。
 *     下一个音 startMs >= 簇结束 → 不撞车，另起一簇，回到整车道的整行高度。
 *  3. 一簇内部贪心分车道：放进第一条"已经空出来"（end <= start）的车道；
 *     都占着就新开一条。首尾相接（end === start）算空出来，不算撞车。
 *
 * 结果给 NoteRoll 画音符和命中判定共用，保证"看见哪条就能点哪条"。
 */
import type { RawNote } from '../model/types'

export interface LaneSpot {
  /** 第几条车道（0 起，从上往下） */
  lane: number
  /** 这一簇一共几条车道（决定每条画多高） */
  lanes: number
}

/** 给每个音算它在该音高行里的车道；没有撞车的音返回 { lane: 0, lanes: 1 } */
export function assignLanes(notes: readonly RawNote[]): Map<string, LaneSpot> {
  const byMidi = new Map<number, RawNote[]>()
  for (const n of notes) {
    const arr = byMidi.get(n.midi)
    if (arr) arr.push(n)
    else byMidi.set(n.midi, [n])
  }

  const out = new Map<string, LaneSpot>()
  for (const arr of byMidi.values()) {
    const sorted = [...arr].sort(
      (a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )

    let group: RawNote[] = []
    let groupEnd = -Infinity
    const flush = (): void => {
      if (group.length === 0) return
      const laneEnds: number[] = []
      const laneOf = new Map<string, number>()
      for (const n of group) {
        let lane = laneEnds.findIndex((end) => end <= n.startMs)
        if (lane < 0) {
          lane = laneEnds.length
          laneEnds.push(n.endMs)
        } else {
          laneEnds[lane] = n.endMs
        }
        laneOf.set(n.id, lane)
      }
      const lanes = laneEnds.length
      for (const n of group) out.set(n.id, { lane: laneOf.get(n.id) ?? 0, lanes })
      group = []
      groupEnd = -Infinity
    }

    for (const n of sorted) {
      if (group.length > 0 && n.startMs >= groupEnd) flush()
      group.push(n)
      if (n.endMs > groupEnd) groupEnd = n.endMs
    }
    flush()
  }
  return out
}
