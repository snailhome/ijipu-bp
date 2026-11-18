/**
 * vite.inspect.config.ts — 把 `scripts/inspect.ts` 打成能在 Node 里跑的 cjs
 *
 * 和 vite.smoke.config.ts 一个套路（工作区禁用 tsx/ts-node，只能"Vite 打一份、Node 跑"）。
 * 区别只在于产物是诊断工具而不是断言：`npm run inspect`。
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
    outDir: 'dist-inspect',
    emptyOutDir: true,
    minify: false,
    ssr: true,
    lib: {
      entry: at('./scripts/inspect.ts'),
      formats: ['cjs'],
      fileName: () => 'inspect.cjs',
    },
    rollupOptions: {
      external: [/^node:/],
    },
  },
})
