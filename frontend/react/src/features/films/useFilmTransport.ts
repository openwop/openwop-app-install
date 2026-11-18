import { useCallback, useEffect, useRef, useState } from 'react';
import { filmSteps, type FilmSpec } from '../../../../../contracts/films.js';
import { compileFilmPerformance, performanceEvent, PERFORMANCE_LIMITS, type FilmPerformance } from '../../../../../contracts/filmPerformance.js';
import { firstFilmPosition, moveFilm, type FilmPosition } from './playback.js';
export interface RehearsalDraft { requestId: string; performance: FilmPerformance; interrupted: boolean }
interface Capture { started: number; hash: string; requestId: string; events: FilmPerformance['events'] }
interface Replay { take: FilmPerformance; sample: ReturnType<typeof compileFilmPerformance>; time: number; started: number; playing: boolean }
/** One monotonic clock owns transitions and timed replay. Seeking dispatches no actions. */
const timeAt = (r: Replay, now: number) => Math.min(r.take.durationMs, r.time + (r.playing ? Math.max(0, now - r.started) : 0));
export function useFilmTransport(film: FilmSpec, reducedMotion: boolean) {
  const [position, setPosition] = useState(firstFilmPosition);
  const manual = useRef({ position: firstFilmPosition(), at: performance.now() });
  const capture = useRef<Capture | null>(null), replay = useRef<Replay | null>(null);
  const [capturing, setCapturing] = useState(false), [draft, setDraft] = useState<RehearsalDraft | null>(null);
  const [replayTake, setReplayTake] = useState<FilmPerformance | null>(null), [playing, setPlaying] = useState(false), [playheadMs, setPlayheadMs] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const notify = useCallback(() => setEpoch(n => n + 1), []);
  const manualAt = useCallback((now: number): FilmPosition => {
    const { position: p, at } = manual.current;
    const duration = filmSteps(film)[p.step]!.durationMs;
    return p.progress >= 1 ? p : { ...p, progress: reducedMotion || !duration ? 1 : Math.min(1, p.progress + Math.max(0, now - at) / duration) };
  }, [film, reducedMotion]);
  const stopCapture = useCallback((interrupted = false) => {
    const c = capture.current;
    if (!c) return;
    const durationMs = Math.max(1, Math.min(PERFORMANCE_LIMITS.durationMs, Math.round(performance.now() - c.started)));
    capture.current = null; setCapturing(false);
    setDraft({ requestId: c.requestId, interrupted, performance: { version: 1, filmHash: c.hash, durationMs, events: c.events.filter(e => e.atMs <= durationMs).map(e => ({ ...e })) } });
  }, []);
  const change = useCallback((action: (p: FilmPosition) => FilmPosition) => {
    if (replay.current) return;
    const now = performance.now(), next = action(manualAt(now));
    const c = capture.current;
    if (c) {
      const elapsed = Math.round(now - c.started);
      if (elapsed >= PERFORMANCE_LIMITS.durationMs || c.events.length >= PERFORMANCE_LIMITS.events) stopCapture(true);
      else c.events.push(performanceEvent(film, next, elapsed));
    }
    manual.current = { position: next, at: now }; setPosition(next); notify();
  }, [film, manualAt, notify, stopCapture]);
  const move = useCallback((direction: 'next' | 'back') => change(p => moveFilm(film, p, direction, reducedMotion)), [change, film, reducedMotion]);
  const jump = useCallback((step: number) => change(p => ({ ...p, step, progress: 1 })), [change]);
  const restart = useCallback(() => change(firstFilmPosition), [change]);
  const blank = useCallback(() => change(p => ({ ...p, blank: !p.blank })), [change]);
  const startCapture = useCallback((hash: string) => {
    if (capture.current || draft) return;
    const now = performance.now(), first = firstFilmPosition();
    replay.current = null; setReplayTake(null); setPlaying(false); setPlayheadMs(0);
    manual.current = { position: first, at: now }; setPosition(first);
    capture.current = { started: now, hash, requestId: crypto.randomUUID(), events: [performanceEvent(film, first, 0)] };
    setCapturing(true); notify();
  }, [draft, film, notify]);
  const review = useCallback((take: FilmPerformance) => {
    if (capture.current) return;
    replay.current = { take, sample: compileFilmPerformance(film, take), time: 0, started: performance.now(), playing: false };
    setReplayTake(take); setPlaying(false); setPlayheadMs(0); setPosition(replay.current.sample(0, reducedMotion)); notify();
  }, [film, reducedMotion, notify]);
  const seek = useCallback((atMs: number) => {
    const r = replay.current;
    if (!r || !Number.isFinite(atMs)) return;
    r.time = Math.max(0, Math.min(r.take.durationMs, atMs)); r.started = performance.now(); r.playing = false;
    setPlaying(false); setPlayheadMs(r.time); setPosition(r.sample(r.time, reducedMotion)); notify();
  }, [notify, reducedMotion]);
  const togglePlay = useCallback(() => {
    const r = replay.current;
    if (!r) return;
    const now = performance.now(); r.time = timeAt(r, now);
    if (!r.playing && r.time >= r.take.durationMs) r.time = 0;
    r.playing = !r.playing; r.started = now;
    setPlaying(r.playing); setPlayheadMs(r.time); setPosition(r.sample(r.time, reducedMotion)); notify();
  }, [notify, reducedMotion]);
  const returnLive = useCallback(() => {
    const r = replay.current;
    if (!r || r.playing) return;
    const next = { ...r.sample(r.time, reducedMotion), progress: 1 };
    replay.current = null; setReplayTake(null); setPlaying(false); setPlayheadMs(0);
    manual.current = { position: next, at: performance.now() }; setPosition(next); notify();
  }, [notify, reducedMotion]);
  const discardDraft = useCallback(() => {
    if (replay.current?.playing) return;
    returnLive(); setDraft(null);
  }, [returnLive]);
  useEffect(() => {
    const r = replay.current;
    if (r) setPosition(r.sample(timeAt(r, performance.now()), reducedMotion));
    else if (reducedMotion) change(p => ({ ...p, progress: 1 }));
  }, [reducedMotion, change]);
  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      const r = replay.current;
      if (r) {
        const time = timeAt(r, now); setPlayheadMs(time); setPosition(r.sample(time, reducedMotion));
        if (!r.playing || time >= r.take.durationMs) {
          if (r.playing) { r.playing = false; r.time = time; setPlaying(false); }
          return;
        }
      } else {
        const p = manualAt(now); setPosition(p);
        if (p.progress >= 1) return;
      }
      frame = requestAnimationFrame(tick);
    };
    if (replay.current?.playing || (!replay.current && manual.current.position.progress < 1)) frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [epoch, manualAt, reducedMotion]);
  useEffect(() => {
    if (!capturing) return;
    const timer = window.setTimeout(() => stopCapture(true), PERFORMANCE_LIMITS.durationMs);
    const onVisibility = () => { if (document.visibilityState === 'hidden') stopCapture(true); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [capturing, stopCapture]);
  useEffect(() => {
    if (!capturing && !draft) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [capturing, draft]);
  return { position, move, jump, restart, blank, capturing, draft, startCapture, stopCapture, review, replayTake, playing, playheadMs, seek, togglePlay, returnLive, discardDraft, saved: () => setDraft(null) };
}
export type FilmTransport = ReturnType<typeof useFilmTransport>;
