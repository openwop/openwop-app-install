/**
 * The public-share projection for `canvas.app-builder` (ADR 0345 3a — DS-08).
 * A share link serves a SANITIZED, render-sufficient view of the document —
 * never the raw working state. The commerce `projectQuotePublic` precedent:
 * the feature owns its public shape; the sharing resolver applies it.
 *
 * Kept (needed to render the tap-through prototype): name, description, theme,
 * themeColors, screens (component trees incl. actions/bindings — ids only),
 * connectors, componentDefinitions, stateVariables, schemaVersion, and
 * dataSources SHAPE ({id,name,fields}).
 *
 * Redacted by default: `dataSources[].rows` (design-time sample data is often
 * real-looking customer data). `sharePolicy.sampleData: 'include'` opts every
 * source's rows in; `sharePolicy.perSource[id]` overrides per source.
 *
 * Stripped always: operations (incl. mock rows — sample data by another name;
 * revisit under the policy when the 3c mock runtime reaches the share page),
 * envRequirements, authProfile, designSystemRef, brandRef — none are needed to
 * render, all leak design/infra intent.
 */

interface SharePolicyIn { sampleData?: unknown; perSource?: Record<string, unknown> }

/**
 * ADR 0835 (AB2-CD-3) — an ALLOWLIST. This used to copy the state and delete a
 * six-key denylist, so everything not on it reached a PUBLIC link: `models`
 * (the data schema, contradicting the "Kept" list above), any top-level key a
 * raw PATCH carried (`validateAppDoc` does not refuse unknown keys), and any
 * extra key on a data source. A new facet is now private until it is listed.
 */
const KEPT = ['name', 'description', 'theme', 'themeColors', 'screens', 'connectors', 'componentDefinitions', 'stateVariables', 'schemaVersion'] as const;

export function projectAppForShare(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEPT) if (state[k] !== undefined) out[k] = state[k];
  const policy = (state.sharePolicy && typeof state.sharePolicy === 'object' && !Array.isArray(state.sharePolicy)
    ? state.sharePolicy
    : {}) as SharePolicyIn;
  const includeAll = policy.sampleData === 'include';
  const perSource = policy.perSource && typeof policy.perSource === 'object' && !Array.isArray(policy.perSource)
    ? policy.perSource
    : {};
  if (Array.isArray(state.dataSources)) {
    out.dataSources = state.dataSources.map((src) => {
      if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
      const s = src as Record<string, unknown>;
      const id = typeof s.id === 'string' ? s.id : '';
      const include = perSource[id] === true || (includeAll && perSource[id] !== false);
      return {
        id,
        ...(typeof s.name === 'string' ? { name: s.name } : {}),
        ...(Array.isArray(s.fields) ? { fields: s.fields } : {}),
        ...(include && Array.isArray(s.rows) ? { rows: s.rows } : {}),
      };
    }).filter((x) => x !== null);
  }
  return out;
}
