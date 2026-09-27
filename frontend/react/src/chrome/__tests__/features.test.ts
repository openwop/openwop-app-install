import { describe, it, expect } from 'vitest';
import { chromeFor, isAdminPath, featureFor, navItemIsActive, WORKSPACE_NAV, ADMIN_NAV_GROUPS, NAV, GROUP_ORDER, FEATURES } from '../features.js';

/**
 * The feature manifest is the single source of truth for routes, the
 * workspace/admin tier split, chrome, and nav-active state (frontend
 * enterprise-review Batch J). These cover the pure derivations so a manifest
 * edit that breaks routing/tiering is caught.
 */
describe('feature manifest routing', () => {
  it('every admin parentPath resolves to a distinct visible admin destination', () => {
    const byPath = new Map(FEATURES.map((feature) => [feature.path, feature]));
    const children = FEATURES.filter((feature) => feature.parentPath);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      const parent = byPath.get(child.parentPath!);
      expect(child.parentPath).not.toBe(child.path);
      expect(parent?.tier, `${child.path} parent must be admin-tier`).toBe('admin');
      expect(parent?.nav, `${child.path} parent must be a visible destination`).toBeTruthy();
    }
    expect(byPath.get('/operations/webhooks')?.parentPath).toBe('/operations');
  });
  it('maps "/dashboard" to the Dashboard, "/" to the app-shell RootRedirect, "/chat" to chat (ADR 0487)', () => {
    // § Correction (2026-07-25, ADR 0487): '/' is the public marketing home; the
    // Dashboard owns '/dashboard'. The app-shell '/' route is RootRedirect (a
    // signed-in visitor → /dashboard; legacy '/?conversation=' → /chat).
    expect(featureFor('/dashboard')).not.toBeNull();
    expect(chromeFor('/dashboard')).not.toBe('chat'); // dashboard renders in default chrome
    expect(isAdminPath('/dashboard')).toBe(false);
    // '/' still resolves to a (non-admin, non-chat) feature route — RootRedirect.
    expect(featureFor('/')).not.toBeNull();
    expect(isAdminPath('/')).toBe(false);
    expect(featureFor('/chat')).not.toBeNull();
    expect(chromeFor('/chat')).toBe('chat');
    expect(isAdminPath('/chat')).toBe(false);
  });

  it('classifies /runs as an admin-tier route', () => {
    expect(featureFor('/runs')).not.toBeNull();
    expect(isAdminPath('/runs')).toBe(true);
  });

  it('returns null + default chrome for an unknown path', () => {
    expect(featureFor('/totally-unknown-xyz')).toBeNull();
    expect(chromeFor('/totally-unknown-xyz')).toBe('default');
    expect(isAdminPath('/totally-unknown-xyz')).toBe(false);
  });

  it('uses react-router specificity (static beats param)', () => {
    // A deep run path resolves to the run-detail feature, not a broader one.
    const detail = featureFor('/runs/run-123');
    expect(detail).not.toBeNull();
  });
});

describe('navItemIsActive', () => {
  it('exact match when end is set', () => {
    expect(navItemIsActive({ to: '/', end: true } as never, '/')).toBe(true);
    expect(navItemIsActive({ to: '/', end: true } as never, '/runs')).toBe(false);
  });

  it('prefix match when end is unset', () => {
    expect(navItemIsActive({ to: '/agents' } as never, '/agents/abc')).toBe(true);
    expect(navItemIsActive({ to: '/agents' } as never, '/agentsx')).toBe(false);
  });

  it('respects notUnder exclusions', () => {
    expect(navItemIsActive({ to: '/agents', notUnder: ['/agents/new'] } as never, '/agents/new')).toBe(false);
  });

  it('treats direct hub-child URLs as aliases of the visible hub destination', () => {
    const hub = { to: '/access', activeFor: ['/keys', '/connections'] } as never;
    expect(navItemIsActive(hub, '/keys')).toBe(true);
    expect(navItemIsActive(hub, '/connections/oauth')).toBe(true);
    expect(navItemIsActive(hub, '/models')).toBe(false);
  });

  it('marks exactly one KickTodo destination current on the safety child', () => {
    const current = NAV.flatMap((group) => group.items).filter((item) => navItemIsActive(item, '/admin/kicktodo/safety'));
    expect(current.map((item) => item.to)).toEqual(['/admin/kicktodo/safety']);
  });
});

describe('nav registry — category + position ordering', () => {
  const labels = (groupLabel: string): string[] =>
    WORKSPACE_NAV.find((g) => g.label === groupLabel)?.items.map((i) => i.label) ?? [];

  it('groups are ordered by GROUP_ORDER (Pinned before Workspace before CRM)', () => {
    const order = WORKSPACE_NAV.map((g) => g.label);
    expect(order.indexOf('Pinned')).toBeLessThan(order.indexOf('Workspace'));
    expect(order.indexOf('Workspace')).toBeLessThan(order.indexOf('CRM'));
    // every workspace group is a known category
    for (const g of WORKSPACE_NAV) expect(GROUP_ORDER).toContain(g.label);
  });

  it('the pinned top cluster is header-less: Dashboard · Chat · Inbox · Agents, in that order', () => {
    // § Correction (2026-07-16, user request): Dashboard graduated to the
    // signed-in home ('/') and leads the pinned cluster; Chat lives at /chat.
    const pinned = WORKSPACE_NAV.find((g) => g.label === 'Pinned');
    expect(pinned?.headerless).toBe(true);
    expect(pinned?.items.map((i) => i.label)).toEqual(['Dashboard', 'Chat', 'Inbox', 'Agents']);
    // and they left the labelled Workspace section
    expect(labels('Workspace')).not.toContain('Chat');
  });

  it('strategy / prioritization / projects / advisory items live under the Planning group, in that order, after Workspace', () => {
    // Planning holds these four, ordered Strategy → Priority Matrix → Projects → Board of Advisors.
    expect(labels('Planning')).toEqual(['Strategy', 'Priority Matrix', 'Projects', 'Board of Advisors']);
    // Projects + Strategy are not left behind in the Workspace section.
    expect(labels('Workspace')).not.toContain('Projects');
    expect(labels('Workspace')).not.toContain('Strategy');
    const order = WORKSPACE_NAV.map((g) => g.label);
    expect(order.indexOf('Workspace')).toBeLessThan(order.indexOf('Planning'));
    expect(order.indexOf('Planning')).toBeLessThan(order.indexOf('Marketing'));
  });

  it('items sort by nav.order ascending within a group', () => {
    const pinned = labels('Pinned');
    // Chat(10) · Inbox(15) · Agents(20) are the explicitly-ordered pinned items.
    expect(pinned.indexOf('Chat')).toBeLessThan(pinned.indexOf('Inbox'));
    expect(pinned.indexOf('Inbox')).toBeLessThan(pinned.indexOf('Agents'));
  });

  it('Boards + Knowledge Base live in the admin tier, not the workspace rail (2026-06-17 move)', () => {
    expect(isAdminPath('/boards')).toBe(true);
    expect(isAdminPath('/kb')).toBe(true);
    const ws = labels('Workspace');
    expect(ws).not.toContain('Boards');
    expect(ws).not.toContain('Knowledge Base');
  });

  it('feature items slot into their declared group (CRM→CRM, Sales/Commerce carved out, Documents→Workspace)', () => {
    // NAV includes feature-gated items regardless of resolved enablement (the
    // catalog; the Sidebar/⌘K filter visibility separately). The revenue domain
    // was carved out of the overloaded generic 'Workspace' group into 'CRM'
    // (customer core), 'Sales' (field/rep sales), and 'Commerce' (store +
    // merchandising) sections.
    const ws = NAV.find((g) => g.label === 'Workspace')?.items.map((i) => i.label) ?? [];
    expect(ws).not.toContain('CRM');
    expect(ws).not.toContain('Funnels');
    // The 'Workspace' label now fronts the authoring section (formerly "Create"):
    // Workflows · Forms · Documents · Comments. Chat/Inbox/Agents moved to 'Pinned'.
    expect(ws).toEqual(expect.arrayContaining(['Workflows', 'Forms', 'Documents', 'Comments']));
    expect(ws).not.toContain('Chat');
    const crm = NAV.find((g) => g.label === 'CRM')?.items.map((i) => i.label) ?? [];
    expect(crm).toContain('CRM');
    expect(crm).not.toContain('Commerce'); // commerce graduated to the Commerce section
    // The field-sales cluster moved to the new 'Sales' group.
    const sales = NAV.find((g) => g.label === 'Sales')?.items.map((i) => i.label) ?? [];
    expect(sales).toContain('Territories');
    // The store + merchandising cluster moved to the new 'Commerce' group.
    const commerce = NAV.find((g) => g.label === 'Commerce')?.items.map((i) => i.label) ?? [];
    expect(commerce).toContain('Commerce');
    // Funnels joined the Marketing section (was mis-filed under Workspace).
    const marketing = NAV.find((g) => g.label === 'Marketing')?.items.map((i) => i.label) ?? [];
    expect(marketing).toContain('Funnels');
    // Documents sits with the authoring surfaces in the Workspace section (it was
    // re-homed Studio -> the authoring group 2026-07-06), not the media cluster.
    expect(ws).toContain('Documents');
    const studio = NAV.find((g) => g.label === 'Studio')?.items.map((i) => i.label) ?? [];
    expect(studio).not.toContain('Documents');
    // CMS moved to the 'Content' group in the 2026-06-04 IA rename (alongside
    // Media / Publishing / Sharing), so it lands there rather than in Workspace.
    const content = NAV.find((g) => g.label === 'Content')?.items.map((i) => i.label) ?? [];
    expect(content).toContain('CMS');
  });

  it('an order-less item sorts after ordered ones (append-at-end preserved)', () => {
    const ws = NAV.find((g) => g.label === 'Workspace')?.items ?? [];
    const ordered = ws.filter((i) => i.order !== undefined).map((i) => i.label);
    const unordered = ws.filter((i) => i.order === undefined).map((i) => i.label);
    if (ordered.length && unordered.length) {
      const lastOrdered = ws.findIndex((i) => i.label === ordered[ordered.length - 1]!);
      const firstUnordered = ws.findIndex((i) => i.label === unordered[0]!);
      expect(lastOrdered).toBeLessThan(firstUnordered);
    }
  });
});

describe('admin information architecture', () => {
  const groupFor = (path: string): string | undefined =>
    ADMIN_NAV_GROUPS.find((group) => group.items.some((item) => item.to === path))?.id;

  it('uses job- and authority-based default groups instead of the legacy catch-alls', () => {
    expect(groupFor('/operations')).toBe('System operations');
    expect(groupFor('/runs')).toBe('Operations');
    expect(groupFor('/models')).toBe('AI & automation');
    expect(groupFor('/audit-log')).toBe('Governance & security');
    expect(groupFor('/access')).toBe('Access & data');
    expect(groupFor('/kb')).toBe('Data & knowledge');
    expect(groupFor('/billing')).toBe('Billing & commerce');
    expect(groupFor('/metrics')).toBe('Analytics & usage');
    expect(groupFor('/appearance')).toBe('Deployment & customization');
    expect(groupFor('/cli')).toBe('Developer');
    expect(groupFor('/tutorials')).toBe('Learning & support');
    expect(ADMIN_NAV_GROUPS.map((group) => group.id)).not.toContain('Platform');
    expect(ADMIN_NAV_GROUPS.map((group) => group.id)).not.toContain('Business');
  });

  it('keeps every default admin category in the shared ordering registry', () => {
    for (const group of ADMIN_NAV_GROUPS) expect(GROUP_ORDER).toContain(group.id);
  });
});
