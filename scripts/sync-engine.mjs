/**
 * scripts/sync-engine.mjs — 把 iJipu 的引擎源码逐字节同步到 `vendor/engine`
 *
 * 与 ijipu-cp（爱出片）/ obsidian-ijipu 同一套做法：
 *  · 引擎没发 npm，只在 iJipu 仓库的 `packages/ijipu-engine/src/engine`；
 *  · 整目录替换（先删后拷），不做增量合并——避免删掉的源文件还留在 vendor 里；
 *  · 同步完写 `vendor/ENGINE-SNAPSHOT.json`：源提交、文件数、内容哈希、时间；
 *  · `--check` 只比对不写盘（哈希不一致退出 1），给冒烟用。
 *
 * 用法：
 *   node scripts/sync-engine.mjs            # 同步
 *   node scripts/sync-engine.mjs --check    # 只校验
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 工作区里 iJipu 应用仓库的位置（本仓库与它并列） */
const IJIPU = resolve(root, '../ijipu')
const SRC = join(IJIPU, 'packages/ijipu-engine/src/engine')
const VENDOR = join(root, 'vendor/engine')
const SNAPSHOT = join(root, 'vendor/ENGINE-SNAPSHOT.json')
const CHECK = process.argv.includes('--check')

/** 递归列出所有 `.ts`（相对路径、正斜杠、排序后参与哈希，保证跨平台一致） */
function tsFiles(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p, base))
    else if (name.endsWith('.ts')) out.push(relative(base, p).replace(/\\/g, '/'))
  }
  return out.sort()
}

function hashOf(dir) {
  const h = createHash('sha256')
  const files = tsFiles(dir)
  for (const rel of files) {
    h.update(rel)
    h.update('\0')
    h.update(readFileSync(join(dir, rel)))
    h.update('\0')
  }
  return { hash: h.digest('hex'), files: files.length }
}

function gitHead() {
  try {
    return execFileSync('git', ['-C', IJIPU, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

if (!existsSync(SRC)) {
  console.error(`找不到引擎源码：${SRC}`)
  console.error('请确认本仓库与 ijipu 并列放在同一个工作区里。')
  process.exit(1)
}

const src = hashOf(SRC)

/** 上一次的快照（同步时用来判断"引擎真的变了吗"） */
let previous = null
try {
  previous = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
} catch {
  previous = null
}

if (CHECK) {
  if (!existsSync(VENDOR)) {
    console.error('vendor/engine 不存在，先跑一次 npm run sync:engine')
    process.exit(1)
  }
  const vend = hashOf(VENDOR)
  if (vend.hash !== src.hash || vend.files !== src.files) {
    console.error('vendor/engine 与源不一致：')
    console.error(`  源：    ${src.files} 个文件，${src.hash}`)
    console.error(`  vendor：${vend.files} 个文件，${vend.hash}`)
    process.exit(1)
  }
  console.log(`vendor/engine 一致：${src.files} 个文件，${src.hash}`)
  process.exit(0)
}

rmSync(VENDOR, { recursive: true, force: true })
mkdirSync(VENDOR, { recursive: true })
cpSync(SRC, VENDOR, { recursive: true })

const after = hashOf(VENDOR)
if (after.hash !== src.hash) {
  console.error('拷贝后哈希不一致（拷贝时源目录变了？），请重跑一次。')
  process.exit(1)
}

writeFileSync(
  SNAPSHOT,
  `${JSON.stringify(
    {
      note: '本目录由 scripts/sync-engine.mjs 从 ijipu/packages/ijipu-engine/src/engine 逐字节同步，勿手改。',
      source: 'ijipu/packages/ijipu-engine/src/engine',
      // 引擎没变时保持旧值：否则 iJipu 那边每提交一次文档，这里就多一条噪声改动。
      // 判断以 hash 为准（commit 只是"方便人看"的注脚）。
      commit: previous?.hash === after.hash ? previous.commit : gitHead(),
      files: after.files,
      hash: after.hash,
      syncedAt: previous?.hash === after.hash ? previous.syncedAt : new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log(`已同步 vendor/engine：${after.files} 个文件，${after.hash}`)
