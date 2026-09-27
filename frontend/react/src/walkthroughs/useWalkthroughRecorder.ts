/**
 * Record-mode controller (ADR 0368 Phase 6b) — start/stop the capture engine,
 * expose the live step list, and save the recording as a transient tour draft.
 * Mounted once inside `WalkthroughOverlayHost` so play/record mutual-exclusion is
 * enforced in one place (record refuses to start while a tour is playing).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { startRecording, stopRecording, isRecording, buildRegistrationStub, type WalkthroughRecording, type RecordedStep } from './walkthroughRecorder.js';
import { synthesizeWalkthrough, saveRecordedWalkthrough } from './walkthroughSynthesis.js';
import { onWalkthroughRecordRequest } from './walkthroughBus.js';

export type RecorderStatus = 'idle' | 'recording' | 'saving';

export interface WalkthroughRecorderController {
  status: RecorderStatus;
  steps: RecordedStep[];
  /** Start capturing — refused (returns false) while a tour is playing. */
  start(canStart: boolean): boolean;
  cancel(): void;
  /** Stop + synthesize + save a transient draft; resolves the new workflowId
   *  and whether it has unregistered (Tier-2) steps. */
  save(name: string): Promise<{ workflowId: string; hasUnregisteredSteps: boolean } | null>;
  /** ADR 0489 D4 — how many captured steps are Tier-2 (need a registration). */
  unregisteredCount: number;
  /** ADR 0489 D4 — copy `registerWalkthroughAction` stubs for every Tier-2 step
   *  to the clipboard. Resolves false when there is nothing to copy or the
   *  clipboard is unavailable (insecure context / denied) — the caller reports
   *  it honestly rather than claiming a copy that did not happen. */
  copyStubs(): Promise<boolean>;
}

export function useWalkthroughRecorder(canStart: boolean): WalkthroughRecorderController & { onRequest(fn: () => void): void } {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [steps, setSteps] = useState<RecordedStep[]>([]);
  const recRef = useRef<WalkthroughRecording | null>(null);
  const requestCb = useRef<(() => void) | null>(null);

  const start = useCallback((allowed: boolean): boolean => {
    if (!allowed || isRecording()) return false;
    setSteps([]);
    startRecording((rec) => { recRef.current = rec; setSteps(rec.steps); });
    setStatus('recording');
    return true;
  }, []);

  const cancel = useCallback(() => {
    stopRecording();
    recRef.current = null;
    setSteps([]);
    setStatus('idle');
  }, []);

  const save = useCallback(async (name: string) => {
    const rec = stopRecording();
    setStatus('saving');
    try {
      if (!rec || rec.steps.length === 0) { setStatus('idle'); return null; }
      const tour = synthesizeWalkthrough(rec, name);
      await saveRecordedWalkthrough(tour);
      setStatus('idle');
      setSteps([]);
      return { workflowId: tour.workflowId, hasUnregisteredSteps: tour.hasUnregisteredSteps };
    } catch {
      setStatus('idle');
      throw new Error('save_failed');
    }
  }, []);

  // The bus request enters record mode (respecting mutual exclusion).
  useEffect(() => onWalkthroughRecordRequest(() => {
    if (start(canStart)) return;
    requestCb.current?.(); // let the host surface "can't record right now"
  }), [start, canStart]);

  const onRequest = useCallback((fn: () => void) => { requestCb.current = fn; }, []);

  // ADR 0489 D4 — derived from the LIVE step list so the affordance appears the
  // moment an unmatched interaction is captured, not only after save.
  const unregisteredCount = steps.filter((s) => !s.actionId).length;

  const copyStubs = useCallback(async (): Promise<boolean> => {
    const stubs = steps.map((s, i) => buildRegistrationStub(s, i)).filter((s): s is string => s !== null);
    if (stubs.length === 0) return false;
    try {
      // `navigator.clipboard` is undefined in insecure contexts and can reject
      // when permission is denied — both are "we did not copy", never a throw
      // that reads to the user as a crash.
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(stubs.join('\n\n'));
      return true;
    } catch {
      return false;
    }
  }, [steps]);

  return { status, steps, start, cancel, save, onRequest, unregisteredCount, copyStubs };
}
