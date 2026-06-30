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

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useBuilderStore } from '../store/builderStore.js';
import { catalogEntry } from '../palette/catalogRegistry.js';
import { ConfigInput } from './ConfigInput.js';
import { EdgeInspector } from './EdgeInspector.js';
import { MultiSelectInspector } from './MultiSelectInspector.js';
import { WorkflowInspector } from './WorkflowInspector.js';
import { useHostAdvertisedModelCapabilities } from './inspectorHelpers.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { CheckIcon } from '../../ui/icons/index.js';

export function Inspector() {
  const { t } = useTranslation('builder');
  const selectedNodeId = useBuilderStore((s) => s.selectedNodeId);
  const selectedNodeIds = useBuilderStore((s) => s.selectedNodeIds);
  const selectedEdgeId = useBuilderStore((s) => s.selectedEdgeId);
  const node = useBuilderStore((s) => s.nodes.find((n) => n.id === selectedNodeId) ?? null);
  const edge = useBuilderStore((s) => s.edges.find((e) => e.id === selectedEdgeId) ?? null);
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
        <div className="alert error">{t('unknownNodeKind', { kind: node.kind })}</div>
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

      <div className="builder-inspector-divider" />
      <button
        className="secondary"
        onClick={() => useBuilderStore.getState().removeNode(node.id)}
      >
        {t('deleteNode')}
      </button>
    </aside>
  );
}
