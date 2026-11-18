// 桌面壳入口：真正的逻辑在 lib.rs（照 iJipu 的结构，方便以后加移动端）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ijipu_bp_lib::run()
}
