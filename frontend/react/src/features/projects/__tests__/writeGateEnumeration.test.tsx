/**
 * ADR 0608 D8 (`CPU-3` / `CPU-11` / `CPC-4`) — the `canWrite` pre-gate, enumerated.
 *
 * `FEATURES.md:189` promises the FE "pre-gates every write control (delete /
 * charter / members / visibility / chat / workflows / memory / knowledge /
 * schedules)". The only execution witness on that promise covered **2 of the 9**
 * controls (`ProjectMembersTab.access.test.tsx` — Add / Remove / the toggle, all
 * inside one component), so **no test could fail** on the other seven. That is why
 * `CPU-3` shipped green through PR #3412 and a full grade loop: the enumerated
 * result was 6 clean, 1 FALSIFIED (`Run now`), 2 degraded.
 *
 * This file covers the two controls the enumeration found wrong, in BOTH
 * polarities, at the component that owns each:
 *
 *   - `workflows` — `Run now` was never gated on `canWrite` at all.
 *   - `chat` — "Open project chat" was OVER-gated on `canWrite` while the server
 *     gates the route on READ, so a read-only member was locked out of the room the
 *     feature is named for and shown a false statement of the server's rule.
 *
 * Both directions matter and they point opposite ways: the workflows case asserts
 * a control is HIDDEN for a reader, the chat case asserts one is SHOWN. A gate test
 * that only ever asserts absence cannot tell a correct gate from a broken screen.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Project } from '../projectsClient.js';
import { messages as en } from '../i18n/en.js';

// Mock the modules ProjectWorkflowsTab ACTUALLY imports (check-inert-mocks R2:
// the earlier `listProjectWorkflows`/`updateProjectWorkflows` were invented names
// projectsClient never exported, and `builder/workflowsClient` is not what the tab
// reads — so those overrides were DEAD and the tab hit the real workflow client).
vi.mock('../projectsClient.js', () => ({
  updateWorkflows: vi.fn(async () => ({})),
  getProject: vi.fn(),
}));
vi.mock('../../../workflows/workflowsClient.js', () => ({
  listWorkflowSummaries: vi.fn(async () => [{ workflowId: 'wf.alpha', name: 'Alpha' }]),
  getWorkflowRunInputs: vi.fn(async () => []),
}));
vi.mock('../../../client/runsClient.js', () => ({ createRun: vi.fn() }));
vi.mock('../../../agents/rosterClient.js', () => ({
  listRoster: vi.fn(async () => [{ rosterId: 'r1', persona: 'Ada', agentRef: { agentId: 'a1' } }]),
}));

import { ProjectWorkflowsTab } from '../ProjectWorkflowsTab.js';
import { ProjectChatTab } from '../ProjectChatTab.js';

// The project MUST seat an agent member: the cadence editor renders only when
// `agentMembers.length > 0 && canWrite`, so a memberless fixture would make the
// write-gate assertion below pass for the wrong reason (nothing to gate).
const project: Project = {
  id: 'p1', tenantId: 't', orgId: 'o1', name: 'P', workflows: ['wf.alpha'], boardId: 'b1',
  members: [{ ref: 'agent:r1', role: 'lead', addedAt: '2026-01-01T00:00:00Z' }],
} as Project;

afterEach(cleanup);

describe('canWrite pre-gate — the two controls the enumeration found wrong', () => {
  it('workflows: `Run now` is OFFERED to a writer', async () => {
    render(<MemoryRouter><ProjectWorkflowsTab projectId="p1" workflows={['wf.alpha']} canWrite={true} onSaved={() => {}} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: en.runNow })).toBeTruthy();
  });

  it('workflows: `Run now` is HIDDEN from a read-only member (was FALSIFIED)', async () => {
    render(<MemoryRouter><ProjectWorkflowsTab projectId="p1" workflows={['wf.alpha']} canWrite={false} onSaved={() => {}} /></MemoryRouter>);
    // Wait for the row to exist first — otherwise the absence assertion is
    // satisfied by a component that has simply not rendered yet, which is the
    // vacuity shape that let the original gap through.
    await screen.findByText('wf.alpha');
    expect(screen.queryByRole('button', { name: en.runNow })).toBeNull();
    // ...and `Unassign`, which WAS gated, is still gone — the control the old
    // single-control test would have caught.
    expect(screen.queryByRole('button', { name: en.unassign })).toBeNull();
  });
});

describe('chat: the room is gated on READ, matching the server (CPC-4)', () => {
  it('a WRITER sees "Open project chat"', async () => {
    render(<MemoryRouter><ProjectChatTab project={project} canWrite={true} onSaved={() => {}} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: new RegExp(en.openProjectChat) })).toBeTruthy();
  });

  it('a READ-ONLY member ALSO sees it — the server gates POST /:id/chat on project READ', async () => {
    render(<MemoryRouter><ProjectChatTab project={project} canWrite={false} onSaved={() => {}} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: new RegExp(en.openProjectChat) })).toBeTruthy();
    // The false copy is gone from the catalog entirely, in all four locales.
    expect((en as Record<string, unknown>).openChatNeedsWrite).toBeUndefined();
  });

  it('but the CADENCE EDITOR stays write-gated — that one really is a PATCH', async () => {
    // The scoping control. Ungating the room must not ungate the configuration of
    // it; a fix that opened both would trade one wrong gate for another. The
    // heading is `conveneCadenceHeading` ("Convene cadence") — the REAL i18n key;
    // the CadenceEditor that renders it mounts only under `canWrite`, so a live
    // key here is a positive control: flip this render to `canWrite={true}` and
    // this assertion MUST go red. (The prior `en.cadenceHeading` key did not
    // exist, so the query fell to a sentinel and could never match — a vacuous
    // guard that passed even with the editor mounted.)
    render(<MemoryRouter><ProjectChatTab project={{ ...project }} canWrite={false} onSaved={() => {}} /></MemoryRouter>);
    await screen.findByRole('button', { name: new RegExp(en.openProjectChat) });
    expect(screen.queryByText(en.conveneCadenceHeading)).toBeNull();
  });
});
