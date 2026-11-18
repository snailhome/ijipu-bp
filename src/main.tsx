/** main.tsx — 挂载入口 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useBp } from './model/store'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('找不到 #root')

/*
 * 开发期后门：把状态仓库挂到 window 上，供 scripts/ui-probe.mjs（走 Chrome
 * DevTools 协议）构造假音频、点画布、读状态来验交互。只在 dev 生效，
 * 生产构建里这段会被摇掉，不留口子。
 */
if (import.meta.env.DEV) {
  ;(window as unknown as { __bp?: typeof useBp }).__bp = useBp
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
