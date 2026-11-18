# 爱扒谱（iJipu BP）

把一段音频变成 **iJipu（爱记谱）的 `.jps` 脚本乐谱**：出频谱 → 定调 → 定拍 → 量化成简谱时值 →
导出文本。定位是**人工扒谱的辅助台**，不是"一键完美转谱"。

## 现在能做什么（P0，2026-11-18）

- 打开音频（桌面壳里是系统对话框 + 按路径读字节；浏览器里 `<input type=file>` 降级），
  在 Web Worker 里算 STFT → 对数（半音）频谱（8192 点、汉宁窗、20 帧/秒、每帧方差归一）。
- 单声部旋律提取：每帧取最强半音 → 中值滤波 → 连段 → 合并同音高短间隔。
- 调性分析（Krumhansl 轮廓相关）给 12 个主音的**可能性百分比**；点一下就换调号。
- 节拍：谱通量 + 自相关估 BPM、找首拍；BPM / 拍号 / 首拍都能手改，改完立刻重算。
- 钢琴卷帘上**同时能看音名和简谱数字**；换调号数字同步重算。
- 卷帘下面一行**简谱预览**，直接用 iJipu 引擎渲染 SVG —— 看到的就是交出去的谱。
- 播放：**原音频 / 合成音**一键互换（Tab 热键），播放中切换从当前毫秒续上，用来比对扒得准不准。
- 导出 `.jps`（桌面壳走"另存为 + 写后回读校验"；浏览器直接下载）。

还没做：手动增删/拖动音符、多声部、噪声与打击乐处理、AI 转录（basic-pitch）、SF2 音色库试听。

## 怎么跑

```powershell
cd D:\Coding\JianpuScript\ijipu-bp
npm install --cache "D:/Coding/JianpuScript/.npm-cache"
npm run sync:engine     # 从 ../ijipu 同步引擎（vendor/engine，逐字节）
npm run dev             # 浏览器调试：http://localhost:5174
npm run smoke           # Node 冒烟：FFT/频谱/音高/量化/jps→引擎解析→排版→界面渲染
npm run build           # tsc --noEmit + vite build
npm run tauri:build     # 桌面安装包（需要本机有 Rust 工具链）
```

## 目录

```
src/analysis/   FFT、对数谱、音高名、单声部提取、BPM、调性（纯函数，Node 里可跑）
src/jps/        量化（秒→拍）与生成 jps 文本
src/audio/      解码（Web Audio）+ 播放（原音频 / 引擎 SynthBackend）
src/ui/         频谱、钢琴卷帘、简谱预览
src/model/      zustand 唯一状态源（分析结果 → 参数 → grid → jps）
src/worker/     分析 Worker（不阻塞界面）
src-tauri/      桌面壳：选文件、读字节、另存（就这三个命令）
vendor/engine/  iJipu 引擎快照（禁手改，`npm run sync:engine` 更新）
scripts/        引擎同步、冒烟
```

## 为什么这样分工

- **引擎是 vendor 不是依赖**：`vendor/engine` 从 `../ijipu/packages/ijipu-engine/src/engine` 逐字节同步，
  `vendor/ENGINE-SNAPSHOT.json` 记录源提交与哈希；`npm run check:engine` 一比对就知道有没有被改过。
  这样"我们生成的 jps 对不对"和"iJipu 打开它长什么样"是同一套代码说了算。
- **DSP 全在前端、全是纯函数**：`analyzeSamples(samples, sampleRate)` 只吃 `Float32Array`，
  所以 Node 里能用合成正弦当夹具跑断言（见 `scripts/smoke.ts`）。
- **秒轴与拍轴分开**：分析结果存秒（贴着音频），量化后才变成 tick。改 BPM 不动分析结果。

## 已知限制

- 只做单声部；和弦会被压成一个音。
- 三连音写不进 jps（简谱时值只有 2 的幂 + 附点），量化时按"就近"并给出告警。
- 桌面壳的 Rust 代码在本机**没有编译验证**（这台机器没装 Rust 工具链）；Web 侧
  `typecheck` / `smoke` / `build` 都过了。
