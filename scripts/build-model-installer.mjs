// 打「分离模型包」安装程序（Windows NSIS）。
//
// 为什么不走 `tauri build`：模型包没有界面，只需要「拷两个文件到固定目录 + 写卸载信息」，
// 用 Tauri 为它再编一个应用反而更重。这里直接用 Tauri 自带的 NSIS（makensis），
// 跟主安装包同一套工具链，用户那边看到的就是一个普通的安装向导。
//
// 用法：npm run build:model-installer
// 需要：.cache/models/htdemucs_ft_vocals.onnx 与 .cache/ort/.../onnxruntime.dll
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const payload = join(root, 'sep-installer', 'payload')
const outDir = join(root, 'dist-model')

const MODEL = join(root, '.cache', 'models', 'htdemucs_ft_vocals.onnx')
const DLL = join(
  root,
  '.cache',
  'ort',
  'package',
  'bin',
  'napi-v6',
  'win32',
  'x64',
  'onnxruntime.dll',
)

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1) + ' MB'

function findMakensis() {
  const local = process.env.LOCALAPPDATA
  const cands = [
    local && join(local, 'tauri', 'NSIS', 'makensis.exe'),
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ].filter(Boolean)
  for (const c of cands) if (existsSync(c)) return c
  return null
}

if (!existsSync(MODEL)) {
  console.error(`缺模型文件：${MODEL}`)
  console.error('先下载（镜像）：https://hf-mirror.com/StemSplitio/htdemucs-ft-vocals-onnx')
  process.exit(1)
}
if (!existsSync(DLL)) {
  console.error(`缺 onnxruntime.dll：${DLL}`)
  process.exit(1)
}

mkdirSync(payload, { recursive: true })
mkdirSync(outDir, { recursive: true })
copyFileSync(MODEL, join(payload, 'htdemucs_ft_vocals.onnx'))
copyFileSync(DLL, join(payload, 'onnxruntime.dll'))
console.log(`payload 就绪：模型 ${mb(join(payload, 'htdemucs_ft_vocals.onnx'))} / dll ${mb(join(payload, 'onnxruntime.dll'))}`)

const makensis = findMakensis()
if (!makensis) {
  console.error('找不到 makensis.exe（Tauri 的 NSIS 默认在 %LOCALAPPDATA%\\tauri\\NSIS\\）')
  process.exit(1)
}

const r = spawnSync(makensis, ['/V2', 'model.nsi'], {
  cwd: join(root, 'sep-installer'),
  stdio: 'inherit',
})
if (r.status !== 0) process.exit(r.status ?? 1)

const exe = join(outDir, 'ijipu-bp-sep-model-setup.exe')
if (!existsSync(exe)) {
  console.error('makensis 跑完了但没看到产物')
  process.exit(1)
}
console.log(`✓ 安装包：${exe}（${mb(exe)}）`)
console.log('  装到：%APPDATA%\\com.ijipu.bp\\models（模型 + onnxruntime.dll + model.version）')
void readdirSync
