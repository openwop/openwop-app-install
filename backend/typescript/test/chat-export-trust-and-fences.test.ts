/**
 * ADR 0698 — the import trust stamp has no consumer, and the markdown renderer let
 * imported content control the SHAPE of the export.
 *
 * D1: `importService` stamps `contentTrust:'untrusted'` on chat-message rows and
 * NOTHING reads it. Three comments cited it as the reason a hostile import is
 * "fenced on recall/render". The protection on the one model-facing path is real but
 * comes from the TOOL (`conversation-search/agentTools.ts` declares
 * `contentTrust:'untrusted'`, fenced by `toModelToolResult`), not from the row.
 *
 * D2: a body containing a literal fence run broke OUT of the ```json wrapper, and a
 * title with newlines injected headings — both attacker-supplied on an imported
 * conversation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptToMarkdown, transcriptToJson } from '../src/features/chat-export/transcriptRenderer.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** Assert on CODE, not prose — this file's own comments quote the retired claims. */
const codeOf = (p: string): string =>
  readFileSync(p, 'utf8').split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  }).join('\n');

const session = (title: string): never | { sessionId: string; title: string; createdAt: string } =>
  ({ sessionId: 's1', title, createdAt: '2026-01-01T00:00:00.000Z' });
const msg = (content: string, role = 'user') =>
  ({ messageId: 'm1', sessionId: 's1', role, content, authorSubject: null, createdAt: '2026-01-01T00:00:01.000Z' });

describe('ADR 0698 D2 — imported content cannot control the export STRUCTURE', () => {
  it('leg 1: a body containing a literal fence run does NOT break out of the wrapper', () => {
    const hostile = '{"a":"``` \\n# INJECTED HEADING\\n"}';
    const md = transcriptToMarkdown(session('T') as never, [msg(hostile)] as never);
    const body = md.slice(md.indexOf('## '));
    // The opening fence must be LONGER than any run inside the content, so the
    // content cannot terminate it.
    const opening = body.match(/^(`{3,})json$/m)?.[1] ?? '';
    expect(opening.length, 'the fence widens past the content run').toBeGreaterThan(3);
    // The injected heading must NOT be a top-level markdown heading in the output:
    // every line starting with '#' should be one WE emitted.
    const headings = md.split('\n').filter((l) => /^#{1,6} /.test(l));
    expect(headings.some((h) => h.includes('INJECTED')), 'the payload never becomes a heading').toBe(false);
  });

  it('leg 2: a title carrying newlines and hashes cannot inject headings', () => {
    const md = transcriptToMarkdown(session('Hi\n## PWNED\n### ALSO') as never, [msg('plain')] as never);
    // The invariant is STRUCTURAL, not substring: the payload text may still appear
    // INSIDE our heading (it is data), but it must not create ADDITIONAL heading
    // lines. My first version of this leg asserted `!includes('PWNED')`, which
    // contradicted its own expected output — the collapsed title legitimately
    // contains that text.
    const headings = md.split('\n').filter((l) => /^#{1,6} /.test(l));
    expect(headings.length, 'exactly one title heading + one per message — nothing injected').toBe(2);
    expect(md.split('\n')[0], 'the title collapses to ONE line').toBe('# Hi ## PWNED ### ALSO');
  });

  it('leg 3: a leading hash in a title is neutralized, not echoed as a bigger heading', () => {
    const md = transcriptToMarkdown(session('### sneaky') as never, [msg('x')] as never);
    expect(md.split('\n')[0]).toBe('# sneaky');
  });

  it('leg 4: the JSON round trip is BYTE-IDENTICAL — widening the fence must not mutate the payload', () => {
    const hostile = '{"a":"``` and ```` more"}';
    const out = transcriptToJson(session('T') as never, [msg(hostile)] as never);
    expect(out.messages[0]?.content, 'the escape hatch must not corrupt round-trip fidelity').toBe(hostile);
  });
});

describe('ADR 0698 D1 — the trust stamp must not be re-described as a fence', () => {
  it('leg 5: no chat-export source claims row-level fencing while no consumer exists', () => {
    const consumers = [
      codeOf(join(SRC, 'host', 'envelopeAcceptor.ts')),
      codeOf(join(SRC, 'host', 'agentKnowledgeComposition.ts')),
    ].join('\n');
    // Guard against the fix going stale: if someone DOES add a chat-message consumer,
    // this leg should be revisited rather than silently keep forbidding the claim.
    expect(consumers.includes('listChatSessionMessages'), 'no trust consumer reads the chat-message store yet').toBe(false);

    // POSITION, not absence. Asserting absence is wrong twice over: `codeOf` strips
    // line-start comments, so a full-line re-assertion would slip through — and NOT
    // stripping them would red against these files' own correction notes, which quote
    // the retired claim in order to disown it (the "ratchets count comments" trap).
    // So: the phrase may appear ONLY inside a correction that disowns it.
    for (const f of ['routes.ts', 'importService.ts']) {
      const raw = readFileSync(join(SRC, 'features', 'chat-export', f), 'utf8');
      const RETIRED = /never silently trusted|fenced (as untrusted )?on recall\/render/gi;
      for (const m of raw.matchAll(RETIRED)) {
        const preamble = raw.slice(Math.max(0, (m.index ?? 0) - 500), m.index);
        expect(preamble, `${f}: the retired claim may appear only inside a CORRECTED note`)
          .toMatch(/CORRECTED|used to (say|be described)|That was false/i);
      }
    }
  });

  it('leg 6: the stamp itself is KEPT — provenance is still written', () => {
    const src = readFileSync(join(SRC, 'features', 'chat-export', 'importService.ts'), 'utf8');
    expect(src, "source:'import' is genuine provenance and must survive").toContain("source: 'import'");
    expect(src, 'and the trust value stays, for a future consumer to key off').toContain("contentTrust: 'untrusted'");
  });

  it('leg 7: the real mechanism still exists — the search TOOL declares untrusted', () => {
    const tool = codeOf(join(SRC, 'features', 'conversation-search', 'agentTools.ts'));
    expect(tool, 'the tool-level declaration is what actually fences').toMatch(/contentTrust: *'untrusted'/);
    const fencer = codeOf(join(SRC, 'host', 'toModelToolResult.ts'));
    expect(fencer, 'and the fencer honors it').toMatch(/contentTrust/);
  });
});
