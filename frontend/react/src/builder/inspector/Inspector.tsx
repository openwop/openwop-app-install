import { useMemo } from 'react';
/**
 * Right sidebar. Three modes:
 *   1. Node selected → name + per-kind config fields from the catalog
 *   2. Edge selected → trigger rule + condition predicate (DAG fan-in)
 *   3. Nothing selected → workflow-level fields (name + default inputs JSON)
 *
 * The per-mode sub-components live in sibling files
 * (`EdgeInspector`, `MultiSelectInspector`, `WorkflowInspector`, `ConfigInput`)
 * and the shared helpers/constants in `inspectorHelpers`.
 */

import { Button } from '../../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { beginOAuth } from '../../features/connections/connectionsClient.js';
import { toast } from '../../ui/toast.js';
import { Link } from 'react-router-dom';
import { useBuilderStore } from '../store/builderStore.js';
import { catalogEntry } from '../palette/catalogRegistry.js';
import { ConfigInput } from './ConfigInput.js';
import { EdgeInspector } from './EdgeInspector.js';
import { NodeConnections } from './NodeConnections.js';
import { NodeDebugSection } from './NodeDebugSection.js';
import { MultiSelectInspector } from './MultiSelectInspector.js';
import { WorkflowInspector } from './WorkflowInspector.js';
import { useHostAdvertisedModelCapabilities } from './inspectorHelpers.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { CheckIcon } from '../../ui/icons/index.js';

/**
 * A preset input value as a human should read it.
 *
 * Raw `JSON.stringify` buries the interesting part inside a PortValue envelope —
 * the two longest values in the shipped corpus are approval prompts a user
 * genuinely wants to read, rendered as
 * `{"type":"static","value":"An MCP client requests…"}`. Unwrap the two tagged
 * shapes the builder can encounter; anything else falls back to JSON so an
 * unrecognised shape is visible rather than silently blank.
 */
function readablePortValue(value: unknown): string | null {
  // An EMPTY string is the one value that would render blank — the outcome this
  // function's docblock promises to avoid — and it is worth seeing, because it
  // is what an unfilled `{{params.x}}` freezes to (ADR 0507). Returns null so
  // the CALLER can render a localized label; a literal here would be a
  // user-facing string outside the i18n catalogs (and `check-i18n` only scans
  // JSX, so nothing would have caught it).
  if (value === '') return null;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as { type?: unknown; value?: unknown; variableName?: unknown };
    if (v.type === 'static' && typeof v.value === 'string') return v.value === '' ? null : v.value;
    if (v.type === 'variable' && typeof v.variableName === 'string') return `{{${v.variableName}}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

/**
 * ADR 0524 Phase E — can this preset value be edited as TEXT without losing
 * information?
 *
 * Preset values are not all strings. A `{type:'variable',variableName}` ref is a
 * STRUCTURE (RFC 0124) that renders as `{{topic}}`; letting someone retype that
 * string would silently turn a live reference into a literal. An unrecognised
 * shape falls back to JSON in the display, and round-tripping JSON through a
 * text box is a corruption waiting to happen.
 *
 * So only two shapes are editable, and they are exactly the two that survive a
 * text round-trip unchanged: a bare string, and the `{type:'static',value}`
 * envelope. Everything else stays read-only and SAYS WHY — a control that
 * silently refuses to work is worse than one that is visibly absent.
 */
function editablePreset(value: unknown): { kind: 'string' | 'static'; text: string } | null {
  if (typeof value === 'string') return { kind: 'string', text: value };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as { type?: unknown; value?: unknown };
    if (v.type === 'static' && typeof v.value === 'string') return { kind: 'static', text: v.value };
  }
  return null;
}

/** Write `text` back in the SAME shape it came from — never flatten an
 *  envelope to a bare string, which would be a silent format change. */
function withPresetText(original: unknown, text: string): unknown {
  const shape = editablePreset(original);
  return shape?.kind === 'static' ? { ...(original as object), value: text } : text;
}

export function Inspector() {
  const { t } = useTranslation('builder');
  const selectedNodeId = useBuilderStore((s) => s.selectedNodeId);
  const selectedNodeIds = useBuilderStore((s) => s.selectedNodeIds);
  const selectedEdgeId = useBuilderStore((s) => s.selectedEdgeId);
  const node = useBuilderStore((s) => s.nodes.find((n) => n.id === selectedNodeId) ?? null);
  const edge = useBuilderStore((s) => s.edges.find((e) => e.id === selectedEdgeId) ?? null);
  // Ports on THIS node that an incoming edge feeds — the only ports where a
  // preset value actually overrides something. Measured across the shipped
  // corpus, zero of 187 preset nodes currently have such a collision, so a
  // blanket "this overrides your edge" warning would fire on every node and be
  // right on none. A caution that is never true is training to ignore cautions.
  //
  // Select the STABLE edges array and derive in a memo. Building the Set inside
  // the selector returns a fresh reference every render, so zustand's equality
  // check never matches and the component re-renders forever ("Maximum update
  // depth exceeded"). Caught by the tests added with this section.
  const allEdges = useBuilderStore((s) => s.edges);
  const fedPorts = useMemo(
    () => new Set(allEdges.filter((e) => e.target === selectedNodeId).map((e) => e.targetPort)),
    [allEdges, selectedNodeId],
  );
  const advertised = useHostAdvertisedModelCapabilities();

  if (edge) return <EdgeInspector edge={edge} />;
  // More than one node selected → group actions (single-node config is
  // ambiguous across heterogeneous kinds, so we expose batch ops instead).
  if (selectedNodeIds.length > 1) return <MultiSelectInspector ids={selectedNodeIds} />;
  if (!node) return <WorkflowInspector />;
  const entry = catalogEntry(node.kind);
  if (!entry) {
    return (
      <aside className="builder-inspector">
        <div role="alert" className="alert error">{t('unknownNodeKind', { kind: node.kind })}</div>
      </aside>
    );
  }
  const missing = entry.missingHostSurfaces ?? [];
  // RFC 0031 gap: what does this node need that the host's modelCapabilities
  // advertisement doesn't (yet) cover?
  const requiredCaps = entry.requiredModelCapabilities ?? [];
  const missingModelCaps = advertised
    ? requiredCaps.filter((c) => !advertised.has(c))
    : [];
  return (
    <aside className="builder-inspector">
      <h3 className="builder-inspector-title">{entry.label}</h3>
      <p className="muted builder-inspector-desc">{entry.description}</p>

      {/* Type is read-only plumbing — a quiet metadata line under the title (the
          editorial mono-uppercase register), not a prominent stacked field. */}
      <div className="builder-inspector-meta">
        <span>{t('fieldType')}</span>
        <code>{entry.typeId}</code>
      </div>

      {/* Day-1 UX P9 (B4) — a node that names a connection gets an IN-PLACE
          consent launch (same beginOAuth the Access hub uses) instead of a
          navigate-away; a host that can't run the consent (no OAuth client)
          errors into a toast pointing at Access & connections. */}
      {typeof node.config['connectionRef'] === 'string' && node.config['connectionRef'] ? (
        <div className="builder-inspector-meta action-bar u-justify-between">
          <code>{String(node.config['connectionRef']).split('.').pop()}</code>
          <Button
            variant="secondary"
            onClick={() => {
              const ref = String(node.config['connectionRef']);
              const providerId = ref.split('.').pop() ?? ref;
              void beginOAuth(providerId, window.location.pathname)
                .then((url) => { window.location.href = url; })
                .catch(() => toast.error(t('inspectorConnectError')));
            }}
          >
            {t('inspectorConnectCta')}
          </Button>
        </div>
      ) : null}

      {missing.length > 0 ? (
        <div
          className="alert warning builder-inspector-host-warn"
          role="status"
          aria-label={t('hostCapabilityMissingAria')}
        >
          <strong>{t('needsHostCapability')}</strong> {missing.join(', ')}.
          <div className="muted builder-inspector-help u-mt-1">
            {t('hostCapabilityHelp')}
            <code> HOST_CAPABILITY_MISSING</code>{t('hostCapabilityHelpAfter')}{' '}
            <code>examples/hosts/postgres</code> {t('hostCapabilityHelpExample')}
          </div>
          {/* ADR 0163 Phase 5 — "invitation, not failure": link to set it up. */}
          <div className="u-mt-2">
            <Link to="/connections" className="linklike">{t('configureConnectionsCta')}</Link>
          </div>
        </div>
      ) : null}

      {requiredCaps.length > 0 ? (
        missingModelCaps.length > 0 ? (
          // A real gap — the host doesn't advertise a capability this node needs.
          // Keep the bordered alert; this one warrants attention.
          <div
            className="alert warning"
            role="status"
            aria-label={t('modelCapabilityRequirementsAria')}
          >
            <strong>{t('requiresModelCapabilities')}</strong>{' '}
            {requiredCaps.map((c, i) => (
              <span key={c}>
                <code className={missingModelCaps.includes(c) ? 'builder-inspector-cap-missing' : undefined}>{c}</code>
                {i < requiredCaps.length - 1 ? ' · ' : ''}
              </span>
            ))}
            .
            <div className="muted builder-inspector-help u-mt-1">
              {t('modelCapabilitiesGapPre')} <code>modelCapabilities.advertised[]</code> {t('modelCapabilitiesGapMid')}{' '}
              <code>{missingModelCaps.join(', ')}</code>{t('modelCapabilitiesGapPost')}
              {' '}(<code>model.capability.substituted</code>) {t('modelCapabilitiesGapOr')}
              <code> capability_not_provided</code>.
            </div>
          </div>
        ) : (
          // Happy path (covered) or still discovering — a quiet, non-actionable
          // confirmation line, NOT a full alert box that out-shouts the config.
          <p className="builder-inspector-cap-ok" role="status" aria-label={t('modelCapabilityRequirementsAria')}>
            {advertised === null ? (
              <span>{t('discoveringModelCapabilitiesPre')} <code>modelCapabilities</code> {t('discoveringModelCapabilitiesPost')}</span>
            ) : (
              <>
                <CheckIcon size={13} aria-hidden />
                <span><code>{requiredCaps.join(', ')}</code> {t('modelCapsCoveredNote')}</span>
              </>
            )}
          </p>
        )
      ) : null}

      <TextField
        label={t('fieldName')}
        value={node.name}
        onChange={(e) => useBuilderStore.getState().updateNode(node.id, { name: e.target.value })}
      />

      {entry.configFields.length > 0 && (
        <>
          <div className="builder-inspector-divider" />
          <div className="builder-inspector-section-label">{t('configuration')}</div>
          {entry.configFields.map((f) => (
            <ConfigInput
              key={f.key}
              nodeId={node.id}
              config={node.config}
              field={f}
              allFields={entry.configFields}
            />
          ))}
        </>
      )}

      {/* Preset inputs — READ-ONLY. These determine what the node actually sends
          (an email's `to`, a notification's `title`) and were previously both
          invisible AND deleted on every save, so nothing in the app could audit
          them. Not "Pinned" — ADR 0475's debug pins own that word and render in
          this same panel a few sections below. */}
      {node.inputs && Object.keys(node.inputs).length > 0 && (
        <>
          <div className="builder-inspector-divider" />
          <div className="builder-inspector-section-label" id="binspector-preset-inputs-label">
            {t('presetInputs')}
          </div>
          <p className="muted binspector-preset-inputs-note" id="binspector-preset-inputs-note">
            {t('presetInputsNote')}
          </p>
          <dl
            className="binspector-pinned-inputs"
            aria-labelledby="binspector-preset-inputs-label"
            aria-describedby="binspector-preset-inputs-note"
          >
            {Object.entries(node.inputs).map(([port, value]) => {
              const overridesEdge = fedPorts.has(port);
              const editable = editablePreset(value);
              const setPreset = (next: Record<string, unknown> | undefined) =>
                useBuilderStore.getState().updateNode(node.id, { inputs: next });
              return (
                <div key={port} className="binspector-pinned-input-row">
                  <dt>{port}</dt>
                  <dd>
                    {editable ? (
                      <div className="binspector-preset-edit">
                        <TextField
                          // The visible label is the <dt> beside it, so the
                          // field's own label is visually hidden rather than
                          // absent — a text box whose only name is a sibling
                          // <dt> has no accessible name at all.
                          label={<span className="sr-only">{t('presetInputValueLabel', { port })}</span>}
                          value={editable.text}
                          onChange={(e) =>
                            setPreset({
                              ...node.inputs,
                              [port]: withPresetText(value, e.target.value),
                            })
                          }
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          // The whole reason Phase E0 + the revision stamp
                          // exist: clearing the LAST preset input is a real
                          // authoring choice, and neither the server guard nor a
                          // later repair may undo it.
                          onClick={() => {
                            const { [port]: _removed, ...rest } = node.inputs ?? {};
                            setPreset(Object.keys(rest).length > 0 ? rest : {});
                          }}
                        >
                          {t('presetInputClear')}
                        </Button>
                      </div>
                    ) : (
                      <>
                        {readablePortValue(value) ?? <em>{t('presetInputEmpty')}</em>}
                        {' '}
                        <span className="muted binspector-preset-locked">
                          {t('presetInputNotEditable')}
                        </span>
                      </>
                    )}
                    {overridesEdge && (
                      <span className="binspector-preset-override">{t('presetInputOverrides')}</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </>
      )}

      <div className="builder-inspector-divider" />
      <div className="builder-inspector-section-label">{t('outputRole')}</div>
      <SelectField
        label={t('outputRoleArtifact')}
        value={node.outputRole ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          useBuilderStore.getState().updateNode(node.id, {
            outputRole: v === 'primary' || v === 'secondary' ? v : undefined,
          });
        }}
        title={t('outputRoleTitle')}
      >
        <option value="">{t('outputRoleNone')}</option>
        <option value="primary">{t('outputRolePrimary')}</option>
        <option value="secondary">{t('outputRoleSecondary')}</option>
      </SelectField>
      <p className="muted binspector-output-role-note">
        {t('outputRoleNote')}
      </p>

      {/* Keyboard edge management — the accessible alternative to the
          pointer-only canvas connect gesture (DESIGN.md §11 / BLD-1). Keyed by
          node id so picker state resets when the selection moves. */}
      <NodeConnections key={node.id} node={node} />

      {/* ADR 0475 — pin this node's output / execute-from-step. Keyed by node
          id so the pin editor resets when the selection moves. */}
      <NodeDebugSection key={`debug-${node.id}`} nodeId={node.id} />

      <div className="builder-inspector-divider" />
      <Button
        variant="secondary"
        onClick={() => useBuilderStore.getState().removeNode(node.id)}
      >
        {t('deleteNode')}
      </Button>
    </aside>
  );
}
