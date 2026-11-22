# 第三方代码与许可

本项目（爱扒谱 / iJipu BP）整体按 **AGPL-3.0** 发布，见根目录 [LICENSE](LICENSE)。
下面这些部分来自第三方，按各自的许可使用；**不要把它们的许可声明删掉**。

## 1. noteDigger（GPL-3.0）

- 来源：<https://github.com/madderscientist/noteDigger>
- 许可：**GNU GPL v3.0**，全文见 [LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt)
- 版权：madderscientist 及 noteDigger 贡献者
- 本项目中由它改写/直接使用的文件：
  - `src/analysis/chords.ts`：由 `plugins/chordEst.js` 的和弦模板、先验/转移规则、
    HMM + Viterbi 解码改写（保留同一套音乐规则与参数口径）。
  - `src/audio/pianoSynth.ts`：由 `lib/tinySynth.js` 的 GM 1「Acoustic Grand Piano」
    两层振荡器参数改写（正弦主体 + 三角波 FM）。
  - `src/audio/beatClick.ts`：**直接使用** `core/app_midiplayer.js` 里的
    `CLICK_SOUND_BASE64` 节拍采样（Lavf62 编码的 mp3 data URI）。
- GPL-3.0 与 AGPL-3.0 的组合：GPLv3 / AGPLv3 允许组合；本项目整体按 AGPL-3.0 分发，
  上述文件保留 GPL-3.0 许可，并在此处与 `LICENSES/` 中保留完整许可文本。
- **如果要去掉 GPL 依赖**（例如想换成非 copyleft 的许可）：必须重写这三处，
  不能用「改几个变量名」的方式规避；节拍采样也要换成自己录/自己合成的。

## 2. g200kg/webaudio-tinysynth（Apache-2.0）

- 来源：<https://github.com/g200kg/webaudio-tinysynth>
- 许可：**Apache License 2.0**，全文见 [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)
- 说明：noteDigger 的 TinySynth 改自它；`src/audio/pianoSynth.ts` 的 GM 1 参数经
  noteDigger 转写，保留本 attribution。

## 3. iJipu 引擎（AGPL-3.0）

- `vendor/engine/` 从 iJipu 的 `packages/ijipu-engine/src/engine` **逐字节同步**。
- iJipu 以 AGPL-3.0 发布；本项目的根 [LICENSE](LICENSE) 也是 AGPL-3.0。
- 同步命令与哈希见 `scripts/sync-engine.mjs` / `ENGINE-SNAPSHOT.json`。

## 4. 网络使用与源代码（AGPL-3.0 §13）

AGPL-3.0 要求：**通过网络与本应用交互的用户，有权获得 Corresponding Source**。

- 源码仓库：<https://github.com/snailhome/ijipu-bp>
- **该仓库当前是私有仓库**；如果要公开部署到 Cloudflare Pages，必须在上线前做到下面任一条：
  1. 把仓库改成公开（最简单）；
  2. 在站点提供公开、可下载的完整源代码包（含 `vendor/`、本文件、`LICENSES/`）；
  3. 按 AGPL §13 提供等价的源代码获取方式（不能只写「发邮件找我要」而实际不提供）。
- 如果不想公开源代码，就不能使用 noteDigger 的 GPL 代码和 iJipu 的 AGPL 引擎；
  需要先把 `chords.ts` / `pianoSynth.ts` / `beatClick.ts` 和 `vendor/engine` 全部替换/重写，
  再考虑别的许可。
