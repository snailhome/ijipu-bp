/**
 * brand/env.ts — 运行环境判定（桌面壳 / 浏览器）
 *
 * 只在本文件里读 `window.__TAURI__`，其它地方一律调这里的函数
 * （与 iJipu 的 src/brand/env.ts 同一口径）。
 */
interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
}

function tauriGlobal(): TauriGlobal | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
}

/** 桌面壳（Tauri）——只有壳里能直接读本地文件 */
export function isTauriShell(): boolean {
  return typeof tauriGlobal()?.core?.invoke === 'function'
}

/** 调 Rust 命令（非壳环境返回 null，调用方走浏览器降级路径） */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> | null {
  const inv = tauriGlobal()?.core?.invoke
  if (!inv) return null
  return inv(cmd, args) as Promise<T>
}
