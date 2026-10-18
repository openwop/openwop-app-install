/**
 * The suite editor's form model (ADR 0889 P6) and its two conversions.
 *
 * The form covers the common case; the JSON view covers everything. Neither
 * may silently drop a field the other carries (the validator-allowlist trap):
 * values the form does not expose (trajectory call `args`, `thresholds.maxCostUsd`,
 * fixtures) ride the draft unchanged, so form → suite → form is lossless for
 * any suite the server accepts. Validation stays the SERVER's — this module
 * only reports what it cannot even parse (bad JSON), by field path.
 *
 * Grade remediation (ADR 0889, EVAL-7 / AE-1): a value keeps the TYPE it
 * arrived with (a string `"42"` stays a string, a number `42` stays a number),
 * a task's `trajectory.includeDelegates` survives the form, and numbers are
 * read and shown in the user's locale (`0,5` in fr is one half, not NaN).
 */
import type {
  AgentEvalSuite, ArgsMatch, EvalMode, EvalTaskDef, GoldenStrategy, PassRule, TrajectoryCall, TrajectoryMatchMode,
} from './agentEvalsClient.js';
import { parseDecimal, showDecimal } from './localeNumber.js';

export type ExpectedKind = 'golden' | 'rubric' | 'trajectory';

export interface RubricDraft { criterion: string; weight: string }

/**
 * How a free-text value is read back. `text` — it arrived as a string, send it
 * verbatim; `json` — it arrived as a number/boolean/object/array, parse it;
 * `auto` — a new value: an object, array or quoted JSON string parses, every
 * other text (including `42`, `true`) is sent as the text the user typed.
 */
export type ValueType = 'text' | 'json' | 'auto';

export interface TaskDraft {
  /** Local React key — never sent. */
  key: string;
  taskId: string;
  /** JSON, or plain text sent as a string. */
  input: string;
  inputType: ValueType;
  kind: ExpectedKind;
  matchStrategy: GoldenStrategy;
  /** JSON, or plain text sent as a string. */
  matchValue: string;
  matchValueType: ValueType;
  rubric: RubricDraft[];
  /** An expected trajectory alongside golden/rubric (always on for kind trajectory). */
  trajectoryOn: boolean;
  trajectoryMatch: TrajectoryMatchMode;
  /** One tool id per line. */
  calls: string;
  /** Per-call extras the form does not edit, kept by position while the tool id is unchanged. */
  callExtras: Array<{ tool: string; args?: unknown; argsMatch?: ArgsMatch }>;
  /** One tool id per line. */
  forbidden: string;
  /** RFC 0244 — count delegated sub-agent calls toward the trajectory. Not in the form; kept as loaded. */
  includeDelegates?: boolean;
  /** The task's `fixtures` object as JSON; empty ⇒ none. */
  fixtures: string;
}

export interface SuiteDraft {
  suiteId: string;
  version: string;
  targetAgentId?: string;
  modes: EvalMode[];
  allowedModels?: string[];
  passScore: string;
  maxCostUsd: string;
  maxP95LatencyMs: string;
  trialsCount: string;
  trialsK: string;
  passRule: PassRule;
  tasks: TaskDraft[];
}

let seq = 0;
const nextKey = (): string => `t${++seq}`;

/**
 * A `suiteId` the server's pattern accepts, derived from the agent id. With
 * `taken` (the refs already listed), the first free `default`, `default-2`, …
 * — so "New suite" twice never proposes a ref that exists (EVUX-1).
 */
export function defaultSuiteId(agentId: string, taken: ReadonlySet<string> = new Set()): string {
  const slug = agentId.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'agent';
  const used = new Set([...taken].map((ref) => ref.split('@')[0]));
  for (let n = 1; ; n += 1) {
    const id = `${slug}.evals.default${n === 1 ? '' : `-${n}`}`;
    if (!used.has(id)) return id;
  }
}

export function emptyTask(index: number): TaskDraft {
  return {
    key: nextKey(),
    taskId: `task-${index + 1}`,
    input: '',
    inputType: 'auto',
    kind: 'golden',
    matchStrategy: 'contains',
    matchValue: '',
    matchValueType: 'auto',
    rubric: [{ criterion: '', weight: '1' }],
    trajectoryOn: false,
    trajectoryMatch: 'in-order',
    calls: '',
    callExtras: [],
    forbidden: '',
    fixtures: '',
  };
}

export function emptyDraft(agentId: string, taken: ReadonlySet<string> = new Set(), locale = 'en'): SuiteDraft {
  return {
    suiteId: defaultSuiteId(agentId, taken),
    version: '1.0.0',
    targetAgentId: agentId,
    modes: ['golden', 'regression'],
    passScore: showDecimal(0.7, locale),
    maxCostUsd: '',
    maxP95LatencyMs: '',
    trialsCount: '1',
    trialsK: '1',
    passRule: 'mean',
    tasks: [emptyTask(0)],
  };
}

/** Plain text stays plain text; anything that parses as JSON (other than a bare string) is shown as JSON. */
function showValue(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

const typeOf = (v: unknown): ValueType => (v === undefined ? 'auto' : typeof v === 'string' ? 'text' : 'json');

/**
 * The inverse of `showValue`, by the value's {@link ValueType}. `auto` parses
 * only structured JSON (object, array, quoted string): a bare `42` or `true` is
 * text the user typed, never silently a number or boolean (EVAL-7).
 */
export function readValue(text: string, type: ValueType = 'auto'): unknown {
  if (type === 'text') return text;
  const trimmed = text.trim();
  if (trimmed === '') return '';
  if (type === 'json' || /^[[{"]/.test(trimmed)) {
    try { return JSON.parse(trimmed) as unknown; } catch { /* fall through to text */ }
  }
  return text;
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);
export function draftFromSuite(suite: AgentEvalSuite, locale = 'en'): SuiteDraft {
  const numStr = (n: number | undefined): string => showDecimal(n, locale);
  return {
    suiteId: suite.suiteId,
    version: suite.version,
    ...(suite.targetAgentId ? { targetAgentId: suite.targetAgentId } : {}),
    modes: suite.modes,
    ...(suite.allowedModels ? { allowedModels: suite.allowedModels } : {}),
    passScore: numStr(suite.thresholds?.passScore),
    maxCostUsd: numStr(suite.thresholds?.maxCostUsd),
    maxP95LatencyMs: numStr(suite.thresholds?.maxP95LatencyMs),
    trialsCount: numStr(suite.trials?.count ?? 1),
    trialsK: numStr(suite.trials?.k ?? suite.trials?.count ?? 1),
    passRule: suite.trials?.passRule ?? 'mean',
    tasks: suite.tasks.map((t) => {
      const tr = t.expected.trajectory;
      return {
        key: nextKey(),
        taskId: t.taskId,
        input: showValue(t.input),
        inputType: typeOf(t.input),
        kind: t.expected.kind,
        matchStrategy: t.expected.match?.strategy ?? 'contains',
        matchValue: showValue(t.expected.match?.value),
        matchValueType: typeOf(t.expected.match?.value),
        rubric: (t.expected.rubric ?? [{ criterion: '', weight: 1 }]).map((r) => ({ criterion: r.criterion, weight: numStr(r.weight) })),
        trajectoryOn: tr !== undefined,
        trajectoryMatch: tr?.match ?? 'in-order',
        calls: (tr?.calls ?? []).map((c) => c.tool).join('\n'),
        callExtras: tr?.calls ?? [],
        forbidden: (tr?.forbidden ?? []).join('\n'),
        ...(tr?.includeDelegates !== undefined ? { includeDelegates: tr.includeDelegates } : {}),
        fixtures: t.fixtures ? JSON.stringify(t.fixtures, null, 2) : '',
      };
    }),
  };
}

/** A form value that could not be read — reported against the server's field path. */
export class DraftParseError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'DraftParseError';
    this.field = field;
  }
}

/** NaN (unreadable) reaches the server's typed 400, never a silent drop. */
function taskFromDraft(d: TaskDraft, i: number, num: (text: string) => number | undefined): EvalTaskDef {
  const withTrajectory = d.kind === 'trajectory' || d.trajectoryOn;
  const calls: TrajectoryCall[] = lines(d.calls).map((tool, j) => {
    const prev = d.callExtras[j];
    return prev && prev.tool === tool ? { ...prev } : { tool };
  });
  const forbidden = lines(d.forbidden);
  let fixtures: EvalTaskDef['fixtures'];
  if (d.fixtures.trim() !== '') {
    try {
      fixtures = JSON.parse(d.fixtures) as EvalTaskDef['fixtures'];
    } catch {
      throw new DraftParseError(`tasks[${i}].fixtures`, 'not valid JSON');
    }
  }
  return {
    taskId: d.taskId.trim(),
    input: readValue(d.input, d.inputType),
    expected: {
      kind: d.kind,
      ...(d.kind === 'golden' ? { match: { strategy: d.matchStrategy, value: readValue(d.matchValue, d.matchValueType) } } : {}),
      ...(d.kind === 'rubric' ? { rubric: d.rubric.map((r) => ({ criterion: r.criterion.trim(), weight: num(r.weight) ?? 0 })) } : {}),
      ...(withTrajectory ? { trajectory: { match: d.trajectoryMatch, calls, ...(forbidden.length ? { forbidden } : {}), ...(d.includeDelegates !== undefined ? { includeDelegates: d.includeDelegates } : {}) } } : {}),
    },
    ...(fixtures !== undefined ? { fixtures } : {}),
  };
}

export function suiteFromDraft(d: SuiteDraft, locale = 'en'): AgentEvalSuite {
  const num = (text: string): number | undefined => parseDecimal(text, locale);
  const passScore = num(d.passScore);
  const maxCostUsd = num(d.maxCostUsd);
  const maxP95LatencyMs = num(d.maxP95LatencyMs);
  const count = num(d.trialsCount) ?? 1;
  const k = num(d.trialsK) ?? count;
  const thresholds = {
    ...(passScore !== undefined ? { passScore } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxP95LatencyMs !== undefined ? { maxP95LatencyMs } : {}),
  };
  // Modes follow the task kinds (a trajectory-only task grades under golden);
  // `regression` is kept when the suite declared it.
  const kinds = new Set(d.tasks.map((t) => t.kind));
  const modes: EvalMode[] = [];
  if (kinds.has('golden') || kinds.has('trajectory')) modes.push('golden');
  if (kinds.has('rubric')) modes.push('rubric');
  if (d.modes.includes('regression')) modes.push('regression');
  return {
    suiteId: d.suiteId.trim(),
    version: d.version.trim(),
    ...(d.targetAgentId ? { targetAgentId: d.targetAgentId } : {}),
    modes: modes.length ? modes : ['golden'],
    ...(d.allowedModels ? { allowedModels: d.allowedModels } : {}),
    ...(Object.keys(thresholds).length ? { thresholds } : {}),
    ...(count !== 1 || d.passRule !== 'mean' ? { trials: { count, k, passRule: d.passRule } } : {}),
    tasks: d.tasks.map((t, i) => taskFromDraft(t, i, num)),
  };
}

/** `1.2.3` → `1.2.4`; a non-semver version restarts at `1.0.1`. */
export function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return '1.0.1';
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** The next patch version of `suiteId` that no listed ref uses (EVUX-1). */
export function nextFreeVersion(suiteId: string, version: string, taken: ReadonlySet<string>): string {
  let v = bumpPatch(version);
  while (taken.has(`${suiteId}@${v}`)) v = bumpPatch(v);
  return v;
}
