//! 爱扒谱的桌面能力：**只做三件前端做不到的事** —— 选文件、按路径读字节、写文件并回读校验。
//!
//! 为什么都放在 Rust 侧：
//!  · 浏览器给的 `<input type=file>` 只有临时句柄、拿不到磁盘路径，下次开还得重选；
//!  · 解码与 DSP 全在前端（纯 TS、Node 里能冒烟），这里只搬运字节，不碰音频格式。
//! 所有命令都是"要么成、要么带中文原因报错"，前端直接把字符串贴到状态栏。

use std::path::PathBuf;

use tauri::ipc::Response;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            bp_pick_audio,
            bp_read_audio,
            bp_save_jps
        ])
        .run(tauri::generate_context!())
        .expect("爱扒谱启动失败");
}
