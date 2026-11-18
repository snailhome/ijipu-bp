/**
 * App.tsx — 爱扒谱的主界面
 *
 * 布局：上面工具条；中间左「频谱 / 音符 / 简谱预览」三块，右「调性 + 生成参数」。
 * 数据流：打开音频 → worker 分析 → store 出 grid/jps → 画布与预览都读 store。
 * 播放两种模式（原音频 / 合成音）共用播放头；Tab 键随时切换（用户要求）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { keyDisplayName } from './analysis/pitchNames'
import { pickAndLoadAudio } from './audio/decode'
import { play, setAudioBuffer, stop, type PlayMode } from './audio/player'
import { COPY } from './brand/copy'
import { APP_VERSION } from './brand/version'
import { invoke, isTauriShell } from './brand/env'
import { useBp } from './model/store'
import type { AnalyzeResult } from './model/types'
import { JpsPreview } from './ui/JpsPreview'
import { NoteRoll } from './ui/NoteRoll'
import { Spectrogram } from './ui/Spectrogram'

const KEY_CHOICES = Array.from({ length: 12 }, (_, i) => i)

export default function App() {
  const fileName = useBp((s) => s.fileName)
  const durationMs = useBp((s) => s.durationMs)
  const analysis = useBp((s) => s.analysis)
  const busy = useBp((s) => s.busy)
  const error = useBp((s) => s.error)
  const playing = useBp((s) => s.playing)
  const currentMs = useBp((s) => s.currentMs)
  const playMode = useBp((s) => s.playMode)
  const pitchMode = useBp((s) => s.pitchMode)
  const tonic = useBp((s) => s.tonic)
  const bpm = useBp((s) => s.bpm)
  const beatsPerBar = useBp((s) => s.beatsPerBar)
  const firstBeatMs = useBp((s) => s.firstBeatMs)
  const title = useBp((s) => s.title)
  const jps = useBp((s) => s.jps)
  const grid = useBp((s) => s.grid)
  const warnings = useBp((s) => s.warnings)

  const set = useBp
  const [notice, setNotice] = useState<string | null>(null)
  const workerRef = useRef<Worker | null>(null)

  /* ---------- 分析 worker ---------- */
  useEffect(() => {
    const w = new Worker(new URL('./worker/analyze.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<{ ok: boolean; result?: AnalyzeResult; error?: string }>) => {
      const msg = e.data
      if (msg.ok && msg.result) {
        set.getState().setAnalysis(msg.result)
        set.getState().setBusy(null)
        setNotice(`分析完成：${msg.result.notes.length} 个音，BPM ${msg.result.bpm}`)
      } else {
        set.getState().setError(msg.error ?? '分析失败')
        set.getState().setBusy(null)
      }
    }
    workerRef.current = w
    return () => {
      w.terminate()
      workerRef.current = null
    }
  }, [set])

  /* ---------- 打开音频 ---------- */
  const openAudio = useCallback(async () => {
    const st = set.getState()
    st.setError(null)
    setNotice(null)
    st.setBusy('正在读文件…')
    try {
      const loaded = await pickAndLoadAudio()
      if (!loaded) {
        st.setBusy(null)
        return
      }
      stop()
      st.setPlaying(false)
      st.setLoaded({ fileName: loaded.name, filePath: loaded.path, durationMs: loaded.durationMs })
      setAudioBuffer(loaded.buffer)
      st.setBusy(COPY.analyzing)
      const w = workerRef.current
      if (!w) throw new Error('分析线程没起来')
      w.postMessage({ samples: loaded.samples, sampleRate: loaded.sampleRate }, [
        loaded.samples.buffer as ArrayBuffer,
      ])
    } catch (e) {
      st.setError(e instanceof Error ? e.message : String(e))
      st.setBusy(null)
    }
  }, [set])

  /* ---------- 播放 ---------- */
  const startPlay = useCallback(async (fromMs: number, mode: PlayMode) => {
    const st = set.getState()
    if (!st.analysis) return
    await play(fromMs, mode, st.analysis.notes, st.durationMs, {
      onTick: (ms) => set.getState().setCurrentMs(ms),
      onEnd: () => set.getState().setPlaying(false),
    })
    set.getState().setPlaying(true)
  }, [set])

  const togglePlay = useCallback(() => {
    const st = set.getState()
    if (st.playing) {
      stop()
      st.setPlaying(false)
      return
    }
    if (!st.analysis) return
    void startPlay(st.currentMs >= st.durationMs ? 0 : st.currentMs, st.playMode)
  }, [set, startPlay])

  const switchMode = useCallback(
    (m: PlayMode) => {
      const st = set.getState()
      st.setPlayMode(m)
      if (st.playing) {
        stop()
        void startPlay(st.currentMs, m)
      }
    },
    [set, startPlay],
  )

  const seek = useCallback(
    (ms: number) => {
      const st = set.getState()
      st.setCurrentMs(ms)
      if (st.playing) {
        stop()
        void startPlay(ms, st.playMode)
      }
    },
    [set, startPlay],
  )

  /* ---------- 热键：空格播放/暂停，Tab 切 A/B ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Tab') {
        e.preventDefault()
        switchMode(set.getState().playMode === 'audio' ? 'synth' : 'audio')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [set, switchMode, togglePlay])

  /* ---------- 导出 ---------- */
  const exportJps = useCallback(async () => {
    const st = set.getState()
    const name = `${st.title || '爱扒谱导出'}.jps`
    if (isTauriShell()) {
      const saved = await invoke<string | null>('bp_save_jps', { suggested: name, text: st.jps })
      setNotice(saved ? `已保存：${saved}` : null)
      return
    }
    const blob = new Blob([st.jps], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
    setNotice(`已下载：${name}`)
  }, [set])

  const candidates = analysis?.keyCandidates.slice(0, 6) ?? []

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">
          {COPY.appName}
          <small>
            {COPY.appNameEn} {APP_VERSION}
          </small>
        </span>
        <button className="primary" onClick={() => void openAudio()} disabled={!!busy}>
          {COPY.openAudio}
        </button>
        <button onClick={togglePlay} disabled={!analysis}>
          {playing ? COPY.pause : COPY.play}
        </button>
        <div className="seg" title={COPY.abTip}>
          <button className={playMode === 'audio' ? 'on' : ''} onClick={() => switchMode('audio')}>
            {COPY.sourceAudio}
          </button>
          <button className={playMode === 'synth' ? 'on' : ''} onClick={() => switchMode('synth')}>
            {COPY.sourceSynth}
          </button>
        </div>

        <div className="spacer" />

        <label className="field">
          {COPY.keyLabel}
          <select value={tonic} onChange={(e) => useBp.getState().setTonic(Number(e.target.value))}>
            {KEY_CHOICES.map((k) => (
              <option key={k} value={k}>
                {keyDisplayName(k)} 大调
              </option>
            ))}
          </select>
        </label>
        <div className="seg" title="卷帘上写字用音名还是简谱数字（换调号数字跟着变）">
          <button className={pitchMode === 'name' ? 'on' : ''} onClick={() => useBp.getState().setPitchMode('name')}>
            {COPY.pitchName}
          </button>
          <button className={pitchMode === 'number' ? 'on' : ''} onClick={() => useBp.getState().setPitchMode('number')}>
            {COPY.pitchNumber}
          </button>
        </div>
        <button onClick={() => void exportJps()} disabled={!jps}>
          {COPY.exportJps}
        </button>
      </div>

      <div className="body">
        <div className="main">
          <Spectrogram spectrum={analysis?.spectrum ?? null} durationMs={durationMs} onSeek={seek} playMs={currentMs} />
          <NoteRoll
            notes={analysis?.notes ?? []}
            grid={grid}
            bpm={bpm}
            beatsPerBar={beatsPerBar}
            firstBeatMs={firstBeatMs}
            durationMs={durationMs}
            pitchMode={pitchMode}
            tonic={tonic}
            onSeek={seek}
            playMs={currentMs}
          />
          <JpsPreview jps={jps} />
        </div>

        <div className="side">
          <div>
            <h3>{COPY.keyPanelTitle}</h3>
            <div className="keys">
              {candidates.length === 0 && <div className="hint">{COPY.keyPanelHint}</div>}
              {candidates.map((c) => (
                <div
                  key={c.tonic}
                  className={`key-row${c.tonic === tonic ? ' on' : ''}`}
                  onClick={() => useBp.getState().setTonic(c.tonic)}
                  title="点一下就把调号定成它"
                >
                  <span className="key-name">{keyDisplayName(c.tonic)}</span>
                  <span className="bar">
                    <i style={{ width: `${Math.round(c.share * 100)}%` }} />
                  </span>
                  <span className="key-share">{(c.share * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              {COPY.keyPanelHint}
            </div>
          </div>

          <div>
            <h3>生成参数</h3>
            <div style={{ display: 'grid', gap: 6 }}>
              <label className="field">
                标题
                <input
                  style={{ width: 150 }}
                  value={title}
                  onChange={(e) => useBp.getState().setTitle(e.target.value)}
                />
              </label>
              <label className="field">
                {COPY.bpmLabel}
                <input
                  type="number"
                  value={Math.round(bpm)}
                  min={20}
                  max={300}
                  onChange={(e) => useBp.getState().setBpm(Number(e.target.value))}
                />
              </label>
              <label className="field">
                {COPY.meterLabel}
                <input
                  type="number"
                  value={beatsPerBar}
                  min={1}
                  max={12}
                  onChange={(e) => useBp.getState().setBeatsPerBar(Number(e.target.value))}
                />
                / 4
              </label>
              <label className="field">
                {COPY.firstBeatLabel}
                <input
                  type="number"
                  value={Math.round(firstBeatMs)}
                  step={10}
                  onChange={(e) => useBp.getState().setFirstBeatMs(Number(e.target.value))}
                />
                ms
              </label>
              <div className="hint">改哪一项都只重算"拍轴"，原始秒轴不动。</div>
            </div>
          </div>

          {warnings.length > 0 && (
            <div>
              <h3>{COPY.warnings}</h3>
              <div className="warn">
                {warnings.slice(0, 6).map((w, i) => (
                  <div key={i}>· {w}</div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h3>{COPY.jpsTitle}</h3>
            <pre className="src">{jps || '（空）'}</pre>
          </div>
        </div>
      </div>

      <div className="status">
        <span>{fileName ?? COPY.empty}</span>
        <span>{durationMs ? `${(durationMs / 1000).toFixed(1)}s` : ''}</span>
        <span>{analysis ? `${analysis.notes.length} 个音` : ''}</span>
        <span>{busy ?? ''}</span>
        <span className="spacer" />
        {error && <span className="err">{error}</span>}
        {notice && <span className="hint">{notice}</span>}
        <span className="hint">空格播放 · Tab 切换原音/合成</span>
      </div>
    </div>
  )
}
