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
- **两种模式的边界**（用户 m02483）：**选择**模式可以拖音符改音高/位置、拖右缘改时值；
  **画新音、删音（右键 / Delete）、点音符改确认只在绘制模式**。改指针交互时别把"删音"漏回选择模式；
  `probe` 里有"选择模式拖音符/改时值可以，右键与 Delete 不删"的用例守着。
  选择工具还有三种模式（`store.selMode` = `block | col | row`，`Alt+R` 轮换，用户 m02483；
  2026-11-22 参考 NoteDigger 补上**拖框选择**）：
  块选只选点到的音，整列选时值有重叠的音，整行选同音高的音；**在空白处按住拖一个框**时，
  块选 = 音头落在矩形里、列选 = 时值区间与时间范围重叠、行选 = 音高落在行范围里；
  拖的时候画 `.roll-sel-box`（块选矩形 / 列选竖带 / 行选横带），松手才落选择。
  **多选后按住其中一个音拖 = 整组一起移**（时间位移统一、音高统一，撞到音域/开头时夹位移，
  不把相对音程扯散）；`↑/↓` / `Shift+↑/↓` 也整组移，`Delete` 整组删（绘制模式）。
  纯计算在 `src/ui/selection.ts`（`selectNotes`），`smoke` 盖 5 条、`probe` 真拖 3 种模式 + 整组拖。
  选择按钮三颗图标要能区分：**块选 = 虚线矩形 + 音头；整列 = 竖带 + 左右箭头；整行 = 横带 + 上下箭头**。
  `selectedIds` 一起高亮，在绘制模式下 Delete 会把这一批一起删。反引号仍然只切绘制/选择。
- **吸附下拉在右栏编辑页最上面**（用户 m02483 从顶栏挪下来），顶栏不再放它；画布上方那条
  "音符表 + 操作说明"窄栏也已撤掉（省纵向空间，说明看帮助弹层和悬浮提示），**别再把它加回去**。
- **右栏三个页签**（用户 m02483）：`sideView` = `'edit' | 'analysis' | 'settings'`，同一个 `.side` 容器
  顶部是 `.side-tabs` 三个页签（**调节 / 分析 / 设置，各带图标**），顶栏**只留一颗右栏开关图标**（旁边是帮助）。
  **`Ctrl+]` = 收起 / 展开右栏**（`BracketRight` + ctrl/meta，帮助弹层里有这一行）；
  **`Ctrl+L` = 键区锁、`Alt+L` = 重复区间、`Alt+N` = 自动翻页、`Alt+R` = 选择模式轮换、
  `Alt+J` = 播放节拍、`Alt+S` = 聚焦播放速度滑条、`F1` = 帮助**（用户 m02483）。
  - 调节：吸附 / 调号（下拉）/ 去谐波 / 显示组 / 生成参数 / 警告 / jps（**显示排在生成参数前面**）。
  - 分析：分析 / 和弦分析（从顶栏挪来）/ 分析后自动填音开关 / 调性分析（候选）/ 节奏与谐波 / 分轨 /
    回到初稿（页面最下面）。
  - 设置：分轨模型安装 / 关于。
  **控件说明一律放 `title`（悬浮提示），右栏正文不再写解释性段落**（用户 m02483），
  块与块之间靠 `.side` 的 `gap: 12px` 统一间距，不要再给单个 field 加 margin。
  用户要求"把某组放哪一页"就改这里的分组条件；`probe` 用 `.side-tabs button` 切页，
  **别再按顶栏图标找视图**（那几颗图标已撤）。
- **会整张换掉音符表的操作必须先确认 + 留快照**（用户 m02483：清掉辛苦识别的谱太坑）：
  「全不选」「回到初稿」「分析（重新判音）」分别走 `doClearAll` / `doResetDraft` / `doAnalyze`，
  执行前 `rememberForRecovery(label)` 把整份方案写进 localStorage 的 `bp.recovery`，
  状态栏出现「恢复」入口（`applyRecovery`，点的时候再确认一次）；重新分析另在 `analyzeSource`
  里调 `store.snapshotNotes()` 记一步撤销。新增任何"整张换音符表"的入口照这个来，
  **别直接 `setAnalysis` / `resetNotes` 绕过确认**。
- **按钮/控件的提示文案拆两半**（用户 m02483）：`aria-label`（侧栏控件用 `data-name`）= 名称，
  `title` = 一句功能说明；悬浮提示由 `App.tsx` 的 `HoverTip` 统一画（120ms、名称在前、说明在后、
  移开即消失）。覆盖 `.toolbar` 的按钮和 `.side` 里的按钮 / `.field` / `.check`（分组标题小三角不弹）。
  **有热键的控件再加 `data-key`（如 `Ctrl+S` / `Alt+L`）**，提示名称后面会跟一枚热键小牌；
  **说明里就不再重复这枚热键**（播放键只写「播放 空格」，不再写"播放（空格）"）；
  只有还有**别的主键**时才在说明里补一句（例如重做还支持 Ctrl+Y）。画布内的提示
  （NoteRoll 的 `hoverTip`）用对象里的 `key` 字段。新加控件照这个写就自动有提示，
  **不要只写原生 title 当唯一信息来源**。
- **文件/界面热键**（用户 m02483）：`Ctrl+O` 打开音频、`Ctrl+J` 打开方案、`Ctrl+S` 保存方案、
  `Ctrl+E` 导出 .jps、`Ctrl+]` 右栏开关、`Ctrl+L` 键区锁、`Alt+L` 重复区间、`Alt+N` 自动翻页、
  `Alt+Z` 音名/数字互换、`Alt+R` 选择模式轮换、`Alt+J` 播放节拍、`Alt+S` 聚焦播放速度滑条、`F1` 帮助。
  热键都在 `App.tsx` 的 keydown effect 里；`exportJps` 定义在后面，用 `exportRef` 拿。
  帮助弹层的「文件 / 播放 / 编辑 / 鼠标与视野」几节列了这些，改热键要两边一起改。
  **顶栏顺序**（用户 m02483）：左侧 = 文件 → MIDI → 谱音（全选/全不选）→ **撤销/重做**；
  右侧 = 节拍（播放节拍）→ 导航（回到开头 / 循环 / 自动翻页）→ 绘制/选择 → 原音/合成 →
  音名/数字 → 帮助/侧栏；分析/和弦/回到初稿不在顶栏，在「分析」页。
- **窄屏顶栏改成左侧抽屉菜单**（用户 2026-11-23："手机端网页顶栏显示不佳"）：窗口 ≤ **1240px**
  （`NARROW_TOPBAR_PX`，`useNarrowTopbar()` 用 `matchMedia` 判定）时顶栏只留
  **品牌图标 + 菜单**（菜单按钮在品牌图标**右侧**，用户 2026-11-23 指定）→ 录音 → 撤销·重做；
  中间 **播放 + 回开头**（回开头在播放**后面**，用户 2026-11-23 指定：两个一起**居中**）；
  右边 **绘制·选择 / 原音·合成 / 右栏**（用户 2026-11-23：两组与右栏一起**右对齐**）。
  DOM 是 `.tb-left` / `.tb-center` / `.tb-right` 三段，顶栏 `grid-template-columns: 1fr auto 1fr`，
  中间列因此在容器正中；改按钮顺序要挪对段。其余按钮进左侧抽屉（`LeftMenu`，
  菜单数据是 `App.tsx` 里的 `leftMenuGroups`，共 15 项）：文件 / MIDI / 谱音 / 节拍 /
  循环与自动翻页 / 音名·数字 / 帮助。
  绘制·选择与原音·合成在宽屏和窄屏**共用 `modeSeg` / `sourceSeg` 两个 JSX 变量**，
  别在两处各手写一份。窄屏按钮 24px 宽、间隙 3px：390/360 能一行放下；≤320 允许顶栏
  横向滚动（`overflow-x:auto` + 隐藏滚动条），`.tb-left > * { flex: 0 0 auto }`
  保证**按钮不被压扁**；
  播放速度滑条窄屏也从播放键右边挪进抽屉（顶栏那条 `display:none`）。
  **同一颗按钮只渲染一份**（`narrow ? … : …` 条件渲染），别用 CSS 媒体查询藏两套 DOM ——
  探针是按 `aria-label` 找按钮的，两套会点到藏着的那份。抽屉里点一项执行完就收起，
  遮罩 / Esc 也能关；开着的项带「开」标记，每项写图标 + 名字 + 热键（触屏没有悬浮提示）。
  **往顶栏加按钮时，宽屏组和 `leftMenuGroups` 要一起加**，只加一边手机上会少入口。
  `probe` 有 14 条窄屏用例（CDP 模拟 390×844 + 360/320 + 1240/1300 阈值）：单行不溢出、
  顶栏只剩哪几颗、菜单按钮在品牌图标右侧、三段布局（左簇靠左 / 播放+回开头居中 / 绘制·原音与右栏靠右）、
  360/320 按钮不被压扁、状态栏每段单行且两行内、抽屉 15 项齐全、点一项能生效并收起、
  遮罩 / Esc 关、录音小条不超出屏幕、1240px 仍是窄版 / 1300px 回宽版（宽版必须一行）、
  窗口拉宽后恢复宽版且抽屉不残留。
  录音小条（`RecordMiniBar`）定位会按视口夹左右（窄屏麦克风靠左时不至于伸出屏幕）。
- **窄屏状态栏**（用户 2026-11-23："状态栏变形厉害"）：`.status` 必须 `flex-wrap: wrap`，
  且每段 `white-space: nowrap` —— 以前不换行，中文被压成一列竖排的字。`.status.narrow` 下
  再收一档：隐藏快捷键提示和「缓存 / 已存」时间（与保存状态重复），提示行
  （`status-notice`，error / notice）改成 `flex: 1 1 0` 抢剩余宽度、可压缩；
  「爱记谱首页」**绝对定位在右下角**（`right: 8px; bottom: 3px`），状态栏右侧留 96px 给它 ——
  这样内容再多也不会出现"第二行只有首页"的错行（用户 2026-11-23 实拍 900px）。
  增删状态栏项都要跑 `probe` 的窄屏状态栏用例（高度 ≤60、每段单行、提示已隐藏）。
  **宽版也别让它错行**（用户 2026-11-23 实拍 1247px）：那串快捷键提示只在 **≥1500px** 显示
  （中等宽度会挤出一行"只有它"的错行，完整提示在帮助弹层里）；提示行（`status-notice`）
  可压缩（`flex: 0 1 auto` + `max-width: 52ch`），不要因为它是长句子就把整条顶到第二行。
  `probe` 有"1247 / 1300 宽版状态栏不错行"一条守着。
- **保存状态**（用户 m02483）：`contentSig()` 只算谱面内容（音符 + BPM/拍号/弱起/首拍/调号/标题），
  跟 `savedSigRef`（上次真正写 `.bp.json` 时的指纹）比得到 `dirty`；状态栏显示「橙点 未保存 /
  绿点 已保存」，顶栏保存按钮加 `.dirty` 橙边。视野/循环/播放模式这些导航不算修改。
  改这个口径要连 `probe` 的两条保存状态用例一起改。
- **主按钮只留给真正的主动作**：`className="primary"` 别用在「打开音频」这类普通入口上
  （用户 m02483 明确说它不是一个"开头按钮"），现在只用在确认弹层的"确认"和设置页的下载按钮。
- **右栏首开默认收起**（用户 2026-11-23）：`showSide` 的初始值读 localStorage `bp.showSide`
  （只有 `'1'` 才展开；**没记录 = 收起**），变化时写回。手机上默认展开会把它那 300px
  挤在画布旁边、画布只剩键盘列。`probe` 有"首开收起 + 点开后记住"两条用例守着。
- **手机触摸与试听**（用户 2026-11-23）：
  - `.roll-host > canvas` 必须带 `-webkit-tap-highlight-color: transparent` 与 `touch-action: none`。
    少了第一条，手机上点谱面会有一层**系统"点按高亮"**（整块画布闪一下，用户报的就是"全屏高亮"）；
    少了第二条，触摸手势会被浏览器拿着等双击缩放判定，拖框 / 画音符不跟手。
  - 点钢琴键"发音延迟"：`audio/player.ts` 的 `audition()` **不要再 `await ctx.resume()`**
    （等它 resolve 才排声音等于白等），直接同步排程；`primeAudio()` 在 `NoteRoll` 的
    `onPointerDown` 第一行调用（用户手势内 resume），等真按到琴键时上下文已经是 running。
- **空表格提示只占键盘右边**（用户 2026-11-23：以前整块居中，字压到键盘列上）：
  `.pane-empty` 的 `left` 由 `NoteRoll` 按 `KEY_W`（66）内联给，CSS 只留右侧 `padding`。
- **键盘区按住上下拖 = 上下换音区**（用户 2026-11-23）：**未锁定**时（`lockPitch` 关）在左侧
  钢琴键盘上按住往上/往下拖，等价鼠标滚轮上下换音区 —— 按"挪过几行"改顶行，3px 死区区分
  "点一下试听"（实现是 `NoteRoll` 的 `keyScroll` 拖动）；**锁定时只试听、不换音区**。
  `probe` 有"未锁定向下拖 3 行 ⇒ top 减 3 / 锁定时不动"两条用例。
- **画布上的悬浮信息**（用户 m02483）：时间轴 / 键区锁用 `hoverTip`（名称 + 一句"这里能干什么"，
  跟鼠标走，样式 `.canvas-tip`）；音高格用 `.row-badge`（音名 · 简谱数字，跟鼠标走，
  **不要再加"（点一下试听）"那行字**）。画布是整块 canvas、没有 DOM 子元素，所以这两块都在
  `pointermove` 里按命中区算、用绝对定位的兄弟节点画，**别回到 canvas 里画字**。
- 音符**以 `store.notes`（秒轴、可编辑）为准**，`analysis.notes` 只是初稿；
  别把 `analysis.notes` 直接画到界面或喂给播放（否则人工改动白改）。
- **八度纠偏**（用户 2026-11-22："分析成谱的音比频谱显示低了八度"）：`analysis/notes.ts` 在
  Viterbi + 连段之后，用**原始频谱**对每个音段的 `当前 / -12 / +12` 半音重新打分：
  **压 1、2 次谐波，抬 3、5 次谐波**；候选必须有 3/5 次谐波支撑（纯次谐波/低频噪声不能把音拉低）；
  只移动一个八度，且证据差 > 0.2 才动。改判据/权重必须跑 `smoke` 的 5 条八度用例。
  **不要在 `harmonicScores` 里简单加“低八度惩罚”**——弱基频的真实音会被误拉低。
- 音符有 `confirmed` 一栏：**只有确认过的音**才进 `grid`/`jps`/预览（用户口径"输出以绘制所选的音为准"）。
  新增任何"导出/预览"路径都要经过 `derive()` 里的 `confirmed` 过滤，别绕过它。
- **键盘形制已冻结**（用户 2026-11-19 明确："按现在的方案固化下来，键盘格的形制不要再随意改动"）：
  每半音一行、**同一屏里行高一律相同**（就是 `store.rowH`，默认 14px，右栏「显示」里 10–26px 可调，
  用户 m02483 要求能调高矮）；黑键 I 形贴右、宽 62%；分界只有两种 —— 黑键行在**竖直中心**
  画一条短线（从左边界到黑键左缘），E|F 与 B|C 之间在 E / B 的**上边界**通栏；
  高亮白键要按 L / J / T 形状（左块伸进相邻黑键格半格），黑键只染自己那块。
  要动这套几何，先把这条规则改了并说明原因，别直接改画法。
  **画的时候一律用"一行 = 一个 rowH"来算，不许在组件里写死 14。**
- **显示尺寸三项**（用户 m02483）：`store.rowH`、`store.pageSec`（一屏几秒，真正的视野仍以
  `view.zoom` 为准）、`store.topMidi`（表格第一行的音高）。三者都落 localStorage
  （`bp.rowH` / `bp.pageSec` / `bp.topMidi`），**不进方案文件**；只在 store 里改，别在组件里另存一份。
  行高、屏宽滑条**只放调节页「显示」组**（用户 m02483 拍板：设置页不放重复的）。
  **所有滑条都要支持"悬浮滚轮"调节**：App.tsx 里挂 document 级 wheel 监听（命中区放宽到整行
  `label.field`），新加滑条不用另写；改这段要跑 `probe` 的"滑条全都能滚轮调"用例。
- **播放速度**（用户 m02483）：`store.playRate`（0.5×–2×，默认 1×，只改快慢不改音高），
  滑条**只放在顶栏播放键右边**（`.play-wrap .rate-slider`，不写文字标签，名称/说明靠悬浮提示，
  提示里带"当前 1.05×"；滑条右边有 `.rate-val` 一直显示当前倍率）；值落 localStorage `bp.playRate`，
  App 的 effect 调 `audio/player.ts` 的
  `setPlayRate`。播放中改倍率：音频模式改 `BufferSource.playbackRate` 并按当前位置重设基准；
  合成音按当前位置重排一遍。改播放位置算法时记得 tick 的 `* rate` 和合成音的 `/ rate` 两处一起改，
  `probe` 有滑条位置 + 悬浮提示 + 滚轮 + 刷新恢复的用例。
- **MIDI / 节拍器 / 钢琴音色**（用户 m02483，参照 noteDigger）：
  - 顶栏文件组后面是 MIDI 组：`MIDI 编辑器` / `导入 MIDI` / `导出 MIDI`。导入用
    `src/model/midi.ts` 的 `parseMidi`（自己写的 SMF 解析，不引库），导入后进 MIDI 模式、
    全部当谱音；导出 `writeMidi` 只写确认过的音（format 1、480 ticks/拍）。
    MIDI 模式（`store.midiMode`）隐藏频谱（NoteRoll 的 `midiMode` prop）、播放强制 synth。
  - 节拍器：`player.ts` 的 `setMetronome`，按 BPM / 拍号 / 首拍 + 当前倍率排"嗒"，
    每小节第一拍重音；开关 `store.metronome` 落 `bp.metronome`。**小节第一拍的音色直接用
    noteDigger 的 mp3 采样**（`src/audio/beatClick.ts` 的 `BEAT_CLICK_URI`，来自它的
    `CLICK_SOUND_BASE64`），中间拍子仍用原来的振荡器；采样解码失败时小节拍也退回振荡器。
  - 合成音不再走引擎 `SynthBackend`，改用 `src/audio/pianoSynth.ts`：从 noteDigger 的
    `lib/tinySynth.js` 移植的 GM 1 钢琴两层配方（正弦 + 三角波 FM）。noteDigger **没有 .sf2
    采样库**，128 个 GM 音色都是 TinySynth 用振荡器合成的；别再去找 soundfont 文件。
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
- **两种保存**（用户 m02483，别混）：
  - **缓存保存**（自动，1.2 秒节流）：写 localStorage 的 `bp.cache`，**绝不写 `.bp.json`**；
    启动时同一首音频优先恢复缓存（含没存盘的改动）。状态栏显示「缓存 HH:MM:SS」。
  - **真正保存**：`Ctrl+S` 或顶栏「保存方案」才写磁盘上的 `<音频名>.bp.json`（浏览器里写
    localStorage 的 `bp.project:<路径>`），同时把缓存刷成同一份。状态栏显示「已存 HH:MM:SS」。
- **代码分工**：`src/model/project.ts` 是**纯函数**（build/parse/serialize + 逐字段兜底），
  `store.applyProject` 铺回状态，`App.tsx` 负责缓存保存（`writeCache` / `readCache`）、
  真正保存（`saveProject`）、启动恢复（`readRestoreFor`：同曲缓存优先，其次旁边的 `.bp.json`）。
- **规矩**：格式变了就抬 `PROJECT_VERSION`，`parseProject` 不认识就返回中文错误、按新开处理；
  **不要手改用户目录里的 `.bp.json`**，坏字段会被兜底但不保证语义。
- **缓存 vs 文件**：缓存总是写（哪怕刚打开、还没内容 —— 这样"下次接着干"才成立），
  文件只在用户主动保存时写。原来的「有内容才建」（用户 m02314）随自动存盘一起退役，
  别再让后台任务往音频旁边写文件。`*.bp.json` 已进 `.gitignore`（本机工作状态，不进仓库）。
- **验收**：`smoke` 里有 roundtrip 断言；桌面壳手动验"改几笔 → 直接关掉 → 重开 → 状态还在
  （状态栏是「缓存」）→ 按 Ctrl+S → 音频旁边才出现 `.bp.json`（状态栏变「已存」）"，
  并确认 `jpsToSvgPages` 的 `errors` 为空。

## 十一、录音成谱（用户 2026-11-22）

用途：**哼唱辅助记谱**——哼一小段，录下来，分析成谱。

- **入口**：顶栏文件组后面的**麦克风**按钮（`data-rec-mic="1"`）。点一下在图标下方开
  `RecordMiniBar`（四个图标：录音/暂停、停止、分析成谱、右栏 + 计时）。当前方案有未保存修改时，
  先弹确认框：「保存并新建 / 不保存，直接新建 / 取消」。
- **纯口径**：`src/model/recording.ts`——合成路径 `recording:<名字>`、`isRecordingPath()`、
  录音方案名（本地时间、文件名安全）、保存音频建议名。**只有这里认前缀**，别处不要自己判。
- **录音**：`src/audio/recorder.ts`（`getUserMedia` + `MediaRecorder` → `decodeBytes`），
  暂停的空档不进音频；`src/audio/wav.ts` 编 16-bit PCM WAV；
  `src/audio/saveAudio.ts` 桌面走 Rust `bp_save_audio`（原生另存为 + 写盘回读比对），
  浏览器走 `showSaveFilePicker` / 下载。
- **方案状态**：录音方案的 `filePath` 是合成路径，`buildProject()` 能建出方案：
  - **`saveProject()` 对合成路径直接抛错**（不能往 `recording:` 旁边写 `.bp.json`）；
  - **`scheduleSave()` 只在音频字节已进 IndexedDB 后才写 `bp.cache`**（`recordingAudioCachedRef`）；
    录音中每 1.5 秒把 WebM 快照写进 IndexedDB，同时刷新 `bp.cache`；
  - 保存方案统一走 `saveSmart()`：录音方案 → `saveRecordingAndPlan()`（弹保存音频 → 写 WAV →
    `store.setFileRef()` 换成真实路径 → `saveProject()` 写 `.bp.json` → 删掉 IndexedDB 暂存 → 收起小条）；
    普通方案 → `saveProject()`。
- **录音暂存（用户 2026-11-22 追加）**：原始 WebM 写 **IndexedDB**（`src/audio/recordingCache.ts`，
  键 = 合成路径），方案写 `bp.cache`；启动时桌面走 `readCache → restoreProject`，浏览器走
  `browserBootedRef` 那段，`restoreProject` 认出合成路径后从 IndexedDB 读回、解码、恢复。
  **录音中/刚录完关掉应用都能接着干**；`stopRecording` 会写最终字节并 `clearRecCacheTimer`，
  新方案/保存成功后删掉旧音频，别让 IndexedDB 越攒越大。**不要再退回"只放内存"**——
  否则跟其它模式不一致，用户会以为功能没做完。
- **分析**：录音停止后 `samplesRef` 与 `recordedBufferRef` 都有值，并**自动跑一趟 `notes:false`**
  （只出频谱/节奏/调性，不填音符）——表格里马上能看到录音的热力图、播放键也能用；
  小条的「分析成谱」再走 `doAnalyze()`（`notes:true`，有音符时仍会确认 + 留恢复快照）。
- **测试**：`smoke` 盖 WAV 头/采样、合成路径/命名/计时（纯函数）+ 八度纠偏 5 条 + 选择框 5 条
  （当前 **114/114**）；`ui-probe` 用 `--use-fake-device-for-media-stream` +
  `--use-fake-ui-for-media-stream` 真录一段，验
  "麦克风按钮 → 小条 → 录音/暂停/停止 → 分析成谱 → 右栏 → 未保存提示 → 不保存直接新建
  → 录音中刷新恢复 → 停止后刷新恢复"，并真拖块选/整列/整行/整组移动（当前 **218/218**，
  其中 14 条是 2026-11-23 的窄屏顶栏 / 左侧抽屉 / 状态栏用例；另有首开右栏收起、
  画布点按高亮、空提示避键盘、1247 宽版状态栏不错行、键盘区上下拖 7 条）。
  改这段交互后**要跑 `npm run probe`**；动 Rust 命令跑 `cargo check --manifest-path src-tauri/Cargo.toml --lib`。

## 十二、访问统计（用户 2026-11-22）

- **主站 `/tools/`（音视频工具）**：主站 `public/analytics.js` 的 path 正则放行 `/tools/`，
  `/api/visit` 的 `PATH_RE` 也放行；`/api/stats` 的 `pages.tools` 单列。
- **爱扒谱（本仓）**：`public/analytics.js` 跨站 `POST` 到
  `https://ijipu.pages.dev/api/visit`，`path` 固定 **`/bp/`**（不是真实路由，只是统计标识）；
  visitor 存本域 `bp.visitor`，不存 IP/UA；`index.html` 里 `defer` 引入。
- **主站改动**：`functions/api/visit.js` 的 `PATH_RE` 放行 `tools\/|bp\/`；
  `functions/api/stats.js` 的 `pages` 增加 `tools` / `bp`；`public/stats/index.html` 显示这两行。
- **部署顺序**：先部署主站的 Functions（否则 bp 的 `/bp/` 上报会被 400 拒掉），再部署 bp 站点。
- 改 endpoint / path / visitor 键要两边同步；**不要**把统计做成会阻塞页面的同步请求。

## 十三、回爱记谱首页 / 在爱记谱打开（用户 2026-11-22）

- **链接常量只在 `src/brand/links.ts`**：`IJIPU_SITE`、`IJIPU_APP`、`JPS_LINK_MAX_LEN`、`jpsAppUrl()`。
  `JPS_LINK_MAX_LEN = 8000` 必须与 iJipu `store/urlImport.ts` 的 `JPS_PARAM_MAX_LEN` 一致，
  否则会生成"看着能开、实际被应用忽略"的链接；**不要**在组件里另写 8000/域名。
- **回首页**：状态栏与「设置 → 关于」的「爱记谱首页」走 `goSiteHome()` —— 网页版本窗口
  `location.assign`，桌面壳用系统浏览器（Tauri 窗口没有地址栏/后退，不能把人困在介绍页）。
- **在爱记谱打开**：`/app/?jps=<encodeURIComponent(当前 st.jps)>`，由 `openInIpu()` 走
  `openUrl()`（新标签 / 系统浏览器）；「jps 源码」面板另有「复制打开链接」。
  **不要**把这条长 URL 塞进导出的 `.jps`：`.jps` 是纯文本，塞进去会撑大谱面、且自引用。
- 空界面提示要同时给两条路：「先打开一段音频，或录制一段音频（点顶栏麦克风）」；
  状态栏空文案同样提录音。
