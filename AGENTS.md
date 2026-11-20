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
- 版本号由 `scripts/auto-version.mjs` 在打包前自动升（见 §九），**不要手改**；
  需要核对时看 `package.json`、`src-tauri/tauri.conf.json`、`src/brand/version.ts` 三处是否一致。
- **扒谱主界面是 `src/ui/NoteRoll.tsx` 的"音高 × 时间"表格**（用户 2026-11-18 明确要求：
  不要带状波形，要 noteDigger 那种左侧钢琴键盘 + 横向时间轴 + 纵向音名，点格子能试听）。
  改这个组件就是改产品的主交互，动手前先想清楚"扒谱要反复核对：听原音频 → 定音高/时值 →
  听合成音 → 改"这条闭环是否仍然成立；改完同步更新 `README.md` 的交互清单与本文件。
- 音符**以 `store.notes`（秒轴、可编辑）为准**，`analysis.notes` 只是初稿；
  别把 `analysis.notes` 直接画到界面或喂给播放（否则人工改动白做）。
- 音符有 `confirmed` 一栏：**只有确认过的音**才进 `grid`/`jps`/预览（用户口径"输出以绘制所选的音为准"）。
  新增任何"导出/预览"路径都要经过 `derive()` 里的 `confirmed` 过滤，别绕过它。
- **键盘形制已冻结**（用户 2026-11-19 明确："按现在的方案固化下来，键盘格的形制不要再随意改动"）：
  每半音一行、**同一屏里行高一律相同**（就是 `store.rowH`，默认 14px，设置里 10–26px 可调，
  用户 m02483 要求能调高矮）；黑键 I 形贴右、宽 62%；分界只有两种 —— 黑键行在**竖直中心**
  画一条短线（从左边界到黑键左缘），E|F 与 B|C 之间在 E / B 的**上边界**通栏；
  高亮白键要按 L / J / T 形状（左块伸进相邻黑键格半格），黑键只染自己那块。
  要动这套几何，先把这条规则改了并说明原因，别直接改画法。
  **画的时候一律用"一行 = 一个 rowH"来算，不许在组件里写死 14。**
- **显示尺寸三项**（用户 m02483）：`store.rowH`、`store.pageSec`（一屏几秒，真正的视野仍以
  `view.zoom` 为准）、`store.topMidi`（表格第一行的音高）。三者都落 localStorage
  （`bp.rowH` / `bp.pageSec` / `bp.topMidi`），**不进方案文件**；只在 store 里改，别在组件里另存一份。
  设置页与右栏「显示」组共用同一份 state，两处滑条改的是同一个值。
- **和弦分析**（用户 m02483，从 noteDigger 的 `plugins/chordEst.js` 复刻）：`src/analysis/chords.ts`
  是纯函数（频谱 → chroma → 169 个状态的和弦模板匹配 → HMM + Viterbi），在 worker 里以
  `kind: 'chords'` 跑，结果进 `store.chords`，**只画在表格底部那条带子里当提示，不进 jps、不进方案**。
  改 chroma / 模板 / 转移规则，必须同步跑 `smoke` 的 C/F 用例和 `probe` 的「C→F 真实和弦」用例；
  换轨或重新分析时 `setAnalysis` 会清空旧和弦。
- 键上文字（音名 / 简谱数字）**只写白格行**，位置取白键左块的竖直正中（`(t + b) / 2`）。
- **流线谱（`src/ui/StripPreview.tsx`）的曲谱字形必须交给引擎**（用户 m02192）：`preview/stripSvg.ts`
  取视窗附近几小节 `toJps` → `parseJps` → `layoutScore`（`noteSpaceLayout:'duration'`）→
  `buildLinearStrip`（`timedStretch:true`）→ `renderScoreToSvg`，宿主只按 `ui/timeAxis.ts`
  的映射把整条谱摆到时间轴上；左边留 66px（与音符表键盘列同宽）。**不要再在 canvas 里手画
  数字/减时线/八度点/附点/连音弧** —— 那等于把引擎规范抄一遍，两边必然对不上。canvas 只画
  小节号、播放头、空谱提示。要改宽度映射就**两处一起改**。

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

**动过工具条/画布交互，必须再跑 `npm run probe`**（另开终端先 `npm run dev`）：
它用 Chrome 调试协议真的点按钮、点画布，再读 `window.__bp` 核对状态。
`smoke` 只能盖纯函数，盖不到"事件挂错地方"这类错（iJipu 那边 adj959 就栽在这上面）。
`src/main.tsx` 里 `if (import.meta.env.DEV) window.__bp = useBp` 是给它的后门，**只在 dev 生效**，
不要为了测试把它带到生产，也不要在别处再挂第二个全局。

## 八、图标（一处源图，四处生效）

源图 `D:\Coding\JianpuScript\矢量图\Logo-bp.png`。窗口/任务栏图标在 `src-tauri/src/lib.rs`
的 `.setup()` 里 `win.set_icon(...)`（注意：tauri 2.12 **没有** `Builder::icon`，且 `Cargo.toml`
要开 `features = ["image-png"]`）；exe 图标来自 `src-tauri/icons/icon.ico`（`tauri icon` 生成）；
界面里是 `public/icons/logo-bp.png`。换图要**两处都更新**再重编，否则会出现"exe 换了、标题栏没换"。

## 九、应用名与版本号（用户 2026-11-19 定，各子应用统一）

- **安装目录 / 安装包名 = `productName`**：本应用是 `iJipuBP`（不再是「爱扒谱」）。
  显示名（顶栏、窗口标题、开始菜单快捷方式）仍是「爱扒谱 · iJipu BP」，别改。
- **exe = Cargo 包名**：本应用 `ijipu-bp` → `ijipu-bp.exe`（不要改成带点的 `iJipuBP.exe`）。
- **图标文件名 `logo-bp.png`**（小写 logo-），`public/icons/` 下那份被 `index.html`、`App.tsx`、
  `lib.rs` 的 `include_bytes!` 三处引用；改名要三处一起改。
- **版本号自动升**：`scripts/auto-version.mjs`，SemVer；**是否影响功能**决定升不升：
  `feat`→MINOR、修复→PATCH、破坏性→MAJOR；不影响功能的（文档/日志、版本账本文件
  `package-lock.json` / `src-tauri/Cargo.lock` / `src/brand/version.ts`、升版脚本本身）不升。
  **打包前跑 `npm run tauri:build` 会自动升**（脚本已接在里面），
  升完把版本文件一起提交；不要再手改 `package.json` / `tauri.conf.json` / `src/brand/version.ts` 三处号。
  基线：0.2.0（2026-11-19，用户拍板）。

## 十、方案文件 `.bp.json`（用户 m01794：扒到一半能存、下次接着干）

- **位置**：音频旁边，`<音频名含后缀>.bp.json`（`某曲.wav` → `某曲.wav.bp.json`）。
  不集中往 `%APPDATA%` 存：跟着音频走，换机器、拷走整个文件夹都能接着干。
- **内容**：`{ app:'ijipu-bp', version, savedAt, audio:{name,path}, settings{…}, notes[] }`。
  `settings` 覆盖 BPM/拍号/弱起/首拍/调性/标题/滑条/播放模式/吸附/循环/视野/播放头；
  `notes` 是全部音符（带 `confirmed`，它决定 jps 导出什么）。
  **分轨的两轨音频不存**（几百 MB），恢复时重新分离；`analysis` 频谱也不存，重新算。
- **代码分工**：`src/model/project.ts` 是**纯函数**（build/parse/serialize + 逐字段兜底），
  `store.applyProject` 铺回状态，`App.tsx` 负责自动存（1.2 秒节流）、启动恢复、打开方案。
- **规矩**：格式变了就抬 `PROJECT_VERSION`，`parseProject` 不认识就返回中文错误、按新开处理；
  **不要手改用户目录里的 `.bp.json`**，坏字段会被兜底但不保证语义。
- **有内容才建**（用户 m02314）：`projectHasContent` 判定"有音符或改过参数"，刚打开、什么都没动
  时不写空文件；**已经有方案的要继续写**（把音删光也得把"删光"存下来，`App.tsx` 的
  `hasProjectRef` 管这一条）。`*.bp.json` 已进 `.gitignore`（本机工作状态，不进仓库）。
- **验收**：`smoke` 里有 roundtrip 断言；桌面壳手动验"改几笔 → 关 → 重开 → 状态还在"，
  并确认 `jpsToSvgPages` 的 `errors` 为空。
