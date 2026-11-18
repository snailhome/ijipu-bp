/**
 * App.tsx — 爱扒谱的主界面
 *
 * 布局（用户 m01788 之后的形态）：上面工具条；中间左边「音符表 + 简谱流线谱」占满，
 * 右边「调性 + 生成参数 + jps 源码」。
 *
 * 独立的频谱面板已经撤掉 —— 频谱能量直接铺在音符表的格子里当热力图，
 * 把纵向空间全让给"音高 × 时间"的表格（对照 noteDigger 的信息密度）。
 *
 * 数据流：打开音频 → worker 分析 → store 出 grid/jps → 画布与预览都读 store。
 * 播放两种模式（原音频 / 合成音）共用播放头；Tab 随时切换；空格播放；F2/F3 切点击模式。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { keyColor, keyDisplayName } from './analysis/pitchNames'
import { loadAudioFromPath, pickAndLoadAudio, type LoadedAudio } from './audio/decode'
import { play, setAudioBuffer, stop, audition, type PlayMode } from './audio/player'
import { COPY } from './brand/copy'
import { APP_VERSION } from './brand/version'
import { invoke, isTauriShell } from './brand/env'
import { useBp } from './model/store'
import { spanMs } from './ui/timeAxis'
import type { AnalyzeResult, LoopRange, SnapMode } from './model/types'
import { NoteRoll } from './ui/NoteRoll'
import { StripPreview } from './ui/StripPreview'

const KEY_CHOICES = Array.from({ length: 12 }, (_, i) => i)
const SNAP_CHOICES: Array<{ v: SnapMode; label: string }> = [
  { v: 'off', label: COPY.snapOff },
  { v: 'grid', label: COPY.snapGrid },
  { v: 'beat', label: COPY.snapBeat },
  { v: 'bar', label: COPY.snapBar },
]

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
  const mode = useBp((s) => s.mode)
  const snap = useBp((s) => s.snap)
  const view = useBp((s) => s.view)
  const loop = useBp((s) => s.loop)
  const loopOn = useBp((s) => s.loopOn)
  const autoPage = useBp((s) => s.autoPage)
  const gain = useBp((s) => s.gain)
  const contrast = useBp((s) => s.contrast)
  const suppress = useBp((s) => s.suppress)
  const rhythm = useBp((s) => s.rhythm)
  const tonic = useBp((s) => s.tonic)
  const bpm = useBp((s) => s.bpm)
  const beatsPerBar = useBp((s) => s.beatsPerBar)
  const firstBeatMs = useBp((s) => s.firstBeatMs)
  const title = useBp((s) => s.title)
  const jps = useBp((s) => s.jps)
  const grid = useBp((s) => s.grid)
  const notes = useBp((s) => s.notes)

  const set = useBp
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const workerRef = useRef<Worker | null>(null)
  /* 分析用过的样本留着：调'去谐波'要把同一段音频重跑一遍，不能重新选文件 */
  const samplesRef = useRef<{ samples: Float32Array; sampleRate: number } | null>(null)

  const confirmedCount = useMemo(() => notes.filter((n) => n.confirmed).length, [notes])
  const warnings = useBp((s) => s.warnings)

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
    w.onerror = () => {
      set.getState().setError('分析线程出错')
      set.getState().setBusy(null)
    }
    workerRef.current = w
    return () => {
      w.terminate()
      workerRef.current = null
    }
  }, [set])

  /* ---------- 打开音频 ---------- */
  /** 装载 + 起分析：选文件和"启动参数带文件"都走这一条，避免两套逻辑 */
  const applyLoaded = useCallback(
    (loaded: LoadedAudio) => {
      const st = set.getState()
      stop()
      st.setPlaying(false)
      st.setLoaded({ fileName: loaded.name, filePath: loaded.path, durationMs: loaded.durationMs })
      setAudioBuffer(loaded.buffer)
      st.setBusy(COPY.analyzing)
      const w = workerRef.current
      if (!w) throw new Error('分析线程没起来')
      /* 存一份副本：worker 拿走的是 transfer 过去的 buffer，主线程这边就没数据了 */
      samplesRef.current = {
        samples: new Float32Array(loaded.samples),
        sampleRate: loaded.sampleRate,
      }
      w.postMessage(
        {
          samples: loaded.samples,
          sampleRate: loaded.sampleRate,
          suppress: st.suppress,
          beatsPerBar: st.beatsPerBar,
        },
        [loaded.samples.buffer as ArrayBuffer],
      )
    },
    [set],
  )

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
      applyLoaded(loaded)
    } catch (e) {
      st.setError(e instanceof Error ? e.message : String(e))
      st.setBusy(null)
    }
  }, [applyLoaded, set])

  /* ---------- 启动参数里的音频（桌面壳：双击 / 命令行） ---------- */
  useEffect(() => {
    if (!isTauriShell()) return
    let cancelled = false
    void (async () => {
      try {
        const path = (await invoke<string | null>('bp_initial_audio')) ?? null
        if (!path || cancelled) return
        const loaded = await loadAudioFromPath(path)
        if (!loaded || cancelled) return
        set.getState().setError(null)
        applyLoaded(loaded)
      } catch (e) {
        set.getState().setError(e instanceof Error ? e.message : String(e))
        set.getState().setBusy(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyLoaded, set])

  /* ---------- 去谐波：把同一段音频带着新的强度重跑一遍 ---------- */
  const applySuppress = useCallback(
    (v: number) => {
      const st = set.getState()
      st.setSuppress(v)
      const buf = samplesRef.current
      const w = workerRef.current
      if (!buf || !w) return
      st.setBusy(COPY.analyzing)
      const copy = new Float32Array(buf.samples)
      w.postMessage(
        { samples: copy, sampleRate: buf.sampleRate, suppress: v, beatsPerBar: st.beatsPerBar },
        [copy.buffer as ArrayBuffer],
      )
    },
    [set],
  )
  /* ---------- 播放 ---------- */
  const startPlay = useCallback(async (fromMs: number, m: PlayMode) => {
    const st = set.getState()
    if (!st.analysis) return
    await play(fromMs, m, st.notes, st.durationMs, {
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

  /* ---------- 重复区间：播放到区间末尾就跳回区间开头 ---------- */
  useEffect(() => {
    if (!playing || !loopOn || !loop) return
    if (currentMs < loop.endMs - 12) return
    stop()
    set.getState().setCurrentMs(loop.startMs)
    void startPlay(loop.startMs, playMode)
  }, [currentMs, playing, loopOn, loop, playMode, set, startPlay])

  /* ---------- 自动翻页：播放头快出视野就把视野推过去 ---------- */
  useEffect(() => {
    if (!playing || !autoPage || !durationMs) return
    const span = spanMs(view, durationMs)
    const right = view.panMs + span * 0.82
    if (currentMs > right || currentMs < view.panMs) {
      set.getState().setView({ zoom: view.zoom, panMs: Math.max(0, currentMs - span * 0.25) })
    }
  }, [currentMs, playing, autoPage, durationMs, view, set])

  /** 删音符：顺手把选中态清掉（否则 Delete 会去删一个已经不存在的 id） */
  const removeNote = useCallback((id: string) => {
    useBp.getState().removeNote(id)
    setSelectedId((cur) => (cur === id ? null : cur))
  }, [])

  /* ---------- 热键 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const st = set.getState()
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Tab') {
        e.preventDefault()
        switchMode(st.playMode === 'audio' ? 'synth' : 'audio')
      } else if (e.code === 'F2') {
        e.preventDefault()
        st.setMode('draw')
      } else if (e.code === 'F3') {
        e.preventDefault()
        st.setMode('select')
      } else if (e.code === 'KeyL') {
        st.setLoopOn(!st.loopOn)
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (selectedId) {
          e.preventDefault()
          removeNote(selectedId)
        }
      } else if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        st.setAllConfirmed(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [removeNote, selectedId, set, switchMode, togglePlay])

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
  const setLoop = useCallback(
    (r: LoopRange | null) => {
      set.getState().setLoop(r)
      if (r) set.getState().setLoopOn(true)
    },
    [set],
  )

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">
          {/* 顶栏图标 = 品牌图标（Logo-bp.png；窗口/任务栏图标由 src-tauri/icons 决定） */}
          <img className="brand-logo" src="/icons/Logo-bp.png" alt={COPY.appName} />
          <span className="brand-text">
            {COPY.appName}
            <small>
              {COPY.appNameEn} {APP_VERSION}
            </small>
          </span>
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

        <div className="seg" title={mode === 'draw' ? COPY.modeDrawTip : COPY.modeSelectTip}>
          <button
            className={mode === 'draw' ? 'on' : ''}
            onClick={() => useBp.getState().setMode('draw')}
          >
            {COPY.modeDraw} F2
          </button>
          <button
            className={mode === 'select' ? 'on' : ''}
            onClick={() => useBp.getState().setMode('select')}
          >
            {COPY.modeSelect} F3
          </button>
        </div>

        <label className="field" title="画音/拖音时吸附到哪一格">
          {COPY.snapLabel}
          <select value={snap} onChange={(e) => useBp.getState().setSnap(e.target.value as SnapMode)}>
            {SNAP_CHOICES.map((c) => (
              <option key={c.v} value={c.v}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <button
          className={loopOn ? 'on' : ''}
          onClick={() => useBp.getState().setLoopOn(!loopOn)}
          title={COPY.loopTip}
          disabled={!loop}
        >
          {COPY.loop}
        </button>
        <button
          className={autoPage ? 'on' : ''}
          onClick={() => useBp.getState().setAutoPage(!autoPage)}
          title={COPY.autoPageTip}
        >
          {COPY.autoPage}
        </button>

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
        <div className="seg" title="表格里写字用音名还是简谱数字（换调号数字跟着变）">
          <button className={pitchMode === 'name' ? 'on' : ''} onClick={() => useBp.getState().setPitchMode('name')}>
            {COPY.pitchName}
          </button>
          <button
            className={pitchMode === 'number' ? 'on' : ''}
            onClick={() => useBp.getState().setPitchMode('number')}
          >
            {COPY.pitchNumber}
          </button>
        </div>
        <button onClick={() => useBp.getState().setAllConfirmed(true)} disabled={!notes.length} title={COPY.confirmAllTip}>
          {COPY.confirmAll}
        </button>
        <button onClick={() => useBp.getState().setAllConfirmed(false)} disabled={!notes.length}>
          {COPY.clearAll}
        </button>
        <button
          onClick={() => {
            useBp.getState().resetNotes()
            setSelectedId(null)
          }}
          disabled={!analysis}
          title={COPY.resetDraftTip}
        >
          {COPY.resetDraft}
        </button>
        <button onClick={() => void exportJps()} disabled={confirmedCount === 0} title="只导出你确认过的音">
          {COPY.exportJps}
        </button>
      </div>

      <div className="body">
        <div className="main">
          <NoteRoll
            notes={notes}
            spectrum={analysis?.spectrum ?? null}
            durationMs={durationMs}
            bpm={bpm}
            beatsPerBar={beatsPerBar}
            firstBeatMs={firstBeatMs}
            pitchMode={pitchMode}
            tonic={tonic}
            mode={mode}
            snap={snap}
            view={view}
            loop={loop}
            loopOn={loopOn}
            gain={gain}
            contrast={contrast}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onSeek={seek}
            onAudition={(midi) => void audition(midi)}
            onAdd={(n) => useBp.getState().addNote(n)}
            onPatch={(id, patch) => useBp.getState().patchNote(id, patch)}
            onRemove={removeNote}
            onToggleConfirmed={(id) => useBp.getState().toggleConfirmed(id)}
            onView={(v) => useBp.getState().setView(v)}
            onLoop={setLoop}
            playMs={currentMs}
          />
          <StripPreview
            grid={grid}
            bpm={bpm}
            beatsPerBar={beatsPerBar}
            firstBeatMs={firstBeatMs}
            durationMs={durationMs}
            view={view}
            playMs={currentMs}
            tonic={tonic}
            onSeek={seek}
          />
        </div>

        <div className="side">
          <div>
            <h3>{COPY.keyPanelTitle}</h3>
            <div className="keys">
              {candidates.map((c) => (
                <div
                  key={c.tonic}
                  className={`key-row${c.tonic === tonic ? ' on' : ''}`}
                  onClick={() => useBp.getState().setTonic(c.tonic)}
                  title="点一下就把调号定成它"
                >
                  <span className="bar">
                    <i style={{ width: `${Math.max(6, Math.round(c.share * 100))}%`, background: keyColor(c.tonic) }}>
                      <b>{keyDisplayName(c.tonic)}</b>
                    </i>
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
            <h3>{COPY.rhythmTitle}</h3>
            <div className="row-gap">
              <button onClick={() => useBp.getState().runRhythm()} disabled={!analysis}>
                {COPY.rhythmBtn}
              </button>
              <span className="hint">
                {rhythm
                  ? `BPM ${rhythm.bpm} · 拍点 ${rhythm.beatCount} 个 · 可信度 ${(rhythm.confidence * 100).toFixed(0)}%`
                  : COPY.rhythmHint}
              </span>
            </div>
            <div className="row-gap" style={{ marginTop: 8 }}>
              <label className="field" style={{ flex: 1 }}>
                {COPY.harmonicLabel}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={suppress}
                  onChange={(e) => useBp.getState().setSuppress(Number(e.target.value))}
                  onPointerUp={(e) => applySuppress(Number((e.target as HTMLInputElement).value))}
                  onKeyUp={(e) => applySuppress(Number((e.currentTarget as HTMLInputElement).value))}
                  style={{ width: 120 }}
                />
                <span className="mono">{suppress.toFixed(2)}</span>
              </label>
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              {COPY.harmonicHint}
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

          <div>
            <h3>显示</h3>
            <div style={{ display: 'grid', gap: 6 }}>
              <label className="field">
                倍率
                <input
                  type="range"
                  min={0.2}
                  max={5}
                  step={0.1}
                  value={gain}
                  onChange={(e) => useBp.getState().setGain(Number(e.target.value))}
                  style={{ width: 140 }}
                />
                <span className="hint" style={{ width: 30, textAlign: 'right' }}>
                  {gain.toFixed(1)}
                </span>
              </label>
              <label className="field">
                对比
                <input
                  type="range"
                  min={0.3}
                  max={3}
                  step={0.05}
                  value={contrast}
                  onChange={(e) => useBp.getState().setContrast(Number(e.target.value))}
                  style={{ width: 140 }}
                />
                <span className="hint" style={{ width: 30, textAlign: 'right' }}>
                  {contrast.toFixed(2)}
                </span>
              </label>
              <div className="hint">口径同 noteDigger：颜色深度 = 值 ^ 对比 × 倍率。</div>
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
            <pre className="src">{jps || '（还没确认音符）'}</pre>
          </div>
        </div>
      </div>

      <div className="status">
        <span>{fileName ?? COPY.empty}</span>
        <span>{durationMs ? `${(durationMs / 1000).toFixed(1)}s` : ''}</span>
        <span>
          {analysis ? `确认 ${confirmedCount} / 共 ${notes.length} 个音` : ''}
        </span>
        <span>{busy ?? ''}</span>
        <span className="spacer" />
        {error && <span className="err">{error}</span>}
        {notice && <span className="hint">{notice}</span>}
        <span className="hint">空格播放 · Tab 原音/合成 · F2 绘制 · F3 选择 · L 循环 · Shift+滚轮平移 · Shift+Alt+滚轮缩放</span>
      </div>
    </div>
  )
}
