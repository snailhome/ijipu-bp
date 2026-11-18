/**
 * vite.smoke.config.ts — 把 `scripts/smoke.ts` 打成一个能在 Node 里跑的 cjs
 *
 * 为什么不用 tsx / ts-node：工作区约定禁用（AGENTS）；
 * 为什么不在 Node 里直接跑 TS：Node 的类型剥离要求 import 带 `.ts` 后缀，应用代码里到处要改。
 * ⇒ 跟 iJipu 一样走"Vite 打一份、Node 跑"：`npm run smoke`。
 */
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@engine': at('./vendor/engine/index.ts'),
      '@engine-types': at('./vendor/engine/types.ts'),
    },
  },
  build: {
    outDir: 'dist-smoke',
    emptyOutDir: true,
    minify: false,
    ssr: true,
    lib: {
      entry: at('./scripts/smoke.ts'),
      formats: ['cjs'],
      fileName: () => 'smoke.cjs',
    },
    rollupOptions: {
      external: [/^node:/],
    },
  },
})
