//! 人声/伴奏两轨分离（桌面专属）。
//!
//! 模型：htdemucs_ft 的 vocals 专家（MIT，ONNX opset 17，302 MB）
//!   输入 (1,2,343980) 立体声 44.1kHz × 7.8s → 输出 (1,4,2,343980)，第 4 行是 vocals
//!   伴奏 = 原混音 − 人声，所以一次推理就出两轨。
//!
//! 为什么不在这里解码音频：前端已经有 `decodeAudioData`，把 PCM 传进来就行，
//! 壳里再塞一个解码器没有意义（见 docs/TRANSCRIBE-PLAN.md §三十三）。

use std::path::PathBuf;
use std::time::Instant;

use ort::session::Session;
use ort::value::Value;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const SEG: usize = 343_980; // 7.8 s @ 44.1 kHz，模型写死
const SR: u32 = 44_100;
const OVERLAP: f32 = 0.25;

#[derive(Serialize)]
pub struct Stems {
    /// 写出去的 wav 路径（前端用 decodeAudioData 读回来，比走 JSON 传几千万个 float 省得多）
    vocals_path: String,
    instrumental_path: String,
    /// 秒，给界面显示耗时
    seconds: f32,
}

/// 模型放在应用数据目录下的 models/ 里（302 MB 不进安装包，单独下载，同音色库的做法）
fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录: {e}"))?;
    Ok(dir.join("models").join("htdemucs_ft_vocals.onnx"))
}

/// 模型装没装（前端据此显示「先下载模型」）
#[tauri::command]
pub fn bp_sep_model(app: AppHandle) -> Option<String> {
    let p = model_path(&app).ok()?;
    if p.is_file() {
        Some(p.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 模型该放哪（前端提示用户用；也方便我自己放测试模型）
#[tauri::command]
pub fn bp_sep_model_target(app: AppHandle) -> Option<String> {
    model_path(&app).ok().map(|p| p.to_string_lossy().to_string())
}

/// 真正的分离。`samples` 是**交错立体声** f32（L,R,L,R…），`sample_rate` 随便，内部会重采样到 44.1k。
#[tauri::command]
pub async fn bp_separate(
    app: AppHandle,
    samples: Vec<f32>,
    sample_rate: u32,
) -> Result<Stems, String> {
    let t0 = Instant::now();
    let path = model_path(&app)?;
    if !path.is_file() {
        return Err(format!(
            "还没装分离模型。把 htdemucs_ft_vocals.onnx 放到：{}",
            path.to_string_lossy()
        ));
    }
    // ONNX Runtime 的动态库：优先环境变量，其次 exe 旁边（打包时随安装包发）
    if std::env::var_os("ORT_DYLIB_PATH").is_none() {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for name in ["onnxruntime.dll", "libonnxruntime.so", "libonnxruntime.dylib"] {
                    let cand = dir.join(name);
                    if cand.is_file() {
                        std::env::set_var("ORT_DYLIB_PATH", cand);
                        break;
                    }
                }
            }
        }
    }

    // 交错 → 左右声道
    let frames = samples.len() / 2;
    if frames == 0 {
        return Err("音频是空的".into());
    }
    let mut left = Vec::with_capacity(frames);
    let mut right = Vec::with_capacity(frames);
    for i in 0..frames {
        left.push(samples[i * 2]);
        right.push(samples[i * 2 + 1]);
    }
    let (left, right) = if sample_rate == SR {
        (left, right)
    } else {
        (resample(&left, sample_rate, SR), resample(&right, sample_rate, SR))
    };

    let env = ort::init()
        .with_name("ijipu-bp")
        .build()
        .map_err(|e| format!("初始化 ONNX Runtime 失败: {e}"))?;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut builder = Session::builder(&env)
        .map_err(|e| format!("建 session 失败: {e}"))?
        .with_intra_threads(threads)
        .map_err(|e| format!("设线程数失败: {e}"))?;
    let mut session = builder
        .commit_from_file(&path)
        .map_err(|e| format!("加载模型失败: {e}"))?;

    let n = left.len();
    let stride = (SEG as f32 * (1.0 - OVERLAP)) as usize;
    let mut voc_l = vec![0f32; n];
    let mut voc_r = vec![0f32; n];
    let mut wsum = vec![0f32; n];

    let total = if n <= SEG { 1 } else { (n - SEG) / stride + 2 };
    let mut pos = 0usize;
    let mut done = 0usize;
    while pos < n {
        let take = (n - pos).min(SEG);
        let mut data = vec![0f32; 2 * SEG];
        data[..take].copy_from_slice(&left[pos..pos + take]);
        data[SEG..SEG + take].copy_from_slice(&right[pos..pos + take]);
        let input = Value::from_array((vec![1usize, 2, SEG], data))
            .map_err(|e| format!("构造输入张量失败: {e}"))?;
        let outs = session
            .run(ort::inputs!["mix" => input])
            .map_err(|e| format!("推理失败: {e}"))?;
        let (_shape, out) = outs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("取输出失败: {e}"))?;
        let base = 3 * 2 * SEG; // [1,4,2,SEG] 的第 4 个 stem
        for i in 0..take {
            let w = hann_weight(i, take);
            voc_l[pos + i] += out[base + i] * w;
            voc_r[pos + i] += out[base + SEG + i] * w;
            wsum[pos + i] += w;
        }
        done += 1;
        let _ = app.emit("bp-sep-progress", (done, total));
        if pos + SEG >= n {
            break;
        }
        pos += stride;
    }
    for i in 0..n {
        if wsum[i] > 1e-6 {
            voc_l[i] /= wsum[i];
            voc_r[i] /= wsum[i];
        }
    }
    let mut vocals = Vec::with_capacity(n);
    let mut instrumental = Vec::with_capacity(n);
    for i in 0..n {
        let v = 0.5 * (voc_l[i] + voc_r[i]);
        let m = 0.5 * (left[i] + right[i]);
        vocals.push(v);
        instrumental.push((m - v).clamp(-1.0, 1.0));
    }
    let out_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录: {e}"))?
        .join("stems");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("建分轨目录失败: {e}"))?;
    let vocals_path = out_dir.join("vocals.wav");
    let instrumental_path = out_dir.join("instrumental.wav");
    write_wav_f32(&vocals_path, &vocals)?;
    write_wav_f32(&instrumental_path, &instrumental)?;
    Ok(Stems {
        vocals_path: vocals_path.to_string_lossy().to_string(),
        instrumental_path: instrumental_path.to_string_lossy().to_string(),
        seconds: t0.elapsed().as_secs_f32(),
    })
}

/// 单声道 44.1k float32 wav（前端 decodeAudioData 直接能读）
fn write_wav_f32(path: &std::path::Path, data: &[f32]) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::File::create(path).map_err(|e| format!("建 wav 失败: {e}"))?;
    let data_bytes = (data.len() * 4) as u32;
    let mut head = Vec::with_capacity(44);
    head.extend_from_slice(b"RIFF");
    head.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    head.extend_from_slice(b"WAVEfmt ");
    head.extend_from_slice(&16u32.to_le_bytes());
    head.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    head.extend_from_slice(&1u16.to_le_bytes()); // mono
    head.extend_from_slice(&SR.to_le_bytes());
    head.extend_from_slice(&(SR * 4).to_le_bytes()); // byte rate
    head.extend_from_slice(&4u16.to_le_bytes()); // block align
    head.extend_from_slice(&32u16.to_le_bytes()); // bits
    head.extend_from_slice(b"data");
    head.extend_from_slice(&data_bytes.to_le_bytes());
    f.write_all(&head).map_err(|e| e.to_string())?;
    for v in data {
        f.write_all(&v.to_le_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn hann_weight(i: usize, take: usize) -> f32 {
    let x = (i as f32 + 0.5) / take as f32;
    0.5 - 0.5 * (2.0 * std::f32::consts::PI * x).cos()
}

/// Lanczos-3，够干净且不用引第三方库
fn resample(src: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to {
        return src.to_vec();
    }
    let ratio = to as f64 / from as f64;
    let n_out = (src.len() as f64 * ratio).round() as usize;
    let mut out = Vec::with_capacity(n_out);
    for i in 0..n_out {
        let p = i as f64 / ratio;
        let base = p.floor() as i64;
        let (mut acc, mut wsum) = (0f64, 0f64);
        for k in -2..=3 {
            let idx = base + k;
            if idx < 0 || idx as usize >= src.len() {
                continue;
            }
            let w = lanczos(p - idx as f64, 3.0);
            acc += src[idx as usize] as f64 * w;
            wsum += w;
        }
        out.push(if wsum.abs() > 1e-9 { (acc / wsum) as f32 } else { 0.0 });
    }
    out
}

fn lanczos(x: f64, a: f64) -> f64 {
    if x.abs() < 1e-9 {
        return 1.0;
    }
    let pix = std::f64::consts::PI * x;
    let s = pix.sin() / pix;
    let pixa = pix / a;
    s * (pixa.sin() / pixa)
}
