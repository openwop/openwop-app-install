import { test, expect, type Page } from '@playwright/test';
import { API } from './support/session.js';

/**
 * NPV2-U-9 — every connection HANDLE sits level with the LABEL of the port it
 * belongs to, on both sides, including the lone port of a mixed node.
 *
 * Why this is correctness, not polish: a handle's id is its port, and an edge
 * dropped on it is persisted as `targetInput` — it routes data into THAT field.
 * Handles used to be spaced 20px around the centre of the WHOLE node, while
 * labels are 22px rows below the header, so on a multi-port node a handle sat
 * beside another port's label. MEASURED before the fix: 17.5px off on a
 * two-input node.
 *
 * The fixture is chosen from the live catalog and then MEASURED AS RENDERED: a
 * static catalog entry may override a node's ports, so the spec never trusts the
 * schema's `required` count alone.
 */
type CatNode = {
  typeId: string; ports?: string; missingHostSurfaces?: string[];
  inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
  outputSchema?: { required?: string[]; properties?: Record<string, unknown> };
};
const portsOf = (s: CatNode['inputSchema']) => (s?.required ?? []).filter((k) => s?.properties?.[k]).length;

async function login(page: Page): Promise<void> {
  const res = await page.request.post(`${API}/test/login`, { data: { email: 'port-align-e2e@example.com' } });
  expect(res.status(), `login: ${await res.text()}`).toBe(201);
}

type Row = { nodeId: string; side: 'in' | 'out'; name: string; dy: number | null; edgeOffset: number | null; count: number };

test('every handle is level with its own port label, on both sides', async ({ page }) => {
  await login(page);
  const cat = await page.request.get(`${API}/node-catalog`);
  expect(cat.ok(), `node-catalog: ${cat.status()}`).toBe(true);
  const nodes = ((await cat.json()) as { nodes: CatNode[] }).nodes
    .filter((n) => n.ports !== 'single' && (n.missingHostSurfaces?.length ?? 0) === 0);
  const multiIn = nodes.filter((n) => portsOf(n.inputSchema) >= 2).slice(0, 4);
  const multiOut = nodes.filter((n) => portsOf(n.outputSchema) >= 2).slice(0, 4);
  const mixed = nodes.filter((n) => portsOf(n.inputSchema) >= 2 && portsOf(n.outputSchema) <= 1).slice(0, 2);
  const picks = [...new Map([...multiIn, ...multiOut, ...mixed].map((n) => [n.typeId, n])).values()];
  expect(picks.length, 'the catalog serves multi-port nodes').toBeGreaterThan(0);

  const workflowId = `wf.port-align.${Date.now()}`;
  const seed = await page.request.post(`${API}/workflows`, {
    data: {
      workflowId,
      metadata: { name: 'Port alignment e2e' },
      nodes: [
        // A single-port reference: where a handle sits on the node edge.
        { nodeId: 'ref', typeId: 'core.noop', name: 'Reference', config: {} },
        ...picks.map((n, i) => ({ nodeId: `n${i}`, typeId: n.typeId, name: n.typeId, config: {} })),
      ],
      edges: [],
    },
  });
  expect(seed.status(), `seed: ${await seed.text()}`).toBeLessThan(300);

  await page.goto(`/builder/${encodeURIComponent(workflowId)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.react-flow__node[data-id="ref"] .builder-node').waitFor({ state: 'visible', timeout: 20_000 });

  const { rows, ref } = await page.evaluate(() => {
    const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const edgeOf = (node: Element, side: 'in' | 'out', hx: number) => {
      const nr = node.getBoundingClientRect();
      return side === 'in' ? hx - nr.left : nr.right - hx;
    };
    const refNode = document.querySelector('.react-flow__node[data-id="ref"] .builder-node') as Element;
    const refIn = refNode.querySelector('.react-flow__handle-left')!.getBoundingClientRect();
    const refOut = refNode.querySelector('.react-flow__handle-right')!.getBoundingClientRect();
    const ref = { in: edgeOf(refNode, 'in', centre(refIn).x), out: edgeOf(refNode, 'out', centre(refOut).x) };
    const out: Row[] = [];
    for (const wrap of document.querySelectorAll('.react-flow__node')) {
      const nodeId = wrap.getAttribute('data-id') ?? '';
      if (nodeId === 'ref') continue;
      const node = wrap.querySelector('.builder-node');
      if (!node) continue;
      for (const side of ['in', 'out'] as const) {
        const col = node.querySelectorAll(side === 'in'
          ? '.builder-node-ports-col:not(.builder-node-ports-col-right) .builder-node-port-label'
          : '.builder-node-ports-col-right .builder-node-port-label');
        for (const l of col) {
          const name = l.textContent ?? '';
          const h = node.querySelector(`.react-flow__handle-${side === 'in' ? 'left' : 'right'}[data-handleid="${CSS.escape(name)}"]`);
          const lc = centre(l.getBoundingClientRect());
          const hc = h ? centre(h.getBoundingClientRect()) : null;
          out.push({ nodeId, side, name, count: col.length, dy: hc ? hc.y - lc.y : null, edgeOffset: hc ? edgeOf(node, side, hc.x) : null });
        }
      }
    }
    return { rows: out, ref };
  });

  // Coverage — measured on what RENDERED, not on what the schema implied.
  const byNode = (side: 'in' | 'out', min: number) => new Set(rows.filter((r) => r.side === side && r.count >= min).map((r) => r.nodeId));
  expect(byNode('in', 2).size, 'at least one rendered node has several INPUT ports').toBeGreaterThan(0);
  expect(byNode('out', 2).size, 'at least one rendered node has several OUTPUT ports').toBeGreaterThan(0);
  const mixedRendered = [...byNode('in', 2)].filter((id) => rows.some((r) => r.nodeId === id && r.side === 'out' && r.count === 1));
  expect(mixedRendered.length, 'at least one rendered MIXED node (several inputs, one output)').toBeGreaterThan(0);

  for (const r of rows) {
    const where = `${r.nodeId} ${r.side} "${r.name}"`;
    expect(r.dy, `${where}: a handle exists`).not.toBeNull();
    // Only nodes whose handles moved into rows (a multi-port side) are in scope;
    // a node with one port per side keeps its centred handle, as before.
    if (!rows.some((x) => x.nodeId === r.nodeId && x.count > 1)) continue;
    expect(Math.abs(r.dy as number), `${where}: level with its label (dy=${r.dy})`).toBeLessThanOrEqual(3);
    expect(Math.abs((r.edgeOffset as number) - ref[r.side]), `${where}: on the node edge like a single-port handle (${r.edgeOffset} vs ${ref[r.side]})`).toBeLessThanOrEqual(1);
  }
});
