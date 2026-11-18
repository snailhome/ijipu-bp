@echo off
rem One-click desktop dev launcher (ASCII only: works in cmd.exe on any codepage).
rem Double-click this file. It:
rem   1) cd to this repo (ijipu-bp),
rem   2) put the workspace Rust toolchain (.cargo/.rustup/mingw64) on PATH if present,
rem   3) run "npm run tauri:dev", and keep the window open afterwards.
rem
rem Why not dot-source scripts\tauri-env.ps1 here: that .ps1 is UTF-8 without BOM;
rem Windows PowerShell 5.1 reads it as ANSI and chokes on Chinese text. cmd sets the
rem same three variables (CARGO_HOME / RUSTUP_HOME / PATH) directly.
setlocal
cd /d "%~dp0"

rem Workspace root = parent of this repo (D:\Coding\JianpuScript)
for %%I in ("%~dp0..") do set "WS=%%~fI"

echo [iJipuBP] cwd: %CD%
if exist "%WS%\.cargo" (
  set "CARGO_HOME=%WS%\.cargo"
  set "RUSTUP_HOME=%WS%\.rustup"
  set "PATH=%WS%\.cargo\bin;%WS%\mingw64\bin;%PATH%"
  echo [iJipuBP] using workspace Rust toolchain: %WS%
) else (
  echo [iJipuBP] using system Rust toolchain
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [iJipuBP] cargo not found. Install Rust or put the toolchain in %WS%\.cargo
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [iJipuBP] npm not found. Install Node.js first.
  pause
  exit /b 1
)

if /i "%~1"=="--check" goto :check

rem vite runs with strictPort on 5174; a leftover dev server from last time makes
rem tauri's beforeDevCommand fail with "Port 5174 is already in use".
rem So: if something is listening there, kill it first (it can only be our own vite).
set "BUSY="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"TCP.*:5174 .*LISTENING"') do set "BUSY=%%P"
if defined BUSY (
  echo [iJipuBP] port 5174 is taken by pid %BUSY% - killing it ^(leftover vite^)
  taskkill /f /pid %BUSY% >nul 2>nul
  timeout /t 1 /nobreak >nul
)

echo [iJipuBP] starting tauri dev ...
call npm run tauri:dev
set "CODE=%ERRORLEVEL%"
echo.
echo [iJipuBP] tauri dev exited with code %CODE%.
pause
exit /b %CODE%

:check
rem Keep the metadata command at top level: inside an if (...) block cmd mis-parses "1 >nul".
cargo --version
rustc --version
call npm --version
cargo metadata --manifest-path "src-tauri\Cargo.toml" --no-deps --format-version 1 >nul
if errorlevel 1 (
  echo [iJipuBP] cargo metadata failed for src-tauri\Cargo.toml
  pause
  exit /b 1
)
echo [iJipuBP] check ok
exit /b 0
