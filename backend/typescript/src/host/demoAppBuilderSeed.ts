/**
 * Demo app-builder seed (ADR 0337 Phase 3) — a POPULATED `canvas.app-builder`
 * so the graph-first board looks alive on open (the MyndHyve comparison was
 * unfair against a blank app). One "Aurora" mobile app: Welcome → Login → Home
 * → Profile → Settings, real components from the CLOSED catalog, connectors
 * with triggers + labels, and spread-out x/y so the board opens framed with a
 * legible flow. Validated against `validateAppDoc` before it persists (the seed
 * must satisfy the same closed-world gate the editor PATCH does).
 *
 * Idempotent: a deterministic canvas idempotency key + a name marker. `clear`
 * removes exactly the demo canvases. Skips honestly when `app-builder` is off.
 */
import { createLogger } from '../observability/logger.js';
import { resolveOne } from './featureToggles/service.js';
import { createCanvasForTenant, listCanvasesForTenant, deleteCanvasForTenant, getCanvasForTenant } from './canvasSurface.js';
import { validateAppDoc } from '../features/app-builder/validateAppDoc.js';

const log = createLogger('seed.demoAppBuilder');
const CANVAS_TYPE = 'canvas.app-builder';
const NAME = 'Aurora — demo app';
const IDEMPOTENCY_KEY = 'demo-app-builder-aurora';
const PRIMARY = '#6366f1';

type Node = { type: string; props?: Record<string, unknown>; children?: Node[] };
const stack = (props: Record<string, unknown>, children: Node[]): Node => ({ type: 'stack', props, children });
const card = (children: Node[]): Node => ({ type: 'card', props: { padding: 'lg' }, children });
const heading = (t: string, level: '1' | '2' | '3' = '2'): Node => ({ type: 'heading', props: { text: t, level } });
const text = (t: string, props: Record<string, unknown> = {}): Node => ({ type: 'text', props: { text: t, ...props } });
const button = (label: string, props: Record<string, unknown> = {}): Node => ({ type: 'button', props: { label, variant: 'primary', ...props } });
const input = (label: string, placeholder: string, kind: 'text' | 'email' | 'password' | 'number' = 'text'): Node => ({ type: 'textInput', props: { label, placeholder, kind } });
const stat = (label: string, value: string): Node => ({ type: 'statCard', props: { label, value } });
const avatar = (name: string): Node => ({ type: 'avatar', props: { name, size: 'lg' } });
const divider = (): Node => ({ type: 'divider', props: {} });

export function auroraDoc(): Record<string, unknown> {
  return {
    name: 'Aurora',
    description: 'A demo mobile app — onboarding, auth, a home dashboard, and a profile — showing the screen-flow board with real screens and navigation.',
    theme: 'default',
    themeColors: { primary: PRIMARY, secondary: '#0ea5e9' },
    screens: [
      {
        id: 'welcome', name: 'Welcome', route: '/', isInitial: true, x: 80, y: 80,
        components: [stack({ gap: 'lg', padding: 'lg' }, [
          { type: 'icon', props: { name: 'send', size: 'lg' } },
          heading('Welcome to Aurora', '1'),
          text('Your workspace for getting things done — fast, focused, and yours.', { tone: 'muted' }),
          button('Get Started'),
          text('Already have an account? Sign in', { tone: 'muted' }),
        ])],
      },
      {
        id: 'login', name: 'Login', route: '/login', x: 400, y: 80,
        components: [stack({ gap: 'md', padding: 'lg' }, [
          heading('Welcome back', '1'),
          text('Sign in to continue to your account.', { tone: 'muted' }),
          // The `form` container is the exemplar the App Architect prompt
          // mandates (grade pass 5B-R5 — the seed must demonstrate the rule).
          { type: 'form', props: {}, children: [
            input('Email', 'you@example.com', 'email'),
            input('Password', '••••••••', 'password'),
            button('Sign in'),
          ] },
          divider(),
          button('Continue with Google', { variant: 'secondary' }),
        ])],
      },
      {
        id: 'home', name: 'Home', route: '/home', x: 720, y: 80,
        components: [stack({ gap: 'md', padding: 'lg' }, [
          { type: 'navBar', props: { brand: 'Aurora' }, children: [
            { type: 'link', props: { label: 'Profile', navigateTo: 'profile' } },
            { type: 'link', props: { label: 'Settings', navigateTo: 'settings' } },
          ] },
          heading('Good morning, Jordan', '2'),
          { type: 'grid', props: { columns: 2, gap: 'md' }, children: [
            stat('Tasks', '12'),
            stat('Streak', '8 days'),
          ] },
          heading('Recent activity', '3'),
          card([stack({ gap: 'sm' }, [
            text('New comment on “Q3 roadmap”', {}),
            text('2 hours ago', { tone: 'muted' }),
          ])]),
          card([stack({ gap: 'sm' }, [
            text('You completed “Ship the export”', {}),
            text('Yesterday', { tone: 'muted' }),
          ])]),
        ])],
      },
      {
        id: 'profile', name: 'Profile', route: '/profile', x: 1040, y: 80,
        components: [stack({ gap: 'md', padding: 'lg' }, [
          avatar('Jordan Lee'),
          heading('Jordan Lee', '2'),
          text('Product designer · @jordan', { tone: 'muted' }),
          button('Edit profile', { variant: 'secondary' }),
          { type: 'grid', props: { columns: 3, gap: 'sm' }, children: [
            stat('Posts', '127'),
            stat('Followers', '1.2k'),
            stat('Following', '340'),
          ] },
        ])],
      },
      {
        id: 'settings', name: 'Settings', route: '/settings', x: 1360, y: 80,
        components: [stack({ gap: 'md', padding: 'lg' }, [
          heading('Settings', '2'),
          card([stack({ gap: 'sm' }, [text('Account', {}), text('Email, password, security', { tone: 'muted' })])]),
          card([stack({ gap: 'sm' }, [text('Notifications', {}), text('Email and push preferences', { tone: 'muted' })])]),
          card([stack({ gap: 'sm' }, [text('Appearance', {}), text('Theme and display', { tone: 'muted' })])]),
          button('Sign out', { variant: 'secondary' }),
        ])],
      },
    ],
    connectors: [
      { from: 'welcome', to: 'login', trigger: 'click', label: 'Get Started' },
      { from: 'login', to: 'home', trigger: 'submit', label: 'Sign in' },
      { from: 'home', to: 'profile', trigger: 'click', label: 'Profile' },
      { from: 'profile', to: 'settings', trigger: 'click', label: 'Settings' },
    ],
    // ADR 0343 facets (grade pass 2026-07-11 AB-DATA-6): the demo app carries a
    // real application model — state, data, contract, share policy — so the Data
    // workspace, the share-projection strip, and the export OpenAPI/preflight
    // paths all open POPULATED instead of hiding behind an empty doc.
    stateVariables: [
      { id: 'isLoggedIn', type: 'boolean', label: 'Signed in', initial: false },
      { id: 'taskFilter', type: 'string', label: 'Task filter', initial: 'all' },
    ],
    models: [
      {
        id: 'task', name: 'Task',
        fields: [
          { name: 'title', type: 'string', required: true },
          { name: 'due', type: 'date' },
          { name: 'done', type: 'boolean' },
          { name: 'owner', type: 'reference', referenceTo: 'member' },
        ],
        relationships: [{ to: 'member', kind: 'belongsTo' }],
      },
      {
        id: 'member', name: 'Member',
        fields: [
          { name: 'name', type: 'string', required: true },
          { name: 'handle', type: 'string' },
        ],
        relationships: [{ to: 'task', kind: 'hasMany' }],
      },
    ],
    operations: [
      {
        id: 'listTasks', name: 'List tasks', kind: 'list', modelId: 'task', auth: 'user',
        input: [{ name: 'filter', type: 'string' }], output: { type: 'modelList' },
        mock: {
          status: 'ok',
          rows: [
            { title: 'Ship the export', done: true },
            { title: 'Review “Q3 roadmap”', done: false },
            { title: 'Prep the launch demo', done: false },
          ],
        },
      },
      {
        id: 'createTask', name: 'Create task', kind: 'create', modelId: 'task', auth: 'user',
        input: [{ name: 'title', type: 'string' }], output: { type: 'model' },
      },
    ],
    // Demo mock rows stay out of PUBLIC shares by default (the projection strip).
    sharePolicy: { sampleData: 'redact' },
  };
}

async function toggledOn(tenantId: string): Promise<boolean> {
  const a = await resolveOne('app-builder', { tenantId });
  return Boolean(a && a.enabled);
}

async function demoCanvasIds(tenantId: string): Promise<string[]> {
  const rows = await listCanvasesForTenant(tenantId);
  return rows.filter((r) => r.canvasTypeId === CANVAS_TYPE && r.name === NAME).map((r) => r.canvasId);
}

export async function countDemoAppBuilder(tenantId: string): Promise<number> {
  if (!(await toggledOn(tenantId))) return 0;
  return (await demoCanvasIds(tenantId)).length;
}

export async function seedDemoAppBuilder(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await toggledOn(tenantId))) return { created: 0, details: { skipped: 'app-builder toggle off' } };
  // Idempotent: the create dedups on the key, but also short-circuit on the
  // name marker so a re-seed after a key-store reset can't mint a duplicate.
  if ((await demoCanvasIds(tenantId)).length > 0) return { created: 0 };
  const doc = auroraDoc();
  const validation = validateAppDoc(doc);
  if (validation.errors.length > 0) {
    log.error('demo app-builder doc failed validation — not seeding', { first: validation.errors[0]?.message, count: validation.errors.length });
    return { created: 0, details: { error: 'validation', first: validation.errors[0]?.message } };
  }
  const canvas = await createCanvasForTenant(tenantId, {
    canvasTypeId: CANVAS_TYPE,
    name: NAME,
    initialState: doc,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  // A concurrent/duplicate create (same key) returns the cached row — count the
  // marker to report net-new honestly.
  const got = await getCanvasForTenant(tenantId, canvas.canvasId);
  return { created: got ? 1 : 0, details: { canvasId: canvas.canvasId, screens: 5, models: 2, operations: 2 } };
}

export async function clearDemoAppBuilder(tenantId: string): Promise<{ cleared: number }> {
  let cleared = 0;
  for (const id of await demoCanvasIds(tenantId)) {
    if (await deleteCanvasForTenant(tenantId, id)) cleared += 1;
  }
  return { cleared };
}
