//! 爱扒谱的桌面能力：**只做三件前端做不到的事** —— 选文件、按路径读字节、写文件并回读校验。
//!
//! 为什么都放在 Rust 侧：
//!  · 浏览器给的 `<input type=file>` 只有临时句柄、拿不到磁盘路径，下次开还得重选；
//!  · 解码与 DSP 全在前端（纯 TS、Node 里能冒烟），这里只搬运字节，不碰音频格式。
//! 所有命令都是"要么成、要么带中文原因报错"，前端直接把字符串贴到状态栏。

mod sep;

use std::path::PathBuf;

use tauri::ipc::Response;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const AUDIO_EXTS: &[&str] = &["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "webm"];

fn path_of(p: tauri_plugin_dialog::FilePath) -> Result<PathBuf, String> {
    p.into_path().map_err(|e| format!("这个路径用不了：{e}"))
}

/// 弹系统对话框选音频，返回**磁盘路径**（取消时 None）。
#[tauri::command]
async fn bp_pick_audio(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选一个音频文件")
            .add_filter("音频文件", AUDIO_EXTS)
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("对话框没起来：{e}"))?;

    match picked {
        Some(p) => Ok(Some(path_of(p)?.to_string_lossy().into_owned())),
        None => Ok(None),
    }
}

/// 按路径读原始字节。前端拿到后自己 `decodeAudioData`。
#[tauri::command]
fn bp_read_audio(path: String) -> Result<Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读不到文件 {path}：{e}"))?;
    Ok(Response::new(bytes))
}

/// 启动参数里带的音频（`ijipu-bp.exe 某曲.mp3`）：给"双击关联"和自动化验证用。
/// 只认后缀在 AUDIO_EXTS 里、而且**文件真的存在**的参数，其余忽略。
#[tauri::command]
fn bp_initial_audio() -> Option<String> {
    std::env::args().skip(1).find(|arg| {
        let lower = arg.to_lowercase();
        AUDIO_EXTS.iter().any(|ext| lower.ends_with(&format!(".{ext}")))
            && std::path::Path::new(arg).is_file()
    })
}

/// 另存为 .jps，写完**立刻回读比对**（防止半截文件被当成导出成功）。
#[tauri::command]
async fn bp_save_jps(
    app: tauri::AppHandle,
    suggested: String,
    text: String,
) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("导出 .jps")
            .add_filter("iJipu 简谱", &["jps"])
            .set_file_name(&suggested)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("对话框没起来：{e}"))?;

    let Some(p) = picked else { return Ok(None) };
    let path = path_of(p)?;
    std::fs::write(&path, text.as_bytes()).map_err(|e| format!("写不进去：{e}"))?;
    let back = std::fs::read_to_string(&path).map_err(|e| format!("回读失败：{e}"))?;
    if back != text {
        return Err("写入校验没过：回读内容与要写的不一致".into());
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 保存录音音频（WAV）：弹原生另存为，写盘后**回读字节比对**。
///
/// 用户 2026-11-22：录音方案的「保存方案」先落到一个真实音频文件，再把 `.bp.json`
/// 写在它旁边；所以这条命令只负责"选路径 + 把前端编好的 WAV 字节写进去"。
#[tauri::command]
async fn bp_save_audio(
    app: tauri::AppHandle,
    suggested: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("保存录音音频")
            .add_filter("WAV 音频", &["wav"])
            .set_file_name(&suggested)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("对话框没起来：{e}"))?;

    let Some(p) = picked else { return Ok(None) };
    let mut path = path_of(p)?;
    /* 用户在对话框里把后缀删了也补回来：方案路径按 .wav 拼，后面打开才找得到 */
    let is_wav = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("wav"))
        .unwrap_or(false);
    if !is_wav {
        path.set_extension("wav");
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("写不进去 {}：{e}", path.display()))?;
    let back = std::fs::read(&path).map_err(|e| format!("回读失败：{e}"))?;
    if back != bytes {
        return Err("写入校验没过：回读字节与要写的不一致".into());
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 读方案文本（UTF-8）。方案文件跟音频放一起，路径由前端拼。
#[tauri::command]
fn bp_read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读不到 {path}：{e}"))
}

/// 写方案文本，写完**立刻回读比对**：半截文件会变成"读不了的方案"，不能静默成功。
#[tauri::command]
fn bp_write_text(path: String, text: String) -> Result<(), String> {
    if let Some(dir) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建不了目录 {}：{e}", dir.display()))?;
    }
    std::fs::write(&path, text.as_bytes()).map_err(|e| format!("写不进去 {path}：{e}"))?;
    let back = std::fs::read_to_string(&path).map_err(|e| format!("回读失败：{e}"))?;
    if back != text {
        return Err("写入校验没过：回读内容与要写的不一致".into());
    }
    Ok(())
}

/// 选一个方案文件（`.bp.json`）。
#[tauri::command]
async fn bp_pick_project(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("打开扒谱方案")
            .add_filter("爱扒谱方案", &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("对话框没起来：{e}"))?;

    match picked {
        Some(p) => Ok(Some(path_of(p)?.to_string_lossy().into_owned())),
        None => Ok(None),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            bp_pick_audio,
            bp_read_audio,
            bp_initial_audio,
            bp_save_jps,
            bp_save_audio,
            bp_read_text,
            bp_write_text,
            bp_pick_project,
            sep::bp_sep_model,
            sep::bp_sep_model_target,
            sep::bp_sep_ready,
            sep::bp_open_url,
            sep::bp_download_model,
            sep::bp_separate
        ])
        .setup(|app| {
            // 窗口图标（标题栏左上角 + 任务栏）= 品牌图，与 public/icons、src-tauri/icons
            // 是同一张 png。exe 文件图标走 bundle.icon 的 icon.ico（编译期由 tauri-build 嵌入），
            // 安装包快捷方式沿用 exe 图标，所以三处保持一致。
            // 取不到窗口就跳过：图标不是功能，不该拦住启动。
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(icon) =
                    tauri::image::Image::from_bytes(include_bytes!("../../public/icons/logo-bp.png"))
                {
                    let _ = win.set_icon(icon);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("爱扒谱启动失败");
}
