/**
 * audio/beatClick.ts — 节拍器音色（直接搬 noteDigger 的采样）
 *
 * noteDigger 的 `core/app_midiplayer.js` 里把节拍声写成一段 mp3 的 data URI
 * （`CLICK_SOUND_BASE64`，Lavf62 编码、约 1KB），用 `decodeAudioData` 解码后
 * 每个拍点播一次。这里照搬同一条 data URI，音色和它一致；解码失败就退回播放层
 * 自带的振荡器"嗒"。
 */
export const BEAT_CLICK_URI =
  'data:audio/mpeg;base64,SUQzBAAAAAABRlRFTkMAAAAMAAADT3JpZ2luYXRvcgBUWFhYAAAAKgAAA29yaWdpbmF0b3JfcmVmZXJlbmNlAE9yaWdpbmF0b3JSZWZlcmVuY2UAVERSQwAAAAwAAAMyMDAwOjAwOjAwAFRYWFgAAAAeAAADY29kaW5nX2hpc3RvcnkAQ29kaW5nSGlzdG9yeQBUWFhYAAAAEgAAA3RpbWVfcmVmZXJlbmNlADAAVFNTRQAAAA4AAANMYXZmNjIuNC4xMDAAAAAAAAAAAAAAAP/7UMAAAAAAAAAAAAAAAAAAAAAAAEluZm8AAAAPAAAAAgAAAnEAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqv//////////////////////////////////////////////////////////////////AAAAAExhdmM2Mi4xMwAAAAAAAAAAAAAAACQEWgAAAAAAAAJxo1jtAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+1DEAAAJTFdXNBSAAZig7j8woAD1QEAAAIAJQAUExuAC/vf4Qyc5oyMVo9UFYJgmCYJhsnB8EDkH38QA+UBCJAQBAEHMg+D/wffg4GC4Pg+7+oHz5QEP+UDHOf4IAhl6hqZmRkhAAA2Gw2GAwIAmkAHzrD7iq7X2AqopRMhZ060gz1e2F2Ng2m1AtBbGIrF+IwgRk5RPyEesIcvUwet9xkRllReab+aw4cTGp5rf5EyEI9IGY3///RCJomX/8Akgk06BXPUgABsYAFWM2a0N//tSxAUDy817Jv2FAAgAADSAAAAET0ApeqwoITVM6TNhUkXiVM41cLoCkA0DURhcgUQKINoiiZ6mkI9HpykJKab6mmmmzjjWOOepptc447mm6HHHfzjv6///////6Hf//oc+v//1NNIRqkxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo='

let cache: AudioBuffer | null = null
let loading: Promise<AudioBuffer | null> | null = null

/** 解码一次、缓存；失败返回 null（播放层退回振荡器） */
export function loadBeatClick(ctx: AudioContext): Promise<AudioBuffer | null> {
  if (cache) return Promise.resolve(cache)
  if (loading) return loading
  loading = (async () => {
    try {
      const res = await fetch(BEAT_CLICK_URI)
      cache = await ctx.decodeAudioData(await res.arrayBuffer())
      return cache
    } catch {
      return null
    } finally {
      loading = null
    }
  })()
  return loading
}
