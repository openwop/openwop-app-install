/**
 * The `quick` model class never names a model that thinks by default.
 *
 * Quick-class callers send tiny output budgets: BYOK chat auto-title caps output
 * at 24 tokens for a non-reasoning model (features/chat-autotitle/titleGenerator.ts)
 * and the decision suggester at 200. A model that thinks when `thinking` is
 * omitted spends that budget thinking and returns empty text, the failure ADR 1019
 * measured on the managed route. The 2026-11-11 catalog refresh nearly shipped
 * `quick: claude-haiku-5-5` (adaptive by default), which would have blanked every
 * Anthropic BYOK workspace's titles; this test is why it can't drift back.
 *
 * Two halves, so a new model cannot slip past unflagged:
 *   - every provider's `quick` model exists and carries neither `thinksByDefault`
 *     nor `adaptiveThinkingOnly`;
 *   - every Claude generation-5+ model carries `thinksByDefault` (Anthropic's
 *     thinking table: omitting `thinking` runs adaptive on all of them).
 *
 * Sabotage-witnessed: `quick: claude-haiku-5-5`, or a gen-5 Claude model without
 * the flag, each turn a case red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Model { id: string; thinksByDefault?: boolean; adaptiveThinkingOnly?: boolean }
interface Provider { id: string; models: Model[]; classDefaults?: Record<string, string> }

const catalog = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'providers.json'), 'utf8')) as { providers: Provider[] };

describe('the quick model class', () => {
  it('names an existing model that does not think by default, on every provider', () => {
    const withQuick = catalog.providers.filter((p) => p.classDefaults?.quick);
    expect(withQuick.map((p) => p.id)).toEqual(expect.arrayContaining(['anthropic', 'openai', 'google']));
    for (const p of withQuick) {
      const quick = p.classDefaults?.quick ?? '';
      const model = p.models.find((m) => m.id === quick);
      expect(model, `${p.id}.quick = ${quick} is not in the catalog`).toBeDefined();
      expect(model?.thinksByDefault, `${p.id}.quick = ${quick} thinks by default`).not.toBe(true);
      expect(model?.adaptiveThinkingOnly, `${p.id}.quick = ${quick} always thinks`).not.toBe(true);
    }
  });

  it('flags every Claude generation-5+ model as thinking by default', () => {
    const anthropic = catalog.providers.find((p) => p.id === 'anthropic');
    const gen5 = (anthropic?.models ?? []).filter((m) => /^claude-[a-z]+-([5-9]|\d{2,})(-|$)/.test(m.id));
    expect(gen5.length).toBeGreaterThan(0);
    for (const m of gen5) expect(m.thinksByDefault, m.id).toBe(true);
  });
});
