/**
 * scripts/auto-version.mjs — 打包/发版前按改动自动升应用版本
 *
 * 用户 2026-11-19 口径：各子应用按**功能变更情况**自动升版本，时机是打包/发版前，
 * 不是每次提交。bp 从 0.2.0 起走这套规则（之前的手工 0.1.0 停在 2026-11-19）。
 *
 * 判定口径（与 ../ijipu/docs/VERSIONING.md 一致）：
 *  · 破坏性变更（BREAKING CHANGE / !: / 不兼容 / 破坏性） → MAJOR
 *  · 新增功能（feat / 新增 / 新功能 / 加入 / 支持 / 添加） → MINOR
 *  · 其余代码改动（修复、样式、细节）                     → PATCH
 *  · 只改文档 / 日志 / release-body → 不升版
 *
 * 基线：上一次改动版本文件的提交。之后没有新提交时**不升版**，所以同一提交重复打包
 * 不会一直涨版本号；正常发布流程应先提交改动，再打包。
 *
 * 用法：
 *   node scripts/auto-version.mjs            # 按 package.json 的 name 识别应用
 *   node scripts/auto-version.mjs --dry-run  # 只打印将要升到的版本
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const dryRun = process.argv.includes('--dry-run')

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'))
}

function writeJson(rel, obj) {
  writeFileSync(join(root, rel), `${JSON.stringify(obj, null, 2)}\n`)
}

function setJsonVersion(rel, version) {
  if (!existsSync(join(root, rel))) return false
  const obj = readJson(rel)
  if (obj.version === version) return false
  obj.version = version
  writeJson(rel, obj)
  return true
}

function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (m === null) throw new Error(`版本号格式不认识：${version}`)
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (kind === 'minor') {
    minor += 1
    patch = 0
  } else {
    patch += 1
  }
  return `${major}.${minor}.${patch}`
}

const APPS = {
  'ijipu-bp': {
    label: 'bp',
    baseline: 'src/brand/version.ts',
    versionTs: 'src/brand/version.ts',
    lock: 'package-lock.json',
    lockPackages: [],
    manifests: ['package.json', 'src-tauri/tauri.conf.json'],
    cargoToml: 'src-tauri/Cargo.toml',
    cargoLock: 'src-tauri/Cargo.lock',
    cargoName: 'ijipu-bp',
  },
}

const pkg = readJson('package.json')
const app = APPS[pkg.name]
if (app === undefined) {
  console.error(`[auto-version] 不认识的应用：${pkg.name}`)
  process.exit(1)
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

const base = git(['log', '-1', '--format=%H', '--', app.baseline])
if (base === '') {
  console.error(`[auto-version] ${app.label} 找不到版本文件的历史提交，无法判断版本`)
  process.exit(1)
}

const commits = git(['log', '--format=%s%n%b', `${base}..HEAD`]).trim()
const changed = git(['diff', '--name-only', `${base}..HEAD`])
  .split(/\r?\n/)
  .filter(Boolean)

/** 文档 / 日志 / 构建产物不算“功能变更” */
const isCode = (file) =>
  !/\.md$/i.test(file) &&
  !/^docs\//i.test(file) &&
  !/^CHANGELOG/i.test(file) &&
  !/^release-body/i.test(file) &&
  !/^\.dsh\//i.test(file) &&
  !/\.log$/i.test(file)

if (!changed.some(isCode)) {
  console.log(`[auto-version] ${app.label}：自 ${base.slice(0, 8)} 起没有代码改动，版本保持 ${pkg.version}`)
  process.exit(0)
}

if (commits === '') {
  console.log(`[auto-version] ${app.label}：没有新的已提交改动；先提交功能改动再打包，版本保持 ${pkg.version}`)
  process.exit(0)
}

let kind = 'patch'
if (/BREAKING[ -]?CHANGE|!:\s|不兼容|破坏性/i.test(commits)) kind = 'major'
else if (/^feat(\(|:)|^feature|新增|新功能|加入|支持|添加|功能/mi.test(commits)) kind = 'minor'

const current = pkg.version
const next = bump(current, kind)
console.log(`[auto-version] ${app.label}：${current} → ${next}（${kind.toUpperCase()}）`)
if (dryRun) {
  console.log('[auto-version] --dry-run，不写文件')
  process.exit(0)
}

/** 版本号唯一来源：TS 常量或 package.json */
if (app.versionTs !== null) {
  const file = join(root, app.versionTs)
  const raw = readFileSync(file, 'utf8')
  const nextRaw = raw.replace(/(export const APP_VERSION = ')([^']+)(')/, `$1${next}$3`)
  if (nextRaw === raw) throw new Error(`${app.versionTs} 里没找到 APP_VERSION`)
  writeFileSync(file, nextRaw)
}

for (const rel of app.manifests) {
  setJsonVersion(rel, next)
}

if (app.lock !== null && existsSync(join(root, app.lock))) {
  const lock = readJson(app.lock)
  if (lock.version !== next) lock.version = next
  if (lock.packages?.[''] !== undefined) lock.packages[''].version = next
  for (const name of app.lockPackages) {
    if (lock.packages?.[name] !== undefined) lock.packages[name].version = next
  }
  writeJson(app.lock, lock)
}

/** Rust 侧版本跟着走，否则 exe 属性里是旧号 */
if (app.cargoToml !== undefined && existsSync(join(root, app.cargoToml))) {
  const file = join(root, app.cargoToml)
  const raw = readFileSync(file, 'utf8')
  const nextRaw = raw.replace(/(\[package\][\s\S]*?^version = ")([^"]+)(")/m, `$1${next}$3`)
  if (nextRaw === raw) throw new Error(`${app.cargoToml} 里没找到 [package] version`)
  writeFileSync(file, nextRaw)
}

if (app.cargoLock !== undefined && existsSync(join(root, app.cargoLock))) {
  const file = join(root, app.cargoLock)
  const raw = readFileSync(file, 'utf8')
  const nextRaw = raw.replace(
    new RegExp(`(name = "${app.cargoName}"\\nversion = ")([^"]+)(")`),
    `$1${next}$3`,
  )
  if (nextRaw !== raw) writeFileSync(file, nextRaw)
}

console.log(`[auto-version] ${app.label} 版本已更新到 ${next}`)
