/**
 * ADR 0834 D1 — the census of every place an agent tool can EXECUTE, and the firewall
 * that guards it.
 *
 * The physical exit for every builtin / feature / core agent tool is the executor built
 * by `createAgentToolProvider` / `createScopedAgentToolProvider`. Before ADR 0834 the
 * anonymous widget lane built one with no firewall at all, and four other lanes built
 * the firewall by hand-copied blocks that had already drifted. This test counts the
 * executor constructors per production file and requires each file's count to be
 * adjudicated below, with the lane firewall (`buildLaneFirewall`) it calls — so a new
 * tool-executing site fails here until someone decides what guards it.
 *
 * It also pins `buildFirewallHook(` to ONE production caller (`host/laneFirewall.ts`), so
 * the hand-copied posture block cannot come back.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Code with comments removed (block, whole-line AND trailing `// …`), so a call named
 *  in prose is not counted (FW2-CD-3). `://` inside a URL string is left alone. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;
const EXECUTOR = /\bcreate(?:Scoped)?AgentToolProvider\(/g;
const DEFINITION = /export function create(?:Scoped)?AgentToolProvider\(/g;
const LANE = /\bbuildLaneFirewall\(/g;

/** FW2-CD-3 — building the hook is not enough: the lane must HAND it to the decision
 *  point. Each lane file must contain the hand-off (the hook passed to the tool loop, or
 *  evaluated before the executor runs). Deleting it turns this red. */
const HANDOFF: Record<string, RegExp[]> = {
  'host/conversationToolLoop.ts': [/^\s*firewall,/m],
  'host/agentRunnerNode.ts': [/^\s*firewall,/m],
  'routes/agents.ts': [/^\s*firewall,/m],
  'features/voice/realtime/toolBridge.ts': [/\bfw\.evaluate\(/],
  'host/anonymousActor.ts': [/^\s*firewall,/m, /\bfirewall\.evaluate\(/],
};

/** file → [executor constructors, buildLaneFirewall calls, what guards it]. */
const CENSUS: Record<string, [number, number, string]> = {
  'host/conversationToolLoop.ts': [1, 1, 'chat lane — bypass only for the acting principal (D3)'],
  'host/agentRunnerNode.ts': [1, 1, 'run lane — always safe'],
  'routes/agents.ts': [1, 1, 'ad-hoc live dispatch — always safe'],
  'features/voice/realtime/toolBridge.ts': [2, 1, 'voice — one executor is decls-only (`resolveTool`, never executes); the other is guarded'],
  'host/anonymousActor.ts': [2, 2, 'anonymous widget turn + the deferred approve of a held write (re-checks deny)'],
  'host/agentToolProvider.ts': [1, 0, 'the scoped composer delegating to the base constructor — no execution of its own'],
};

describe('firewall lane census (ADR 0834 D1)', () => {
  const files = walk(SRC);

  it('buildFirewallHook( has exactly one production caller: host/laneFirewall.ts', () => {
    const callers = files.filter((f) => count(code(f), /\bbuildFirewallHook\(/g) > count(code(f), /export function buildFirewallHook\(/g))
      .map((f) => relative(SRC, f));
    expect(callers).toEqual(['host/laneFirewall.ts']);
  });

  it('every executor constructor is adjudicated, with its lane firewall', () => {
    const seen: Record<string, [number, number]> = {};
    for (const f of files) {
      const c = code(f);
      const execs = count(c, EXECUTOR) - count(c, DEFINITION);
      if (execs > 0) seen[relative(SRC, f)] = [execs, count(c, LANE)];
    }
    const expected = Object.fromEntries(Object.entries(CENSUS).map(([k, [e, l]]) => [k, [e, l]]));
    expect(seen).toEqual(expected);
  });

  it('every lane HANDS its firewall to the decision point (not merely builds it)', () => {
    for (const [file, patterns] of Object.entries(HANDOFF)) {
      const c = code(join(SRC, file));
      for (const re of patterns) expect(re.test(c), `${file} must match ${re}`).toBe(true);
    }
  });
});
