/**
 * model/recording.ts — 「录音成谱」的纯口径（adj? / 用户 2026-11-22）
 *
 * 录音还没保存成音频文件时，方案里得有一个**路径**才能参与缓存/脏标记/状态栏；
 * 这里用 `recording:<时间>` 作为**合成路径**：
 *  · 它不是真实文件，`saveProject` 不能往它旁边写 `.bp.json`（保存走"先存音频"）；
 *  · 只有 `isRecordingPath()` 认它，别处不要按字符串前缀乱判。
 *
 * 抽成纯函数是为了 smoke 能直接断言（不碰 DOM / 麦克风）。
 */

export const RECORDING_PATH_PREFIX = 'recording:'

/** 这个路径是不是"还没保存成音频的录音"（合成路径） */
export function isRecordingPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(RECORDING_PATH_PREFIX)
}

/** 录音方案的名字：`录音 2026-11-22 21-05-38`（本地时间，文件名安全） */
export function formatRecordingName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `录音 ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}-${p(
    date.getMinutes(),
  )}-${p(date.getSeconds())}`
}

/** 名字 → 合成路径（只用于"还没保存"的录音方案） */
export function recordingPathOf(name: string): string {
  return `${RECORDING_PATH_PREFIX}${name}`
}

/** 保存音频时的建议文件名（保证 `.wav` 后缀、去掉路径分隔符） */
export function recordingSaveName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\.wav$/i, '').trim() || '录音'
  return `${base}.wav`
}
