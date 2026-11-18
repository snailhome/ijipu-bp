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
- 桌面壳支持**命令行带文件**：`ijipu-bp.exe 某曲.mp3` 直接打开（也是自动化验证的入口）。

还没做：手动增删/拖动音符、多声部、噪声与打击乐处理、AI 转录（basic-pitch）、SF2 音色库试听。

## 怎么跑

```powershell
cd D:\Coding\JianpuScript\ijipu-bp
npm install --cache "D:/Coding/JianpuScript/.npm-cache"
npm run sync:engine     # 从 ../ijipu 同步引擎（vendor/engine，逐字节）
npm run dev             # 浏览器调试：http://localhost:5174
npm run smoke           # Node 冒烟：FFT/频谱/音高/量化/jps→引擎解析→排版→界面渲染
npm run fixture         # 造一段已知旋律的 wav（.tmp-melody.wav）
npm run inspect         # 诊断：原始音符 / 量化 / jps / 逐帧峰值
npm run build           # tsc --noEmit + vite build
. .\scripts\tauri-env.ps1   # 桌面构建前先设 Rust 环境（本机工具链在工作区，见下）
npm run tauri:build     # 桌面安装包（本机用 --no-bundle 只出 exe，见"踩过的坑"）
```

桌面构建的环境说明：这台机器**没有 MSVC**，用的是 Rust 的 **GNU 工具链**
（`stable-x86_64-pc-windows-gnu` + winlibs MinGW64 的 gcc），并且
`CARGO_HOME` / `RUSTUP_HOME` 指向工作区里的 `.cargo` / `.rustup`，不在默认的 `~\.cargo`。
`scripts\tauri-env.ps1` 会按脚本位置推导工作区、把这三处设进当前会话；
**不 dot-source 就会出现"cargo 找不到 / 链接器找不到"**。
你自己的机器若有 MSVC（VS Build Tools）+ 默认 rustup，可以完全跳过这一步。

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
- 真曲的参数还没调过：BPM / 首拍 / 静音阈值目前是合成信号上试出来的经验值。
- 桌面壳已在本机编译通过（2026-11-18，GNU 工具链 2m15s / 增量 24s），
  但**安装包没出**：本机 exe 继承工作区的 Low 完整性标签，一启动就崩（见"踩过的坑"）。

## 踩过的坑

**1. 帧时刻要取"窗口中心"。** 8192 点窗长 186ms，若按窗口起点计时，500ms 处换音会被记成
400ms，量化出 `0.75 拍`、末音还要做连音线。现在 `computeSpectrum` 的窗口以帧时刻为中心，
谱上 500ms 换音就是 500ms（`scripts/smoke.ts` 有一条专门守它）。

**2. Low 完整性级别。** 本机 `D:\Coding\JianpuScript` 带 Low 标签，编出来的
`ijipu-bp.exe` 继承 Low，运行时 `Failed to setup app: 拒绝访问。 (os error 5)`（WebView2
建不了用户数据目录）。一次性修（管理员 PowerShell）：

```powershell
icacls "D:\Coding\JianpuScript" /setintegritylevel M /T
```

不提权的临时办法：把 `ijipu-bp.exe` + `WebView2Loader.dll` 拷到 `%LOCALAPPDATA%` 下再跑
（新文件继承 Medium；已实测能开窗、能扒谱）。

**3. GNU 链接器的 `.rsrc merge failure` 警告**（`multiple non-default manifests`）不影响产物，
是 MinGW 嵌资源的老毛病；MSVC 工具链不会出。

**4. 不要用 shell 改含中文的文件。** 工作区规矩：中文文件只用编辑器工具改，`Get-Content | Set-Content`
会把编码改坏。
