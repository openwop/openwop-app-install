/**
 * feature.interactive-artifacts.nodes — the producer for ADR 0128 interactive
 * artifacts. The `render` node maps a requested `kind` to an
 * `interactive.<kind>` artifact type and emits the typed `{ artifact }` output
 * envelope (ADR 0055/0083): the host run-output producer persists it with that
 * artifactTypeId + the payload as the artifact CONTENT, and the chat workbench's
 * security-reviewed sandboxed canvas (Mermaid / Chart / SandboxedArtifactFrame)
 * dispatches on the type and renders the content.
 *
 * The content the renderer reads is the RAW SOURCE — mermaid text for mermaid,
 * the {chartType,data,options} spec for chart, HTML for html, JSX for react —
 * NOT a structured payload, so that is exactly what this node emits.
 *
 * Pure-JS, Node-20 stdlib only. No host capability — content-trust is UNTRUSTED
 * (model-authored), which the renderers already assume: origin-isolated, never
 * innerHTML, and HTML is static until the viewer runs its scripts (running scripts
 * CAN reach the network, which is why the viewer is asked).
 */

const KIND_TO_TYPE = {
  mermaid: 'interactive.mermaid',
  chart: 'interactive.chart',
  html: 'interactive.html',
  react: 'interactive.react',
};

/** The chart types the workbench can draw. Pinned to the host schema's enum and the
 *  renderer's `SUPPORTED_CHART_TYPES` by the interactive-artifacts parity test (this
 *  pack cannot import either). */
const CHART_TYPES = ['bar', 'line'];

function fail(message) {
  return Object.assign(new Error(message), { code: 'validation_error' });
}

function safeParse(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}

export async function render(ctx) {
  const i = ctx.inputs ?? {};
  const kind = typeof i.kind === 'string' ? i.kind.trim().toLowerCase() : 'mermaid';
  const artifactTypeId = KIND_TO_TYPE[kind];
  if (!artifactTypeId) {
    throw fail(`unsupported \`kind\` "${kind}" — one of: ${Object.keys(KIND_TO_TYPE).join(' | ')}`);
  }

  let payload;
  if (kind === 'chart') {
    // The chart renderer parses the content as JSON {chartType, data, options}.
    payload = i.chart && typeof i.chart === 'object' ? i.chart : safeParse(i.source);
    if (!payload || typeof payload !== 'object' || typeof payload.chartType !== 'string' || !payload.data || typeof payload.data !== 'object') {
      throw fail('`chart` must be (or `source` must be JSON for) an object { chartType, data: { labels?, datasets: [{ label?, data: number[] }] }, options? }');
    }
    // A chart the workbench cannot draw is a failure here, not a success that the
    // host then stores as an untyped blob.
    if (!CHART_TYPES.includes(payload.chartType)) {
      throw fail(`unsupported \`chartType\` "${payload.chartType}" — one of: ${CHART_TYPES.join(' | ')}`);
    }
    const datasets = payload.data.datasets;
    if (!Array.isArray(datasets) || datasets.length === 0 || !datasets.every((d) => d && typeof d === 'object' && Array.isArray(d.data))) {
      throw fail('`chart.data.datasets` must be a non-empty array of { label?, data: number[] }');
    }
  } else {
    // mermaid / html / react — the renderer reads the raw source text verbatim.
    payload = typeof i.source === 'string' ? i.source : '';
    if (!payload.trim()) throw fail('`source` is required (the raw mermaid / HTML / JSX text)');
  }

  const title = typeof i.title === 'string' && i.title.trim() ? i.title.trim() : undefined;

  // Typed-artifact envelope (ADR 0055/0128) — the host producer reads
  // `artifact.{artifactTypeId,payload,title}` and persists a renderable run
  // artifact. UNTRUSTED: the source is model-authored; the canvas isolates it.
  return {
    status: 'success',
    outputs: {
      kind,
      artifact: {
        artifactTypeId,
        payload,
        contentTrust: 'untrusted',
        ...(title ? { title } : {}),
      },
    },
  };
}

export const nodes = {
  'feature.interactive-artifacts.nodes.render': render,
};
