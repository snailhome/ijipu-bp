# AGENTS.md（ijipu-bp / 爱扒谱）

> 本仓库是**独立工具**：音频扒谱 → 产出 `.jps`。谱面编辑、出片、卡片模板都不在这里。

## 一、边界

1. **只做"从声音到 jps"这一段**：解码、频谱、定调、定拍、量化、生成文本、导出。
   不做谱面编辑（那是 iJipu 应用）、不做视频/出片（那是 ijipu-cp）。
2. 产出必须是**引擎认的** jps：每次生成都要过 `parseJps` + `layoutScore` 两道闸门
   （`scripts/smoke.ts` 已守）。找不到引擎能表达的写法时，**宁可就近取整并告警**，
   也不要造语法。
3. 失败要说人话：错误信息进状态栏，中文、带原因（例如"读不到文件 X：拒绝访问"）。

## 二、引擎是 vendor 不是依赖（硬规则）

- `vendor/engine/` 从 `../ijipu/packages/ijipu-engine/src/engine` **逐字节同步**，
  **禁止手改**。要用新导出、修引擎 bug，回 `../ijipu` 改，再：

  ```powershell
  npm run sync:engine     # 覆盖 vendor/engine 并写 ENGINE-SNAPSHOT.json
  npm run check:engine    # 只比对；哈希不一致即红
  ```

- 新增引擎导出时，同步更新 `src/preview/jpsSvg.ts` 等处的 import 与本文的"依赖面"说明。
- 引擎代码是纯 TS、零 React/DOM；**不要在 vendor 里加 UI 或 Node API**。

## 三、开工与收工

开工先跑一遍基线：

```powershell
npm run typecheck
npm run smoke
```

改完再跑一遍，加 `npm run build`；动了 vendor 还要 `npm run check:engine`。

**负向判据**（只跑通不算过）：

- `smoke` 输出必须是 `24/24 通过`（数字随用例增加而变，但**不许有 ✗**）；
- `check:engine` 必须是"哈希一致"，出现差异说明 vendor 被改过；
- `jps` 用例里 `parseJps` 的错误数必须是 0（不是"能渲染就行"）；
- 生成物里**不许出现连音线包出来的碎时值**（例如本该 1 拍却写成 `( 1 1/ )`）：
  出现就说明帧时刻/掐边有问题，先跑 `npm run inspect` 看原始音符。

## 四、代码约定

- TS strict；2 空格、无分号、单引号；`import type` 分开写；文件头一段中文说明"这个文件为什么存在"。
- 界面文案集中在 `src/brand/copy.ts`；色值走 `src/styles.css` 的 CSS 变量。
- 函数单职责，尽量 ≤50 行；纯计算放 `src/analysis`、`src/jps`（不许碰 DOM），
  这样 Node 冒烟才盖得到。
- 只在本文件之外读 `window.__TAURI__` 的**唯一入口**是 `src/brand/env.ts`。
- 播放头由 `AudioContext.currentTime` 推算，**不要用 rAF 累加时间**（会漂）。
- 版本号三处一致：`package.json`、`src-tauri/tauri.conf.json`、`src/brand/version.ts`。
- **扒谱主界面是 `src/ui/NoteRoll.tsx` 的"音高 × 时间"表格**（用户 2026-11-18 明确要求：
  不要带状波形，要 noteDigger 那种左侧钢琴键盘 + 横向时间轴 + 纵向音名，点格子能试听）。
  改这个组件就是改产品的主交互，动手前先想清楚"扒谱要反复核对：听原音频 → 定音高/时值 →
  听合成音 → 改"这条闭环是否仍然成立；改完同步更新 `README.md` 的交互清单与本文件。
- 音符**以 `store.notes`（秒轴、可编辑）为准**，`analysis.notes` 只是初稿；
  别把 `analysis.notes` 直接画到界面或喂给播放（否则人工改动白做）。

## 五、提交

- 小步、中文提交信息；**不 push、不打 tag**（除非用户明说）。
- 提交前：`npm run typecheck` + `npm run smoke`；动过 vendor 加 `npm run check:engine`。

## 六、Windows 完整性提醒（本机已实测踩过）

如果 exe 出现"只能写自己的 `out`、写别处报 `拒绝访问 (os error 5)`"，先查完整性级别再怀疑杀软：

```powershell
icacls ".\src-tauri\target\release\ijipu-bp.exe" | findstr /i "Mandatory"   # 应为 Medium
```

本机工作区目录带 **Low** 标签，编出来的 exe 会继承 Low，**一启动就崩**：

```text
Failed to setup app: 拒绝访问。 (os error 5)
```

一次性修法（要管理员 PowerShell，普通权限改不了标签）：

```powershell
icacls "D:\Coding\JianpuScript" /setintegritylevel M /T
```

不想提权时的临时办法：把 `ijipu-bp.exe` 与 `WebView2Loader.dll` 一起拷到
`%LOCALAPPDATA%` 下（新文件继承 Medium）再运行。

## 七、诊断工具与两种调试方式

```powershell
npm run fixture               # 造一段已知旋律的 wav（C4 E4 G4 C5 各 500ms）
npm run inspect               # 打印"原始音符 / 量化 / jps / 逐帧峰值"
npm run inspect -- 某曲.wav    # 同上，换成真曲子（只认 16-bit PCM wav）
.\tauri-dev.bat               # 桌面壳热更新调试（自动设好 CARGO_HOME/RUSTUP_HOME/PATH）
.\tauri-dev.bat --check       # 只体检环境（cargo/npm 版本 + cargo metadata），不启动
```

分析结果不对时**先跑 inspect**：时值怪、音高错、BPM 离谱，都能在那四段里看出是哪一步。

改界面时优先 `npm run dev`（浏览器，秒级）；只有"要系统对话框 / 要真 exe / 要窗口图标"时才用
`tauri-dev.bat`——Rust 侧一次冷编译约 2 分钟，改了前端不会重编 Rust。

## 八、图标（一处源图，四处生效）

源图 `D:\Coding\JianpuScript\矢量图\Logo-bp.png`。窗口/任务栏图标在 `src-tauri/src/lib.rs`
的 `.setup()` 里 `win.set_icon(...)`（注意：tauri 2.12 **没有** `Builder::icon`，且 `Cargo.toml`
要开 `features = ["image-png"]`）；exe 图标来自 `src-tauri/icons/icon.ico`（`tauri icon` 生成）；
界面里是 `public/icons/Logo-bp.png`。换图要**两处都更新**再重编，否则会出现"exe 换了、标题栏没换"。
