//! 两轨分离尖刀（P1）：用 ONNX Runtime 跑 htdemucs_ft 的 vocals 专家，验证「能不能跑、多快、质量够不够」。
//!
//! 模型：StemSplitio/htdemucs-ft-vocals-onnx（MIT），输入 (1,2,343980) 立体声 44.1kHz 7.8 秒，
//! 输出 (1,4,2,343980)，第 4 行才是 vocals。
//! 伴奏 = 原混音 - 人声（逐样本相减），所以只需要跑一次模型。
//!
//! 用法：sep-spike <model.onnx> <in.wav> <outDir> [开始秒] [时长秒]

use std::time::Instant;

use ort::session::Session;
use ort::value::Value;

const SEG: usize = 343_980; // 7.8 s @ 44.1 kHz，模型写死的
const SR: u32 = 44_100;
const OVERLAP: f32 = 0.25;

fn read_wav(path: &str) -> Result<(Vec<f32>, Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("打开 wav 失败: {e}"))?;
    let spec = reader.spec();
    let ch = spec.channels as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.unwrap_or(0.0))
            .collect(),
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max).unwrap_or(0.0))
                .collect()
        }
    };
    let frames = samples.len() / ch;
    let mut l = Vec::with_capacity(frames);
    let mut r = Vec::with_capacity(frames);
    for i in 0..frames {
        l.push(samples[i * ch]);
        r.push(if ch > 1 { samples[i * ch + 1] } else { samples[i * ch] });
    }
    Ok((l, r, spec.sample_rate))
}

fn write_wav(path: &str, l: &[f32], r: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: SR,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| format!("写 wav 失败: {e}"))?;
    for i in 0..l.len() {
        w.write_sample(l[i]).map_err(|e| e.to_string())?;
        w.write_sample(r[i]).map_err(|e| e.to_string())?;
    }
    w.finalize().map_err(|e| e.to_string())
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        return Err("用法: sep-spike <model.onnx> <in.wav> <outDir> [开始秒] [时长秒]".into());
    }
    let model = &args[1];
    let in_wav = &args[2];
    let out_dir = &args[3];
    let start_sec: f32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let dur_sec: Option<f32> = args.get(5).and_then(|s| s.parse().ok());

    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;

    let t0 = Instant::now();
    let (l_all, r_all, sr) = read_wav(in_wav)?;
    if sr != SR {
        return Err(format!("采样率是 {sr}，这个模型只吃 44100"));
    }
    let from = ((start_sec * SR as f32) as usize).min(l_all.len());
    let to = match dur_sec {
        Some(d) => (from + (d * SR as f32) as usize).min(l_all.len()),
        None => l_all.len(),
    };
    let mix_l = &l_all[from..to];
    let mix_r = &r_all[from..to];
    println!("读到 {} 秒（{}–{}），解码耗时 {:.2}s", mix_l.len() as f32 / SR as f32, start_sec, to as f32 / SR as f32, t0.elapsed().as_secs_f32());

    let t1 = Instant::now();
    let env = ort::init().with_name("sep-spike").build().map_err(|e| e.to_string())?;
    let mut session = Session::builder(&env)
        .map_err(|e| e.to_string())?
        .with_intra_threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4))
        .map_err(|e| e.to_string())?
        .commit_from_file(model)
        .map_err(|e| format!("加载模型失败: {e}"))?;
    println!("模型加载 {:.2}s", t1.elapsed().as_secs_f32());
    for i in session.inputs() {
        println!("  输入 {} {:?}", i.name(), i.dtype());
    }
    for o in session.outputs() {
        println!("  输出 {} {:?}", o.name(), o.dtype());
    }

    let n = mix_l.len();
    let stride = (SEG as f32 * (1.0 - OVERLAP)) as usize;
    let mut voc_l = vec![0f32; n];
    let mut voc_r = vec![0f32; n];
    let mut wsum = vec![0f32; n];

    let t2 = Instant::now();
    let mut pos = 0usize;
    let mut seg_idx = 0usize;
    while pos < n {
        let mut in_l = vec![0f32; SEG];
        let mut in_r = vec![0f32; SEG];
        let take = (n - pos).min(SEG);
        in_l[..take].copy_from_slice(&mix_l[pos..pos + take]);
        in_r[..take].copy_from_slice(&mix_r[pos..pos + take]);
        let mut data = vec![0f32; 2 * SEG];
        data[..SEG].copy_from_slice(&in_l);
        data[SEG..].copy_from_slice(&in_r);
        let input = Value::from_array((vec![1usize, 2, SEG], data)).map_err(|e| e.to_string())?;
        let outs = session.run(ort::inputs!["mix" => input]).map_err(|e| format!("推理失败: {e}"))?;
        let (shape, out) = outs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        if seg_idx == 0 {
            println!("  输出形状 {:?}", shape);
        }
        // [1, 4, 2, SEG] → vocals = 第 4 个 stem
        let base = 3 * 2 * SEG;
        for i in 0..take {
            let w = hann_weight(i, take);
            voc_l[pos + i] += out[base + i] * w;
            voc_r[pos + i] += out[base + SEG + i] * w;
            wsum[pos + i] += w;
        }
        seg_idx += 1;
        if pos + SEG >= n {
            break;
        }
        pos += stride;
    }
    let infer = t2.elapsed().as_secs_f32();
    println!("推理 {} 段，用时 {:.2}s（RTF {:.2}x）", seg_idx, infer, infer / (n as f32 / SR as f32));

    for i in 0..n {
        if wsum[i] > 1e-6 {
            voc_l[i] /= wsum[i];
            voc_r[i] /= wsum[i];
        }
    }
    let inst_l: Vec<f32> = (0..n).map(|i| (mix_l[i] - voc_l[i]).clamp(-1.0, 1.0)).collect();
    let inst_r: Vec<f32> = (0..n).map(|i| (mix_r[i] - voc_r[i]).clamp(-1.0, 1.0)).collect();
    let rms = |v: &[f32]| -> f32 { (v.iter().map(|x| x * x).sum::<f32>() / v.len().max(1) as f32).sqrt() };
    println!("RMS 混音 {:.4} / 人声 {:.4} / 伴奏 {:.4}", rms(mix_l), rms(&voc_l), rms(&inst_l));
    write_wav(&format!("{out_dir}/vocals.wav"), &voc_l, &voc_r)?;
    write_wav(&format!("{out_dir}/instrumental.wav"), &inst_l, &inst_r)?;
    println!("写出 {out_dir}/vocals.wav 与 instrumental.wav；总耗时 {:.2}s", t0.elapsed().as_secs_f32());
    // ort 的 Environment 在进程退出时偶尔卡住，尖刀里直接 exit
    std::process::exit(0);
}

/// 交叠区的升余弦权重，边界为 0，避免硬切
fn hann_weight(i: usize, take: usize) -> f32 {
    let x = (i as f32 + 0.5) / take as f32;
    0.5 - 0.5 * (2.0 * std::f32::consts::PI * x).cos()
}
