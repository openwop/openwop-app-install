/**
 * Template pre-flight mapping (day-1 UX P3 / B1) — chainParamsToVariables is
 * the seam between a chain pack's JSON-Schema `parameters` and the shared
 * RunVariable shape the ONE run-input renderer (ui/RunInputsForm) consumes.
 */
import { describe, expect, it } from 'vitest';

import { chainParamsToVariables, featureRequirementRows } from '../TemplatePreflightModal.js';
import { runsWithZeroConnections } from '../persistence/backendStore.js';
import { collectConnectionRefs } from '../builderShellHelpers.js';

describe('chainParamsToVariables', () => {
  it('maps properties + required[] + defaults to RunVariable[]', () => {
    const vars = chainParamsToVariables({
      type: 'object',
      required: ['attendeeCompanyId'],
      properties: {
        attendeeCompanyId: { type: 'string', description: 'The CRM company id.' },
        meetingContext: { type: 'string', default: '' },
        maxEvents: { type: 'integer', default: 5 },
      },
    });

    expect(vars).toEqual([
      { name: 'attendeeCompanyId', type: 'string', description: 'The CRM company id.', required: true },
      { name: 'meetingContext', type: 'string', required: false, defaultValue: '' },
      { name: 'maxEvents', type: 'integer', required: false, defaultValue: 5 },
    ]);
  });

  it('tolerates absent/empty parameters (zero-input template)', () => {
    expect(chainParamsToVariables(undefined)).toEqual([]);
    expect(chainParamsToVariables({})).toEqual([]);
  });
});

// Day-1 UX P6 — the "Start here" predicate: only a host-DERIVED empty
// requirements block qualifies; absence (older backend) must read false.

describe('runsWithZeroConnections', () => {
  const base = { chainId: 'c', packName: 'p', label: 'L', description: 'd' };
  it('true only for a derived-empty requirements block', () => {
    expect(runsWithZeroConnections({ ...base, requirements: { missingNodeTypeIds: [], connections: [] } })).toBe(true);
  });
  it('false when requirements are absent (older backend — never overpromise)', () => {
    expect(runsWithZeroConnections({ ...base })).toBe(false);
  });
  it('false when a connection or missing node is required', () => {
    expect(runsWithZeroConnections({ ...base, requirements: { missingNodeTypeIds: [], connections: [{ ref: 'r', providerId: 'x', providerInstalled: true }] } })).toBe(false);
    expect(runsWithZeroConnections({ ...base, requirements: { missingNodeTypeIds: ['t'], connections: [] } })).toBe(false);
  });
});

// ADR 0191 Phase 2 — join host-derived required (toggle-gated) features against
// the caller's resolved assignments so a disabled one reads "not enabled".
describe('featureRequirementRows', () => {
  const enabled = new Set(['crm']);
  const enabledOf = (id: string): boolean => enabled.has(id);

  it('marks each required feature enabled/disabled from the caller assignments', () => {
    const rows = featureRequirementRows(
      [{ id: 'crm', label: 'CRM' }, { id: 'analytics', label: 'Analytics' }],
      enabledOf,
    );
    expect(rows).toEqual([
      { id: 'crm', label: 'CRM', enabled: true },
      { id: 'analytics', label: 'Analytics', enabled: false },
    ]);
  });

  it('is empty when the host derived no required features (or an older backend omits it)', () => {
    expect(featureRequirementRows([], enabledOf)).toEqual([]);
    expect(featureRequirementRows(undefined, enabledOf)).toEqual([]);
  });
});

// Day-1 UX P9 — the Run-gate connection collector: distinct refs only,
// provider id = final dot segment, non-string/empty refs ignored.
describe('collectConnectionRefs', () => {
  it('collects + dedupes refs and derives provider ids', () => {
    expect(collectConnectionRefs([
      { config: { connectionRef: 'core.openwop.connections.microsoft365' } },
      { config: { connectionRef: 'core.openwop.connections.microsoft365' } },
      { config: { connectionRef: 'servicenow' } },
      { config: {} },
      {},
    ])).toEqual([
      { ref: 'core.openwop.connections.microsoft365', providerId: 'microsoft365' },
      { ref: 'servicenow', providerId: 'servicenow' },
    ]);
  });
});
