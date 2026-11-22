/**
 * audio/recordingCache.ts — 录音音频的 IndexedDB 暂存（用户 2026-11-22）
 *
 * 为什么不能只放内存：用户要求「录音中 / 刚录完就关掉应用」也能下次接着干，和别的模式
 * （打开音频后自动写 `bp.cache`）保持一致。方案 JSON 很小、继续放 localStorage；音频几十 MB，
 * 放 IndexedDB（桌面 WebView2 / 浏览器都支持），键就用录音方案的合成路径 `recording:<名字>`。
 *
 * 只存**录音的原始 webm/opus 字节**（比 WAV 小得多），恢复时再 `decodeAudioData`。
 * Node 冒烟没有 IndexedDB：所有函数先判 `typeof indexedDB === 'undefined'`，静默返回。
 */

const DB_NAME = 'ijipu-bp-recordings'
const STORE = 'audio'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('这个环境没有 IndexedDB'))
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('录音缓存打不开'))
    })
  }
  return dbPromise
}

/** 把一段录音原始字节写进 IndexedDB（同一个 key 覆盖） */
export async function putRecordingAudio(key: string, blob: Blob): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(blob, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('录音缓存写不进去'))
    tx.onabort = () => reject(tx.error ?? new Error('录音缓存写入被中止'))
  })
}

/** 读回录音原始字节；没有返回 null */
export async function getRecordingAudio(key: string): Promise<Blob | null> {
  if (typeof indexedDB === 'undefined') return null
  const db = await openDb()
  return new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null)
    req.onerror = () => reject(req.error ?? new Error('录音缓存读不出来'))
  })
}

/** 删除一段录音缓存（保存成 WAV 或换新方案后清掉，别让 IndexedDB 越攒越大） */
export async function deleteRecordingAudio(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('录音缓存删不掉'))
  })
}
