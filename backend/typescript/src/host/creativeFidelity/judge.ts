/**
 * ADR 0945 D3 stage B — the model judge. One vision call with the product's
 * SOURCE photos and the CANDIDATE, answered in the closed schema of
 * `judgeSchema.ts`. An unparseable reply gets exactly ONE error-fed repair (the
 * reply echoed back with the parse error named — the `cms/translate.ts` shape),
 * then a typed `fidelity_judge_invalid`. A valid `mismatch` is an answer, never
 * re-asked.
 */
import { OpenwopError } from '../../types.js';
import type { ChatMessage, ContentPart } from '../../providers/dispatch.js';
import type { HeadlessDispatch } from '../headlessAi.js';
import { judgePrompt, parseJudgeReply, type JudgeAttributeResult } from './judgeSchema.js';

export interface JudgeImage { mimeType: string; dataBase64: string }

export interface JudgeOutcome { results: JudgeAttributeResult[]; repaired: boolean }

export async function runFidelityJudge(dispatch: HeadlessDispatch, input: { sources: JudgeImage[]; candidate: JudgeImage; signal?: AbortSignal }): Promise<JudgeOutcome> {
  const parts: ContentPart[] = [];
  input.sources.forEach((s, i) => {
    parts.push({ type: 'text', text: `SOURCE ${i + 1}:` });
    parts.push({ type: 'image', mimeType: s.mimeType, dataBase64: s.dataBase64 });
  });
  parts.push({ type: 'text', text: 'CANDIDATE:' });
  parts.push({ type: 'image', mimeType: input.candidate.mimeType, dataBase64: input.candidate.dataBase64 });
  const messages: ChatMessage[] = [{ role: 'system', content: judgePrompt() }, { role: 'user', content: parts }];
  const opts = { maxTokens: 1200, ...(input.signal ? { signal: input.signal } : {}) };

  const first = await dispatch(messages, opts);
  const a = parseJudgeReply(first);
  if (a.ok) return { results: a.results, repaired: false };
  const second = await dispatch([
    ...messages,
    { role: 'assistant', content: first },
    { role: 'user', content: `That reply was not usable: ${a.reason}. Reply again with ONLY the JSON object, listing every attribute exactly once.` },
  ], opts);
  const b = parseJudgeReply(second);
  if (b.ok) return { results: b.results, repaired: true };
  throw new OpenwopError('fidelity_judge_invalid', 'The fidelity judge did not return a usable answer after one correction.', 502, { reason: b.reason, repairAttempted: true });
}
