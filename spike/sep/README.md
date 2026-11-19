# 分离尖刀（P1）

一次性验证程序：证明「htdemucs 的 vocals 专家能在本机的 Rust + ONNX Runtime 里跑起来」。

## 结论（2026-11-19 实测）

- 模型：[`StemSplitio/htdemucs-ft-vocals-onnx`](https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx)（**MIT**），302 MB，opset 17
- 输入 `(1, 2, 343980)` = 立体声 44.1kHz × 7.8 秒，输出 `(1, 4, 2, 343980)`，**第 4 行才是 vocals**
- 本机（GNU 工具链，CPU）：模型加载 **5.2–5.7 秒**；单个 7.8 秒片段推理 **3.2–6.2 秒**
  ⇒ 一段 5 分钟的歌（约 51 段，25% 交叠）大致 **2.5–4 分钟**
- 推理后 `伴奏 = 原混音 − 人声`，所以一次推理出两轨

## 怎么跑

```powershell
# 依赖：模型与 onnxruntime.dll 都不进仓库，放在 .cache/ 里
. ..\..\scripts\tauri-env.ps1
cargo build --release
$env:ORT_DYLIB_PATH = "D:\Coding\JianpuScript\ijipu-bp\.cache\ort\package\bin\napi-v6\win32\x64\onnxruntime.dll"
.\target\release\sep-spike.exe `
  "..\..\.cache\models\htdemucs_ft_vocals.onnx" `
  "..\..\.tmp-melody.wav" `
  "..\..\.cache\sep-out" `
  [开始秒] [时长秒]
```

产出 `vocals.wav` / `instrumental.wav`（32-bit float 立体声）。

## 没验的

- **没有真人声素材**：手头都是陶笛/马头琴的纯器乐，模型在人声上的质量没法判断（合成音上人声 RMS 恰好 0）。
- MP3/M4A 解码不在这个尖刀里（正式实现走前端已有的 `decodeAudioData`，把 PCM 传给 Rust，别在 Rust 里再塞一个解码器）。
- GPU（DirectML）没试；CPU 单线程池 `available_parallelism` 就是默认值。

## 已知坑

- `ort` 的进程退出偶尔卡住 ⇒ 尖刀里直接 `std::process::exit(0)`。
- 跑着的 exe 会锁住 `target\release`，`cargo build` 报 `拒绝访问 (os error 5)`：先 `taskkill /f /im sep-spike.exe`，或者换 `CARGO_TARGET_DIR`。
