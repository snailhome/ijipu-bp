# 爱扒谱（iJipu BP）

把一段音频变成 **iJipu（爱记谱）的 `.jps` 脚本乐谱**：出频谱 → 定调 → 定拍 → 量化成简谱时值 →
导出文本。定位是**人工扒谱的辅助台**，不是"一键完美转谱"。

## 现在能做什么（P0，2026-11-18）

- 打开音频（桌面壳里是系统对话框 + 按路径读字节；浏览器里 `<input type=file>` 降级），
  在 Web Worker 里算 STFT → 对数（半音）频谱（8192 点、汉宁窗、20 帧/秒、每帧方差归一）。
- 单声部旋律提取：每帧先做**谐波求和**（泛音也算这个基频的分），再用 **Viterbi** 在 88 个半音里找
  一条最省代价的轨迹（跳变代价表里八度便宜、半音贵）→ 连段 → 掐掉首尾的"拖音"。
- 调性分析（Krumhansl 轮廓相关）给 12 个主音的**可能性百分比**；点一下就换调号。
- 节拍：谱通量 + 自相关估 BPM、找首拍；BPM / 拍号 / 首拍都能手改，改完立刻重算。
- **音符表（钢琴卷帘）**：左边钢琴键盘、横向时间轴、纵向音名 —— 一个音就是某一行里的一格。
  上面同时能看音名和简谱数字（换调号数字同步重算）。
- **人工核对闭环**（这块是扒谱的主场，不是附属功能）：
  - 点空格子 → 播放头挪过去 + **响这个音高**（合成音试听）；
  - 在空格子上按住拖 → 直接画一个音；拖音符中间 → 改音高/位置；拖右边缘 → 改时值；
  - Delete / 右键 → 删；上下方向键 → 改半音；「回到初稿」→ 丢掉手工改动回到分析结果；
  - 滚轮 → 上下换音区。
- 卷帘下面一行**简谱预览**，直接用 iJipu 引擎渲染 SVG —— 看到的就是交出去的谱。
- 播放：**原音频 / 合成音**一键互换（Tab 热键），播放中切换从当前毫秒续上，用来比对扒得准不准。
- 导出 `.jps`（桌面壳走"另存为 + 写后回读校验"；浏览器直接下载）。
- 桌面壳支持**命令行带文件**：`ijipu-bp.exe 某曲.mp3` 直接打开（也是自动化验证的入口）。

还没做：多声部、撤销/重做、吸附开关（现在画出来的音按拍量化但不吸附鼠标）、
噪声与打击乐处理、AI 转录（basic-pitch）、SF2 音色库试听、`.jps.sync.json` 边车。

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

**只想调界面/逻辑**：`tauri-dev.bat` 双击就跑（等价于设好三处环境后 `npm run tauri:dev`），
带热更新、改前端不用重编译 Rust；`tauri-dev.bat --check` 只体检环境不启动。
**只想在浏览器里看**：`npm run dev` 后开 http://localhost:5174 —— 浏览器模式下"打开音频"走文件选择框、
导出走 Blob 下载，其余（频谱/卷帘/简谱/播放）与桌面端同一套代码。

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

## 图标（标题栏 / 窗口 / exe / 快捷方式 / 界面里，都是同一张）

源图在 `D:\Coding\JianpuScript\矢量图\Logo-bp.png`（"123" 青绿 + "BP" 黄）。四处来源一致：

| 用在哪儿 | 由什么决定 |
|---|---|
| 窗口标题栏、任务栏 | `src-tauri/src/lib.rs` 的 `.setup()` 里 `win.set_icon(...)`，读 `public/icons/Logo-bp.png` |
| 顶栏品牌 | `src/App.tsx` 的 `<img className="brand-logo" src="/icons/Logo-bp.png">` |
| exe 文件图标 | `src-tauri/icons/icon.ico`（编译期由 tauri-build 嵌进 exe） |
| 安装包快捷方式 | 沿用 exe 图标，无需另设 |
| 浏览器标签页 | `index.html` 的 `<link rel="icon">` |

换图流程（两处都要跑，否则会出现"exe 换了、标题栏没换"）：

```powershell
npm run tauri -- icon "D:\Coding\JianpuScript\矢量图\Logo-bp.png" --fit contain   # 生成 src-tauri/icons/*
Copy-Item "D:\Coding\JianpuScript\矢量图\Logo-bp.png" public\icons\Logo-bp.png -Force
npm run tauri:build -- --no-bundle   # 重编后 exe 图标才变
```

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

**4. `tauri::Builder::icon()` 在 tauri 2.12 里没有这个方法。** 想换窗口/任务栏图标不能链在
builder 上（编译报 `no method named 'icon'`），要在 `.setup()` 里拿窗口再设：

```rust
if let Some(win) = app.get_webview_window("main") {
    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../../public/icons/Logo-bp.png")) {
        let _ = win.set_icon(icon);
    }
}
```

需要 `use tauri::Manager;`，并在 `Cargo.toml` 打开 `tauri = { version = "2", features = ["image-png"] }`
（不开这个 feature 解不了 png）。

**5. `tauri icon` 要求正方形图。** `Logo-bp.png` 是 1673×1669，差 4 像素会被拒：
```powershell
npm run tauri -- icon "D:\Coding\JianpuScript\矢量图\Logo-bp.png" --fit contain
```

**6. 不要用 shell 改含中文的文件。** 工作区规矩：中文文件只用编辑器工具改，`Get-Content | Set-Content`
会把编码改坏。
