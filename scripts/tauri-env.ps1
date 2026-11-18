# scripts/tauri-env.ps1 — Rust/Tauri 环境变量（dot-source 后在当前会话生效）
#
# 用法： . .\scripts\tauri-env.ps1
#
# 为什么需要这个脚本（而不是直接 cargo build）：
#   · 这台机器的工具链装在**工作区**里（`<工作区>\.cargo`、`.rustup`、`mingw64`），
#     不在默认的 `~\.cargo` / `~\.rustup`；不设 CARGO_HOME/RUSTUP_HOME 就找不到。
#   · 每条 pwsh 命令都是**独立进程** ⇒ 跑 cargo/tauri 前必须先 dot-source 一次。
#   · Windows 上没有 MSVC 链接器，用的是 **GNU 工具链**（stable-x86_64-pc-windows-gnu
#     + winlibs MinGW64 的 gcc）⇒ PATH 里必须带上 `mingw64\bin`。
#
# 按**脚本自身位置**推导工作区根；推导不出来就什么都不改，
# 普通开发者用自己的 rustup/cargo（~\.cargo）即可，完全不受影响。

$repoRoot = Split-Path -Parent $PSScriptRoot            # <...>/ijipu-bp
$workspaceRoot = Split-Path -Parent $repoRoot           # 工作区根

$cargoHome = Join-Path $workspaceRoot '.cargo'
$rustupHome = Join-Path $workspaceRoot '.rustup'
$mingwBin = Join-Path $workspaceRoot 'mingw64\bin'

if (Test-Path $cargoHome) {
  $env:CARGO_HOME = $cargoHome
  $env:RUSTUP_HOME = $rustupHome
  $env:PATH = "$cargoHome\bin;$mingwBin;$env:PATH"
  Write-Host "Rust env: 使用工作区工具链 -> $workspaceRoot" -ForegroundColor Cyan
} else {
  Write-Host "Rust env: 未发现工作区工具链，沿用你自己的 rustup/cargo" -ForegroundColor Cyan
}

$rustcV = 'rustc 不可用'
$cargoV = 'cargo 不可用'
try { $rustcV = (& rustc --version 2>&1 | Out-String).Trim() } catch { }
try { $cargoV = (& cargo --version 2>&1 | Out-String).Trim() } catch { }
Write-Host "  $rustcV / $cargoV" -ForegroundColor DarkGray
