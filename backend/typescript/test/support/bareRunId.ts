/**
 * ADR 0812 P2b — the major-2 wire binds a run id to its tenant
 * (`<tenantId>/<opaque>`, `identity.md` §5), while host-extension routes
 * (`/host/openwop-app/*`) and storage key a run by the bare opaque id. A test
 * that creates a run on the protocol surface and then reads it through either
 * crosses that boundary here, the way the SPA does (`client/v2Wire.ts`
 * `fromWireRunId`): the protocol keeps the bound id, the host lane gets the
 * bare one. Unbinding at create time instead would put bare ids back on
 * protocol paths, which a host that has retired 1.x refuses with 400.
 *
 * A bare id passes through, so a helper call is safe on either spelling.
 */
export function bareRunId(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash < 0 ? id : id.slice(slash + 1);
}
