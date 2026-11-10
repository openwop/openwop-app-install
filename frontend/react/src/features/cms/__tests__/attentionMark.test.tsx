/**
 * ADR 1038 P5 — a "waiting for a person" mark pulses a ring three times, then
 * stays still.
 * Guards (the CSS, which jsdom cannot run):
 * - every pulse is finite (`3`, never `infinite`) and only on the motion path
 *   (both reduced-motion signals, and `motion: none` opts out);
 * - in a played card the pulse starts after the mark has popped in, so the two
 *   never fight over the same frame;
 * - the ring colour is the `--attention` token (a brand can override it), and the
 *   token exists in both token sources.
 *
 * - one pulse for one meaning: the run card's waiting pill uses it too, and a
 *   flagged row rings in its own colour.
 *
 * Every pulse rule's WHOLE selector list is checked for both guards (not only
 * the first two rules), so the shared `.fp-attention` selector is held too.
 *
 * Sabotage-witnessed (2026-11-03; re-probed /grade-tests wave 88): an `infinite`
 * or a five-beat pulse, dropping the `motion: none` opt-out from any pulse
 * selector (the run pill or the shared `.fp-attention`), starting the played
 * pulse with the tick, closing the OS reduced-motion block before a pulse rule,
 * and repointing the token, its JSON entry, the flagged colour or the keyframes
 * each turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = join(__dirname, '..', '..', '..', 'styles');
const css = readFileSync(join(styles, 'global.css'), 'utf8');
const pulseLines = css.split('\n').filter((l) => /animation:[^;]*fp-attention /.test(l));

describe('the attention ring', () => {
  it('is finite and only on the motion path', () => {
    expect(pulseLines.length).toBeGreaterThanOrEqual(2);
    for (const l of pulseLines) {
      expect(l).not.toMatch(/infinite/);
      expect(l).toMatch(/fp-attention [^,;]* 3[,;]/);
      expect(l).toMatch(/fp-attention 0\.9s/);
    }
    // The whole selector list of EVERY pulse rule: from the previous `}` or `{`
    // (the end of the last rule, or the media block's opening; comments blanked)
    // to this rule's own `{`.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
    const selectors = (line: string): string[] => {
      const open = css.indexOf(line) + line.indexOf('{');
      const start = Math.max(bare.lastIndexOf('}', open - 1), bare.lastIndexOf('{', open - 1)) + 1;
      return bare.slice(start, open).split(',').map((x) => x.trim()).filter((x) => x.includes('fp-'));
    };
    const all = pulseLines.flatMap((l) => selectors(l));
    // The shared `.fp-attention` selector (any marked element in a section) is among them.
    expect(all).toContain(':root:not([data-reduce-motion="reduce"]) .cms-public-section:not(.fp-motion--none) .fp-attention');
    expect(all.length).toBeGreaterThanOrEqual(7);
    for (const x of all) {
      expect(x).toMatch(/^:root:not\(\[data-reduce-motion="reduce"\]\) /);
      expect(x).toContain(':not(.fp-motion--none)');
    }
  });

  it('starts in a played card only after the mark has popped in', () => {
    const line = pulseLines.find((l) => l.includes('fp-activity-tick'))!;
    const delays = /animation-delay:\s*([^;]+);/.exec(line)![1]!.split(/,\s*(?=calc)/);
    expect(delays).toHaveLength(2);
    expect(delays[1]!.replace(/\s+/g, '')).toBe(`${delays[0]!.replace(/\s+/g, '').replace(/\)$/, '')}+var(--dur-enter))`);
  });

  it('every pulse rule sits inside the OS reduced-motion guard', () => {
    // The run card's pill is guarded like every other pulse now (grading ATTN-1:
    // it used to pulse under `motion: none` and on print), so no exception.
    for (const l of pulseLines) {
      const at = css.indexOf(l);
      const media = css.lastIndexOf('@media screen and (prefers-reduced-motion: no-preference)', at);
      expect(media, l).toBeGreaterThan(0);
      expect(css.slice(media, at).split('{').length - css.slice(media, at).split('}').length, l).toBeGreaterThan(0);
    }
    expect(css).toContain(':root:not([data-reduce-motion="reduce"]) .cms-public-section:not(.fp-motion--none) .fp-run__waits { animation: fp-attention');
  });

  it('takes its colour from the --attention token, defined in both token sources', () => {
    expect(css).toMatch(/@keyframes fp-attention \{[^}]*var\(--attention\)/);
    expect(readFileSync(join(styles, 'foundations', 'tokens.css'), 'utf8')).toMatch(/--attention: var\(--color-warning\);/);
    const tokens = JSON.stringify(JSON.parse(readFileSync(join(styles, 'tokens.json'), 'utf8')));
    expect(tokens).toMatch(/"\$value":"var\(--color-warning\)","\$extensions":\{"openwop":\{"cssName":"--attention"/);
    // A flagged row rings in its own colour, not the waiting amber.
    expect(css).toContain('.fp-activity__row--flagged { --attention: var(--color-danger); }');
  });
});
