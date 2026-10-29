/** ADR 0957 P1b: freeze calendar dates at run insertion, before dispatch can
 * cross a month/week boundary. Uses ADR 0099's pure contributor seam. A fork
 * copies this decision (including absence), never today's calendar window.
 * This stamp grants no authority; the effect surface still binds the client.
 */
import type { RunStartContext } from '../../../host/runStartContext.js';
import { hostExtStorage } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { getDefinition, resolvePeriod } from './reportService.js';
import { CLIENT_REPORT_CHAIN_ID } from './types.js';

export const CLIENT_REPORT_PERIOD_KEY = 'openwop-app.clientReportPeriod';
const CLIENT_STAMP = 'openwop-app.campaignOps';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export async function clientReportPeriodContributor(ctx: RunStartContext): Promise<Record<string, unknown>> {
  if (ctx.derivedFromRun || ctx.parentRunId || ctx.workflowId !== CLIENT_REPORT_CHAIN_ID
    || ctx.metadata?.[CLIENT_REPORT_PERIOD_KEY] !== undefined) return {};
  const pin = ctx.metadata?.[CLIENT_STAMP];
  if (!object(pin) || typeof pin.orgId !== 'string' || typeof pin.definitionId !== 'string'
    || !Number.isSafeInteger(pin.definitionVersion)) return {};
  const definition = await getDefinition(ctx.tenantId, pin.orgId, pin.definitionId);
  if (!definition || definition.version !== pin.definitionVersion) return {};
  const period = resolvePeriod(definition.period.kind, { start: pin.periodStart, end: pin.periodEnd });
  return { [CLIENT_REPORT_PERIOD_KEY]: {
    version: 1, orgId: pin.orgId, definitionId: pin.definitionId,
    definitionVersion: definition.version, ...period,
  } };
}

/** Missing/failed start resolution is not permission to choose a later period. */
export async function readClientReportPeriod(
  tenantId: string, runId: string | undefined,
  pin: { orgId: string; definitionId: string; definitionVersion: number },
): Promise<{ periodStart: string; periodEnd: string }> {
  const refuse = (): never => { throw new OpenwopError('conflict',
    'This report run has no valid frozen reporting period. Start a new report.', 409,
    { reason: 'report_period_unbound' }); };
  if (!runId) return refuse();
  const run = await hostExtStorage().getRun(runId);
  if (!run || run.tenantId !== tenantId) return refuse();
  const period = (run.metadata as Record<string, unknown> | undefined)?.[CLIENT_REPORT_PERIOD_KEY];
  if (!object(period) || period.version !== 1 || period.orgId !== pin.orgId
    || period.definitionId !== pin.definitionId || period.definitionVersion !== pin.definitionVersion) return refuse();
  return resolvePeriod('custom', { start: period.periodStart, end: period.periodEnd });
}
