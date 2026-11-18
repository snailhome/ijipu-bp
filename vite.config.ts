/**
 * vite.config.ts — 爱扒谱（iJipu BP）
 *
 * 只跑两件事：React 应用 + `@engine` 别名（指向 vendor 里的 iJipu 引擎源码）。
 * 引擎是**逐字节同步**过来的（scripts/sync-engine.mjs），这里直接编它的 TS 源码，
 * 与 iJipu 应用的做法一致（不走 dist）。
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@engine': at('./vendor/engine/index.ts'),
      '@engine-types': at('./vendor/engine/types.ts'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
})
