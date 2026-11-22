/**
 * brand/links.ts — 跨站链接：回爱记谱首页 / 在爱记谱打开当前 jps
 *
 * 为什么单独放这里：
 *  · 爱记谱首页与 `/app/?jps=` 的地址是**外部站点约定**，集中一处，换域名只改这里；
 *  · `JPS_LINK_MAX_LEN` 必须与 iJipu `store/urlImport.ts` 的 `JPS_PARAM_MAX_LEN` 一致
 *    （都是 8000 个源码字符），否则 bp 生成一个"看着能开、实际被应用忽略"的链接。
 *
 * 注意：`?jps=` 带的是**当前生成的 .jps 源码**；导出的 .jps 文件本身仍是纯文本，
 * 链接方式是在 UI 里点「在爱记谱打开」时现拼的。
 */
export const IJIPU_SITE = 'https://ijipu.pages.dev'
export const IJIPU_APP = `${IJIPU_SITE}/app/`

/** 与 iJipu `JPS_PARAM_MAX_LEN` 对齐：超过这个字符数的源码，链接导入会被应用忽略 */
export const JPS_LINK_MAX_LEN = 8000

/** 用 iJipu 的 `/app/?jps=<encoded>` 方式打开一段 .jps 源码 */
export function jpsAppUrl(text: string): string {
  return `${IJIPU_APP}?jps=${encodeURIComponent(text)}`
}
