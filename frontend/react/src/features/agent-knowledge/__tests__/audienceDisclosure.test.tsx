/**
 * ADR 0664 D2 — the grant is real and intended; the disclosure was missing.
 *
 * ADR 0643 R3 decided that binding a corpus to an agent IS the grant: anyone who can address
 * that agent may retrieve it, and that access does not lapse when the binder's own does. This
 * ADR does not reverse that. It fixes the fact that the panel had ZERO strings saying so, so
 * a member could bind a private project corpus to a workspace-wide agent and be told nothing.
 *
 * Born red: `grep audience src/features/agent-knowledge/i18n/en.ts` returned nothing.
 *
 * The disclosure sits on the create-collection door because that is the SPA's actual grant
 * door — `bindCollection` exists in the client and has no importer. A test asserting copy on
 * a bind-existing control would be asserting a surface no user can reach.
 *
 * CORRECTED (grade-tests w11): a case here DID assert exactly that — `audienceBoundWarning`, the
 * restricted-collection warning, which no component renders — and was removed as a dead
 * subject. And no case rendered the panel, so deleting the `<Trans i18nKey="audienceDisclosure">`
 * left this file green; the render case closes that.
 *
 * Sabotage that turns this red (w11 probes): an es disclosure without `{{persona}}` (case 1);
 * dropping the "does not end when your own access" clause (case 2 + render); restoring "Private
 * to this agent" (notesHint); an extra key in one locale (parity — the build's
 * `scripts/check-i18n.mjs` parity check also refuses that); deleting the panel's `<Trans>`
 * (render case).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { messages as en } from '../i18n/en';
import { messages as es } from '../i18n/es';
import { messages as fr } from '../i18n/fr';
import { messages as ptBR } from '../i18n/pt-BR';
import type { AgentKnowledgeView } from '../agentKnowledgeClient.js';

const LOCALES: Record<string, Record<string, string>> = { en, es, fr, 'pt-BR': ptBR };

const VIEW: AgentKnowledgeView = { agentId: 'a1', knowledgeEnabled: true, memoryWritable: false, noteCount: 0, collections: [] };
vi.mock('../agentKnowledgeClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../agentKnowledgeClient.js')>();
  return { ...orig, getAgentKnowledge: vi.fn(async () => VIEW), listOrgs: vi.fn(async () => []) };
});
import { AgentKnowledgePanel } from '../AgentKnowledgePanel.js';
afterEach(cleanup);

describe('ADR 0664 D2 — the audience disclosure', () => {
  it('exists in every locale and names the agent, so it says WHO can see it', () => {
    for (const [loc, bundle] of Object.entries(LOCALES)) {
      expect(bundle.audienceDisclosure, `${loc}: the disclosure must exist`).toBeTruthy();
      expect(bundle.audienceDisclosure, `${loc}: it must name the agent, not say "an agent"`).toContain('{{persona}}');
    }
  });

  it('states the part a reader would otherwise get wrong: access outlives the binder’s own', () => {
    // ADR 0643's recorded residual said only that a binding outlives its binder's MEMBERSHIP.
    // The wider fact — anyone who can use the agent, from the moment of binding — is what a
    // person needs BEFORE they bind, so the copy must carry it rather than imply it.
    expect(en.audienceDisclosure).toMatch(/not end when your own access/i);
    expect(en.audienceDisclosure).toMatch(/not in the project/i);
  });

  it('the panel RENDERS the disclosure with the agent named — the catalog alone proves nothing', async () => {
    render(<AgentKnowledgePanel rosterId="a1" persona="Iris" />);
    const p = await screen.findByText((_, el) => el?.tagName === 'P' && /Anyone who can use Iris can retrieve/.test(el.textContent ?? ''));
    expect(p.textContent).not.toContain('{{persona}}');
    expect(p.textContent).toMatch(/not end when your own access/);
  });

  it('notesHint no longer claims private-to-this-agent — that was never true', () => {
    // `AGKM-3`: notes survived a delete/re-create of the same persona, so "Private to this
    // agent" was false across that boundary. D1 closed the leak; the copy stops overclaiming
    // either way, because "private" was never the right word for something every user of the
    // agent can elicit.
    for (const [loc, bundle] of Object.entries(LOCALES)) {
      expect(bundle.notesHint, `${loc}: must not claim privacy it does not have`).not.toMatch(/private to this agent/i);
    }
    expect(en.notesHint).toMatch(/anyone who can use this agent/i);
  });

  it('every locale carries the same keys — a disclosure missing in one language is not a disclosure', () => {
    const keys = Object.keys(en).sort();
    for (const [loc, bundle] of Object.entries(LOCALES)) {
      expect(Object.keys(bundle).sort(), `${loc} key parity`).toEqual(keys);
    }
  });
});
