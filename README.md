# 爱扒谱（iJipu BP）

把一段音频变成 **iJipu（爱记谱）的 `.jps` 脚本乐谱**：出频谱 → 定调 → 定拍 → 量化成简谱时值 →
导出文本。定位是**人工扒谱的辅助台**，不是"一键完美转谱"。

## 现在能做什么（P0，2026-11-18）

- **顶栏是图标条**（P0.21）：打开音频、播放/暂停、原音/合成、绘制/选择、吸附、重复区间、自动翻页、
  撤销/重做/回开头、全选/全不选/回初稿、导出、帮助、右栏开合，连"音名/数字"也是图标（`A` 与 `1`），
  全是 16×16 的线描图标，
  相关按钮用淡底圆角框成一组（播放那组、撤销/重做/回开头一组、确认与导出一组）；
  鼠标停上去有中文提示，读屏器靠 `aria-label`。吸附那条是"磁铁图标 + 原生下拉"，
  下拉在深色主题下也是深色（`:root { color-scheme: dark }` + `select/option` 自绘底色）。

- 打开音频（桌面壳里是系统对话框 + 按路径读字节；浏览器里 `<input type=file>` 降级），
  在 Web Worker 里算 STFT → 对数（半音）频谱（8192 点、汉宁窗、20 帧/秒、每帧方差归一）。
- 单声部旋律提取：每帧先做**谐波求和**（泛音也算这个基频的分），再用 **Viterbi** 在 88 个半音里找
  一条最省代价的轨迹（跳变代价表里八度便宜、半音贵）→ 连段 → 掐掉首尾的"拖音"。
- 调性分析（Krumhansl 轮廓相关，再走 softmax 归一）给 12 个主音的**可能性百分比**，
  画成 noteDigger 那种一行三段：**左边调名、中间色条（条长 = 百分比、颜色按调固定）、右边百分数**；
  点一行就换调号。调号下拉也在这一组里，组标题可点着收起/展开。
- **节奏分析**：一键在 onset 包络上重找拍点——候选速度（估值的 1/2、1、2 倍）各自找最佳相位，
  选"起声最贴拍点 × 中速先验"最高的那个，再把整条拍线挪到最近的起声峰上；写出 BPM、首拍、拍点、
  重拍和**可信度**（拍点处起声 ÷ 全曲平均起声，0–1）。变速曲子会飘，属已知限制。
- **去谐波**：滑条 0–1，`out = max(0, amp[b] − k·Σ w_h·amp[b−offset_h])`，用原始幅度预测泛音、
  不连锁减空；改完把保存的原始采样重跑一遍分析（频谱/音符/调性/节奏一起更新）。
- 节拍：谱通量 + 自相关估 BPM、找首拍；BPM / 拍号 / 首拍 / **弱起**都能手改，改完立刻重算。
  弱起 = 第 1 小节只算 N 拍（真·不完整首小节，0 表示整小节）；音符表小节线、流线谱、`jps`
  生成、`Ctrl+←/→` 跳小节共用同一套小节边界（`src/jps/bars.ts`）。
- **音符表（钢琴卷帘）**：左边是**钢琴键盘**（整列铺白、黑键是贴右端的 I 形黑块、整行高），
  横向是时间轴（秒刻度 + 小节号），纵向每半音一行。键盘分界按"真钢琴投影"画两种：
  黑键行在**竖直中心**画一条短线（从左边画到黑键左缘，两个白键的分界藏在这条黑键中间），
  E|F 与 B|C 之间没有黑键，整格通栏画线 —— 所以从左边看白键是 L/J/T 形、从右边看黑白格等高。
  数字模式下每一行都写简谱数字：**白格行**写在左侧白区（落在这格白键左块的竖直正中，
  相对当前调式是半音的也照标，例如 bB 调里 B 自然写 `1#`、E 自然写 `4#`）；**黑格行**写进黑键块里面、
  从块左缘留 5px（和白格一样），颜色反相（平时浅字，悬停/按下变黄时改深字）。左上角常显当前调号（`1=bB`），
  调号右边那把**锁**管上下滚动：锁住之后滚轮改成横向平移，解锁恢复上下换音区。
  **鼠标所在那一行在网格里压蓝、右侧琴键整格压黄**（白键按 L/J/T 形状压黄、黑键只染自己那块）；
  按住琴键时黄得更实、响该音，松手恢复。**这套键格形制已定稿，不要再改**（见 AGENTS §四）。
- **时间格**按小节/拍/1/4 拍三级画：小节线最亮实线、拍线实线、拍内 1/4 虚线；
  **最小绘制格 = 1/16 拍 × 一个半音**（1/4 拍虚线里再四分），吸附的"格点"档也是 1/16 拍。
  新点出来的音先给这个最小格（120 bpm 下约 31 ms），按住往右拖就一路延长这一个音。
  格子底下铺**频谱热力图**，按最小绘制格（1/16 拍 × 一个半音）取一格一个颜色（阶梯式，不做插值），
  一格不到 1 像素时才按整数倍合并（整曲铺满时有几十万格，不合并会卡）；
  **红＝最热、蓝＝最冷**；归一化用"中位数当噪底、99.5 分位当满格"，
  右侧「显示」里两个滑条调**倍率**和**对比**（颜色深度 = 值 ^ 对比 × 倍率）。
  音块上同时写音名和简谱数字（换调号数字同步重算），鼠标停在哪一行，右上角就显示"音名 · 简谱数字"。
- **两种点法**（对应 noteDigger 的铅笔/箭头，热键都是**反引号** `` ` `` 来回切，**默认是选择**；
  选择模式下按住 **Alt** 也能临时当绘制用，松开恢复）：
  - **选择**：只试听、不动音符，用来跟原曲比对（一进来就是这个，免得手一抖画出个音）。
  - **绘制**：点一格 → 响这个音 + 播放头挪过去；点已有音符 → 确认/取消确认（确认过的才是"要扒的音"）；
    空白处按住拖 → 直接画一个音；拖音符中间 → **上下改音高、左右改位置**（往上拖就是升 key）；
    拖右边缘 → 改时值（手停在右缘时光标会变左右箭头）。选中音符后 `↑/↓` 也能改半音，`Shift+↑/↓` 一个八度。
  - 两种模式下，**点格子都会先响该音高、再把播放头挪到点的地方**（包括重复区间里面 ——
  区间带里不再"拖整段"，想挪区间请拖两端握柄或重新在时间尺上划）。
- **撤销 / 重做**：`Ctrl+Z` 撤销、`Ctrl+Shift+Z` 或 `Ctrl+Y` 重做，工具条也有按钮；最多 **200 步**，
  **一次拖动算一步**（不会撤到半路）。
- **回开头 / 跳小节**：工具条「回到开头」或 `Home`（没圈播放区就回曲子开头，圈了就回区间开头）；
  `Ctrl+←` / `Ctrl+→` 退 / 进一个小节（弱起时第 1 小节只跨 N 拍）。
- **帮助面板**：顶栏最右边那个键盘图标（或问号位）点开，里面列了全部按键、快捷键、鼠标操作。
  只回退音符表，不回退播放头/视野/模式。
- **时间尺**高 36px（两行：秒刻度 + 第几小节）。在时间尺上**按住拖** = 框播放时段（自动开循环，
  `Shift` 早就不需要了）；**点一下** = 取消时段、播放头挪到点上。框好的时段**外面会压暗**，
  划的时候光标变左右箭头。
- **吸附**（默认「格点」= 1/16 拍：点哪一格就画哪一格；另有 拍 / 小节线 / 关）、**重复区间**（在时间尺上按住拖出区间就自动打开循环）、
  **自动翻页**（播放头贴到右边缘就推一屏）、
  **全选 / 全不选**、右侧栏可收起（工具条最右的图标，用的就是「爱出片」那张
  `public/icons/右侧边栏.svg`，不自己画）。
- **打开音频就直接一屏 20 秒**（0–20s，看后面靠横向滚动条或 Shift+滚轮）；比 20 秒短的曲子仍整首显示。
  要一次看全曲：Ctrl+滚轮往外缩。
- **键格**：每个半音一格、**格子高度全都一样**（14px）。黑键行中线只画到黑键左缘，两个白键直接
  相接处（E|F、B|C）画通栏线；黑键是右侧贴边、占 62% 宽、整行高的黑块（左端 2px 圆角）。
  音名模式标 `C4` 这类名字（只在 C 上）；数字模式按当前调式在左侧写简谱数字（`1'`、`2`…，
  调外音不写）。键列上方、时间尺左边那格显示当前调号，形如 `1=bB`。
- **鼠标**：滚轮 = 上下换音区（**锁住之后变成左右平移**）；**Shift+滚轮 = 左右平移**；**Ctrl+滚轮 = 横向缩放**（时值比率，
  以光标指着的那一拍为锚点，约 1.25 倍/格；Mac 上 Cmd+滚轮 也行）。
  右侧栏的滑条也认滚轮 —— 鼠标停在滑条上滚就是微调它（Shift 五倍步长），右栏不会跟着滚。
  放大到一屏装不下整首时，音符表下面那条**横向滚动条**就能拖（装得下时它铺满并置灰，
  一直看得见，不会"找不到"）。
- **「分析后自动填入音符」默认关**：关着时分析只出频谱/节奏/调性，音符全靠自己在表格里点；
  想让它先垫一版参考音（灰的、未确认）再在里面改，就把它勾上。
- 卷帘下面一行**简谱预览（流线谱）**：横轴与上面的时间格**同一个映射**，改一个音立刻反映；
  空隙按"一拍一个 `0`"补休止；长音用增时线拉到位，跨小节改画连音弧（对应 jps 的 `( … )`）；
  小节线、减时线、增时线、附点、八度点都按 `jps/toJps.ts` 的口径画。
  交出去的仍是 `store.jps`（过引擎 `parseJps` / `layoutScore` 两道闸门）。
- 播放：**原音频 / 合成音**一键互换（Tab 热键），播放中切换从当前毫秒续上，用来比对扒得准不准。
- 导出 `.jps`（只含**已确认**的音；桌面壳走"另存为 + 写后回读校验"，浏览器直接下载）。
- 桌面壳支持**命令行带文件**：`ijipu-bp.exe 某曲.mp3` 直接打开（也是自动化验证的入口）。

还没做：多声部/临时伴奏轨（现在仍纯单声部）、噪声与打击乐处理、
AI 转录（basic-pitch）、SF2 音色库试听、`.jps.sync.json` 边车。

## 怎么跑

```powershell
cd D:\Coding\JianpuScript\ijipu-bp
npm install --cache "D:/Coding/JianpuScript/.npm-cache"
npm run sync:engine     # 从 ../ijipu 同步引擎（vendor/engine，逐字节）
npm run dev             # 浏览器调试：http://localhost:5175
npm run smoke           # Node 冒烟：FFT/频谱/音高/量化/jps→引擎解析→排版→界面渲染
npm run fixture         # 造一段已知旋律的 wav（.tmp-melody.wav）
npm run inspect         # 诊断：原始音符 / 量化 / jps / 逐帧峰值
npm run probe           # 点界面自测（走 Chrome 调试协议，见下）
npm run build           # tsc --noEmit + vite build
. .\scripts\tauri-env.ps1   # 桌面构建前先设 Rust 环境（本机工具链在工作区，见下）
npm run tauri:build     # 桌面安装包（本机用 --no-bundle 只出 exe，见"踩过的坑"）
```

**只想调界面/逻辑**：`tauri-dev.bat` 双击就跑（等价于设好三处环境后 `npm run tauri:dev`），
带热更新、改前端不用重编译 Rust；`tauri-dev.bat --check` 只体检环境不启动。
**只想在浏览器里看**：`npm run dev` 后开 http://localhost:5175 —— 浏览器模式下"打开音频"走文件选择框、
导出走 Blob 下载，其余（频谱/卷帘/简谱/播放）与桌面端同一套代码。

桌面构建的环境说明：这台机器**没有 MSVC**，用的是 Rust 的 **GNU 工具链**
（`stable-x86_64-pc-windows-gnu` + winlibs MinGW64 的 gcc），并且
`CARGO_HOME` / `RUSTUP_HOME` 指向工作区里的 `.cargo` / `.rustup`，不在默认的 `~\.cargo`。
`scripts\tauri-env.ps1` 会按脚本位置推导工作区、把这三处设进当前会话；
**不 dot-source 就会出现"cargo 找不到 / 链接器找不到"**。
你自己的机器若有 MSVC（VS Build Tools）+ 默认 rustup，可以完全跳过这一步。

## 验界面：`npm run probe`

`scripts/ui-probe.mjs` 用 Chrome 的调试协议（CDP）打开 `http://localhost:5175/`，**真的点按钮、点画布**，
再读状态仓库核对结果 —— 因为 `npm run smoke` 只能验纯函数，验不了"这个按钮到底接没接上"。

```powershell
npm run dev          # 另开一个终端，先把 5175 起起来
npm run probe        # 20 条断言
npm run probe -- http://localhost:5175/ --shot .tmp-ui.png   # 顺便截一张图
```

它现在验的：界面挂载、绘制/选择模式切换、吸附下拉、自动翻页开关、重复区间在没画区间时是灰的、
导出在没有确认音符时是灰的、灌一段假分析后**点空白画音 / 点音符切确认 / 选择模式不改状态 /
全选 / 全不选**、流线谱画布在、没有运行时错误。

前提是 dev 构建里有那个后门：`src/main.tsx` 里 `if (import.meta.env.DEV) window.__bp = useBp`
（只在 dev 生效，生产构建会被摇掉）。

## 目录

```
src/analysis/   FFT、对数谱、音高名、单声部提取、BPM、调性（纯函数，Node 里可跑）
src/jps/        量化（秒→拍）与生成 jps 文本
src/audio/      解码（Web Audio）+ 播放（原音频 / 引擎 SynthBackend）
src/ui/         音符表（键盘+热力图+音块）、简谱流线谱、时间轴映射
src/model/      zustand 唯一状态源（分析结果 → 参数 → grid → jps）
src/worker/     分析 Worker（不阻塞界面）
src-tauri/      桌面壳：选文件、读字节、另存（就这三个命令）
vendor/engine/  iJipu 引擎快照（禁手改，`npm run sync:engine` 更新）
scripts/        引擎同步、冒烟、诊断、界面点按自测（ui-probe.mjs）
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

## 分轨（桌面专属）

人声/伴奏分离跑在 Rust 里（`ort` + htdemucs ONNX），网站/插件端不渲染入口。

1. 把 `htdemucs_ft_vocals.onnx` 放到 `%APPDATA%\com.ijipu.bp\models\`（301 MB，MIT）。
2. 把 `onnxruntime.dll` 放到 exe 旁边（或设 `ORT_DYLIB_PATH`）。
3. 打开音频 → 右栏「分轨（实验）」→「分离人声」；完成后可切「混音 / 人声 / 伴奏」看不同热力图。

实测：36 秒真人声 25 秒分离完（RTF 0.5×）；模型首次加载 5–6 秒。

## 分离模型怎么装（二选一）

1. **装模型包**：跑 `dist-model/ijipu-bp-sep-model-setup.exe`（140 MB，NSIS 打的），
   它把模型和 `onnxruntime.dll` 一起装到 `%APPDATA%\com.ijipu.bp\models`。
2. **应用内下载**：右上角齿轮 → 设置 → 「分轨（实验）」→ 点「下载模型（302 MB，hf-mirror）」，
   65 秒左右下完（实测），下完当场可用。
   也可以点「打开镜像网页 / 打开 HuggingFace」自己下，再手动放到上面那个目录。