/**
 * Conformance harness — boots the sample backend in-process and runs
 * `@openwop/openwop-conformance` against it.
 *
 * Usage:
 *   npm run test:conformance           # boots in-process, runs full suite
 *   npm run test:conformance -- --filter discovery   # subset
 *
 * Exit code is the conformance CLI's exit code. CI gates on this.
 *
 * Honest expectations: this sample stubs more than the postgres
 * reference host (no Ed25519 audit chain, no durable webhook queue,
 * no production-profile claim). The pass-matrix in the README
 * documents which scenarios skip-equivalent and why.
 */

import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
// `../src/index.js` is imported DYNAMICALLY, inside main(), after the pack dir
// is chosen — see the "Pack determinism" block there. It cannot be a static
// import: `bootstrap/nodePackResolver.ts:24` and `bootstrap/agentPackResolver.ts:24`
// both do `const PACK_DIR = resolveDefaultPackDir()` at MODULE SCOPE, so a
// static import here freezes the pack dir at import time and any later
// `process.env.OPENWOP_PACK_DIR` assignment is silently ignored.
//
// That is not theoretical — it is how the first version of this fix failed:
// the mount log said "mounted 208 vendored pack(s)" while the resolver went on
// reading the ambient `~/.openwop-packs`, and 10 files stayed red. The log was
// telling the truth about the mount and nothing about what got used.
// (`test/setup/isolatePackDir.ts` avoids the same trap only because vitest
// `setupFiles` run before the test's imports.)
import type { Storage } from '../src/storage/storage.js'; // type-only — erased, no runtime import
import { conformanceTagFor, decideConformanceRoot, describeConformanceRoot } from './conformanceRoot.js';
// TYPE-ONLY (erased). The value import is dynamic inside `emitCertification`,
// because `./certify.js` pulls in `@openwop/openwop-conformance` — a
// devDependency — and a static import would make the whole harness unloadable
// wherever the suite is absent, for a path most runs never take.
import type * as certifyModule from './certify.js';
import { CONFORMANCE_BIND_HOST, CONFORMANCE_PORT_ENV, selectConformancePort } from './port.js';
import { declaredRecoveryBoundMs, recoveryBoundTerms } from '../src/host/recoveryBound.js';
import { MAJOR2_UNDECLARED_FAMILIES } from './major2Ledger.js';

// The host's listen port is NOT a module constant (H17). It was `18080`, and
// `scripts/ci.sh` runs this lane inside `npm run ci` — so two worktrees on one
// machine collided on the socket and the loser's merge gate died with
// `EADDRINUSE`, which reads like a real break. `main()` decides it via
// `selectConformancePort` (pin with OPENWOP_CONFORMANCE_PORT, else scan up from
// 18080) and everything derived from it — `process.env.PORT`, `app.listen`,
// `BASE_URL`, and therefore the `OPENWOP_BASE_URL` handed to the suite — follows
// from that ONE decision.
const API_KEY = process.env.OPENWOP_CONFORMANCE_API_KEY ?? 'sample-conformance-token';
/** ADR 0553 P3 (H53) — the SECOND caller for RFC 0153 §D's cross-caller cache
 *  leg. Module scope because both halves need it: the host's key table below and
 *  the suite child's env far down the file. */
const SECONDARY_API_KEY = `${API_KEY}-secondary`;
/** ADR 0745 D3 — a caller in a DIFFERENT tenant from every run the primary key
 *  creates, for the suite's non-disclosure legs (`auth-challenge-no-oracle`'s
 *  cross-tenant read, the isolation blackbox). An env key pinned to one tenant:
 *  the primary key is the `*` operator, so its runs land outside this tenant. */
const TENANT_B_API_KEY = `${API_KEY}-tenant-b`;
const TENANT_B = 'conformance-tenant-b';

/**
 * The honest advertise-or-opt-out ledger (ADR 0550).
 *
 * MODULE SCOPE so BOTH boots share ONE list: the in-process host below and
 * the external-target path (a running release container, ADR 0550 P2).
 * Duplicating it would create two honesty ledgers that drift — precisely what
 * this list exists to prevent. An entry here says "we do not claim this
 * capability"; it is a TODO ledger, never a licence to ignore the surface.
 */
function major2UndeclaredFamilies(): string[] { return process.env.OPENWOP_TARGET_MAJOR === '2' ? MAJOR2_UNDECLARED_FAMILIES : []; }

const OPTED_OUT_PROFILES = [
    'openwop-production', // no production capability family in src/
    'openwop-auth-oauth2-client-credentials', // advertisedAuthProfiles() only serves saml/scim
    'openwop-auth-api-key-rotation', // no rotation/grace mechanism (middleware/auth.ts is static keys)
    'openwop-auth-mtls', // no mTLS implementation
    // (openwop-auth-oidc-user-bearer REMOVED from this ledger: advertised via
    //  auth.profiles + auth.oidc when OPENWOP_OIDC_* is set — which this boot
    //  sets above, pointed at the suite's synthetic issuer.)
    'openwop-discovery-auth-scoped', // no discovery.authScoped family
    'openwop-audit-log-integrity', // no hash-chain / GET /v1/audit/verify
    // (openwop-safefetch-live-audit REMOVED: httpClient.safeFetch is now
    //  advertised and ctx.http.safeFetch emits the durable content-free
    //  agent.toolCalled/toolReturned pair per invocation — host/
    //  connectionInjection.ts; exercised via the safe-fetch(-run) seams.)
    'openwop-chat-card-packs', // no cardPacks surface
    // (openwop-memory-degraded REMOVED 2026-08-17, H51. The removal condition it
    //  carried was "implement the RFC 0080 §C projection, then flip
    //  memory.supported", and both landed: `host/memoryDimensions.ts` derives the
    //  §A dimension model from the advertisement it also builds, and
    //  `routes/agents.ts toEntry`/`userRecordToEntry` stamp
    //  `memoryDegraded`/`degradedMemoryDimensions` on `GET /v1/agents`. The
    //  scenario now EXECUTES here rather than being declared away.
    //
    //  It exercises the §C-1 NON-degraded direction on this lane, non-vacuously:
    //  `OPENWOP_SURFACE_MEMORY=durable` below satisfies `long-term-durability`,
    //  so the seeded `memoryShape.longTerm` agents (host/advisoryBoardSeed.ts,
    //  host/workforceEval.ts) are correctly NOT stamped. That is the direction
    //  RFC 0080's amended acceptance criterion asks a host to prove.
    //
    //  `OPENWOP_DEGRADED_AGENT_ID` is deliberately NOT set. It names an agent the
    //  scenario then REQUIRES to be degraded — and on the durable tier no agent
    //  honestly is, so naming one would either hard-fail the leg or force a
    //  fabricated degraded agent. The degraded-STAMP direction is proven instead
    //  at the host boundary, against this host's DEFAULT (non-durable) tier where
    //  it is genuinely true: `test/memory-degraded-projection-route.test.ts`.)
    'openwop-live-structured-output', // no agents.liveRuntime
    'openwop-live-invocation-bracket', // no agents.liveRuntime
    'openwop-live-allowlist-enforced', // no agents.liveRuntime
    'openwop-grpc-transport', // no gRPC transport
    'openwop-eval-run', // only x-host-openwop-workforce.eval; normative agents.evalSuite deliberately not claimed
    'openwop-egress-decision-content-free', // httpClient IS advertised now, but egressPolicy.supported would claim RFC 0079 `egress.decided` emission — the host binds credentials in substance (apiHosts match + redirect:error) yet emits no decision events, so the sub-block stays honestly absent
    'openwop-egress-audience-binding', // same — the RFC 0079 decision-event surface is the unimplemented half
    'openwop-deployment-lifecycle', // no agents.deployment
    'openwop-deployment-channel-dispatch', // no agents.deployment
    'openwop-context-summarization', // no multiAgent contextBudget sub-block
    'openwop-context-budget', // same
    'openwop-budget-enforcement', // workflowBudgets.ts is internal, no budget capability family
    'openwop-agent-platform', // no root-level profiles[] claim
    'openwop-tool-session-lifecycle', // toolCatalog.sessionLifecycle never emitted
    'openwop-verifier-gating', // RFC 0090 phase 6 exists behind OPENWOP_AGENT_VERIFIER_GATING but advertises executionModel version 6, outside the corpus schema's 1-5 ladder — advertise only when the corpus ladder admits v6
    'openwop-subscription-auth', // mechanism exists but honoring it needs a real subscription credential this boot does not have
    'openwop-voice-transcription-unadvertised', // inverted gate: this host DOES advertise streaming transcription, so the unadvertised-behavior scenario cannot apply
    'openwop-speech-synthesis-unadvertised', // inverted gate: speechSynthesis:'supported' is unconditional (discovery.ts:584)
    // ── Added at the 1.73.0 -> 1.106.0 bump. Each is an HONEST non-claim with a
    //    named removal condition, not a way to make a red go away. The rule the
    //    steward put on this: "I would rather you found it needs work than
    //    declared it opted-out to get green."
    // (openwop-workload-identity + openwop-workload-identity-delegation REMOVED
    //  2026-08-16, ADR 0556 P3. The removal condition these two carried was "a
    //  host-side resolver + capability advertisement land", and both did:
    //  `host/workloadIdentity.ts` resolves verify→bind→audience→chain→principal
    //  fail-closed, `middleware/workloadIdentity.ts` binds it to the request,
    //  the §20 seam drives that same resolver, and `routes/discovery.ts`
    //  advertises `auth.workloadIdentity` DERIVED from the configured trust
    //  roots. The boot below configures those roots, so the behavioural legs
    //  execute here rather than resolving to `blocked`.)
    // (openwop-compensation REMOVED 2026-08-16, ADR 0554 wire flip. Its removal
    //  condition was stated in full and has been met: the PAIR
    //  `capabilities.compensation` + `compensationStatus` on `RunSnapshot` both
    //  ship, from ONE constant (`host/compensationCapability.ts`), and
    //  `compensation-behavior.test.ts` runs green under this boot with
    //  OPENWOP_TEST_SEAM_ENABLED=true. The removal is not optional cleanup:
    //  `behaviorGate` THROWS on a profile that is both advertised and opted out
    //  — "the two are contradictory claims and neither can be trusted while both
    //  stand" — so the advert and this line could never have moved separately.)
] as const;

/**
 * Where the harness's own TEST DOUBLES listen, and what address the host under
 * test should use to reach them.
 *
 * CORRECTION to the rule stated in `runAgainstExternalTarget` below. That rule —
 * "everything the harness does to simulate `main()` is skipped when a real
 * `main()` is on the other end" — is right about the pack mount and the webhook
 * drain, and WRONG about the mocks. The compat provider and OIDC issuer are not
 * entry-point simulation; they are doubles the SUITE provides, and they are
 * needed in both modes. Skipping them was why the container lane could not
 * witness any callback-shaped scenario.
 *
 * In-process, `127.0.0.1` serves both roles. Once the host is a container,
 * `127.0.0.1` names the container itself, so the double must bind `0.0.0.0` and
 * advertise a name the container can resolve. MEASURED 2026-08-13 on this box:
 * a container reached a host-bound server via
 * `--add-host host.docker.internal:host-gateway` (probe returned
 * `reached-the-harness`). The override exists because that name is a Docker
 * convention, not a guarantee — a different runtime gets a different address
 * without a code change.
 */
function mockBinding(externalTarget: string | undefined): { bind: string; advertise: string } {
  if (!externalTarget) return { bind: '127.0.0.1', advertise: '127.0.0.1' };
  return {
    bind: '0.0.0.0',
    advertise: process.env.OPENWOP_CONFORMANCE_HARNESS_HOST ?? 'host.docker.internal',
  };
}

/**
 * A caller-PINNED port, or 0 to let the OS choose.
 *
 * The container lane must pin them. Its ordering forces it: `docker run` happens
 * before the suite starts, so the host's env — which is where
 * OPENWOP_TEST_COMPAT_ENDPOINT and OPENWOP_OIDC_ISSUER have to land — is fixed
 * at a moment when an OS-chosen port does not exist yet. The wrapper therefore
 * reserves both ports first and tells BOTH sides the same numbers.
 *
 * This is the concrete form of the three "must agree" vars in the env partition
 * (ADR 0550 P2): the first implementation set them for the DRIVER only, the host
 * never learned where to dispatch, and the three callback scenarios stayed red
 * while looking like host defects.
 */
function pinnedPort(name: string): number {
  const raw = process.env[name];
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`[conformance] ${name}=${raw} is not a valid port`);
  }
  return n;
}

/** The RFC 0108 compat-provider double. Returns the endpoint the HOST should
 *  call, which is not necessarily where it listens. */
async function startCompatMock(binding: { bind: string; advertise: string }, port = 0): Promise<string> {
  const compatMock = http.createServer((_q, s) => {
    s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'conformance-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\n');
    s.write('data: [DONE]\n\n');
    s.end();
  });
  await new Promise<void>((res) => compatMock.listen(port, binding.bind, () => res()));
  const bound = (compatMock.address() as AddressInfo).port;
  return `http://${binding.advertise}:${bound}/v1`;
}

/** Reserve a free port by binding and immediately releasing it. The caller
 *  hands the number to whoever will actually bind it. */
async function reservePort(bind: string): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((res) => probe.listen(0, bind, () => res()));
  const chosen = (probe.address() as AddressInfo).port;
  await new Promise<void>((res) => probe.close(() => res()));
  return chosen;
}

/** Reserve a port for the suite's synthetic OIDC issuer and return the URL the
 *  HOST must trust. The probe closes immediately — the suite binds it itself. */
async function reserveOidcIssuer(binding: { bind: string; advertise: string }, port = 0): Promise<string> {
  if (port) return `http://${binding.advertise}:${port}`; // pinned by the wrapper; nothing to probe
  return `http://${binding.advertise}:${await reservePort(binding.bind)}`;
}

/**
 * Full-catalog resolution. The PUBLISHED conformance package omits the
 * `spec/v1/*.md` prose (it's a test package, not the spec), so the
 * spec-corpus-validity scenarios under-register (~430 fewer cases) when the
 * suite resolves fixtures/schemas from node_modules — our Total reads ~1720 vs
 * the steward's repo-layout basis. Point OPENWOP_CONFORMANCE_ROOT at the
 * sibling `openwop` spec repo (the CLAUDE.md `../openwop` convention) when
 * present so the full corpus loads and the Total is apples-to-apples with the
 * steward (~2148 @ 1.29.0). An explicit override always wins; absent the
 * sibling we fall back to the vendored partial corpus with a loud note.
 *
 * Shared by both boots. NOTE for the external-target path: a release container
 * has no sibling spec repo above the package, so it runs the VENDORED corpus —
 * i.e. the npm TARBALL layout, which is a distinct hazard class (see ADR 0550
 * P2: six scenarios threw at import from the tarball in the steward's 1.9x line
 * because `spec/v1`, `RFCS` and `docs` do not sit above the package there).
 */
function resolveConformanceRoot(): void {
  const repoRoot = resolve(process.cwd(), '..', '..');
  const siblingSpecRepo = resolve(repoRoot, '..', 'openwop');
  const readVersion = (pkgJson: string): string | undefined => {
    try {
      const v: unknown = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: unknown }).version;
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const installedVersion = readVersion(resolve(process.cwd(), 'node_modules', '@openwop', 'openwop-conformance', 'package.json'));
  if (installedVersion === undefined) {
    throw new Error('[conformance] cannot read node_modules/@openwop/openwop-conformance/package.json — the suite is not installed');
  }
  const siblingHasFixtures = existsSync(resolve(siblingSpecRepo, 'conformance', 'fixtures'));
  const tag = conformanceTagFor(installedVersion);
  let siblingHasInstalledTag = false;
  if (siblingHasFixtures) {
    try {
      execFileSync('git', ['-C', siblingSpecRepo, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { stdio: 'pipe' });
      siblingHasInstalledTag = true;
    } catch {
      siblingHasInstalledTag = false;
    }
  }
  const decision = decideConformanceRoot({
    explicitRoot: process.env.OPENWOP_CONFORMANCE_ROOT,
    siblingRoot: siblingSpecRepo,
    siblingHasFixtures,
    siblingVersion: readVersion(resolve(siblingSpecRepo, 'conformance', 'package.json')),
    installedVersion,
    siblingHasInstalledTag,
  });
  if (decision.use === 'sibling') process.env.OPENWOP_CONFORMANCE_ROOT = decision.root;
  if (decision.use === 'sibling-tag') {
    process.env.OPENWOP_CONFORMANCE_ROOT = materializeCorpusAtTag(siblingSpecRepo, decision.tag, decision.version, readVersion);
  }
  // eslint-disable-next-line no-console
  (decision.use === 'vendored' ? console.warn : console.log)(describeConformanceRoot(decision));
}

/**
 * Export the sibling spec repo at `tag` into a per-version cache dir (repo
 * layout, so the suite's `paths.ts` resolves it exactly like a checkout).
 * Reused across runs when the cached `conformance/package.json` version still
 * matches; re-exported otherwise. Lives under the OS tmpdir on purpose — it is
 * a derived artifact of (sibling repo, tag), never a source.
 */
function materializeCorpusAtTag(
  siblingSpecRepo: string,
  tag: string,
  version: string,
  readVersion: (pkgJson: string) => string | undefined,
): string {
  const dir = join(tmpdir(), 'openwop-conformance-corpus', version);
  if (readVersion(join(dir, 'conformance', 'package.json')) === version && existsSync(join(dir, 'conformance', 'fixtures'))) {
    return dir;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = execFileSync('git', ['-C', siblingSpecRepo, 'archive', '--format=tar', tag], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  const got = readVersion(join(dir, 'conformance', 'package.json'));
  if (got !== version) {
    throw new Error(`[conformance] exported ${tag} but its conformance/package.json says ${got ?? '(unreadable)'}, expected ${version} — the tag does not name the version it claims`);
  }
  return dir;
}

/**
 * Measure an ALREADY-RUNNING host (ADR 0550 P2 Lane 2 — the release container)
 * instead of booting one in-process.
 *
 * THE RULE THIS FUNCTION ENCODES: everything the harness does to simulate
 * `main()` must be SKIPPED when a real `main()` is on the other end. The
 * in-process path below compensates twice for not being the entry point — it
 * mounts vendored packs (because `createApp` never fires
 * `ensureLocalPacksMounted()`) and it drives the webhook drain (because
 * `createApp` does not start the worker `index.ts` does). A container runs both
 * natively; doing them here as well would double-drive.
 *
 * It is NOT a second runner. `runSuite()` is shared, and the driver is already
 * origin-agnostic — only the ORIGIN differs.
 */
async function runAgainstExternalTarget(target: string): Promise<void> {
  // ── Guard: the driver must describe the CONTAINER, not this machine ────────
  //
  // Only three vars are visible to BOTH sides, and two of them the in-process
  // boot points at loopback mocks it starts itself (the compat mock and the
  // OIDC probe). `127.0.0.1` names a DIFFERENT host once the host under test is
  // a container, so carrying those through would aim the driver at a mock the
  // container cannot reach — and the scenarios would fail as if the host were
  // non-conformant. That is a measurement error wearing a conformance failure's
  // clothes, which is the exact confusion ADR 0550 P1's quarantine cost us.
  //
  // Deliberately NOT "fail if any host-side var is set": in this mode the
  // harness never applies host config, so a stray OPENWOP_GOALS_ENABLED in the
  // operator's shell is inert — it cannot reach the container and the driver
  // never reads it. A guard that fires there would be a false alarm. (Corrected
  // while implementing; the ADR carries the correction inline.)
  const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|\[?::1\]?|localhost)(:|\/|$)/i;
  const shared: Array<[string, string | undefined]> = [
    ['OPENWOP_TEST_COMPAT_ENDPOINT', process.env.OPENWOP_TEST_COMPAT_ENDPOINT],
    ['OPENWOP_TEST_OIDC_ISSUER_URL', process.env.OPENWOP_TEST_OIDC_ISSUER_URL],
  ];
  for (const [name, value] of shared) {
    if (value && LOOPBACK.test(value)) {
      throw new Error(
        `[conformance] ${name}=${value} is a LOOPBACK address, but the host under test is `
          + `external (${target}). The container cannot reach this machine's loopback, so every `
          + `scenario using it would fail as a false non-conformance. Point it at an address the `
          + `container can resolve, or unset it and opt the affected profiles out explicitly.`,
      );
    }
  }
  if (!process.env.OPENWOP_API_KEY) {
    throw new Error(
      '[conformance] OPENWOP_API_KEY must be set explicitly when targeting an external host — '
        + 'the container has its own key and the in-process default would not authenticate.',
    );
  }

  // ── The harness's own test doubles, reachable FROM the container ───────────
  //
  // These are not `main()` simulation — see `mockBinding()`. Without them no
  // callback-shaped scenario can be witnessed here, which is why the first full
  // container run produced 16 failures that were environment, not host defects.
  //
  // The guard above has already rejected an operator-supplied loopback value, so
  // anything still set is deliberate and container-reachable; only fill the gaps.
  const binding = mockBinding(target);
  const compatPort = pinnedPort('OPENWOP_CONFORMANCE_COMPAT_PORT');
  const oidcPort = pinnedPort('OPENWOP_CONFORMANCE_OIDC_PORT');
  // ALWAYS started, even when the endpoint var is already set: the wrapper sets
  // that var on the CONTAINER, and a double nobody is listening on is worse than
  // no double at all — the host would dispatch into a closed port.
  process.env.OPENWOP_TEST_COMPAT_ENDPOINT = await startCompatMock(binding, compatPort);
  process.env.OPENWOP_TEST_OIDC_ISSUER_URL = await reserveOidcIssuer(binding, oidcPort);
  // eslint-disable-next-line no-console
  console.log(
    `[conformance] harness doubles bound ${binding.bind}, advertised as ${binding.advertise} — `
      + `compat ${process.env.OPENWOP_TEST_COMPAT_ENDPOINT}, oidc ${process.env.OPENWOP_TEST_OIDC_ISSUER_URL}. `
      + 'The container must be run with --add-host host.docker.internal:host-gateway (or set '
      + 'OPENWOP_CONFORMANCE_HARNESS_HOST) or every callback-shaped scenario fails as false non-conformance.',
  );

  // ── Driver-side env only. The container owns its own host configuration. ───
  process.env.OPENWOP_REQUIRE_BEHAVIOR = 'true';
  // The release artifact does NOT ship @openwop/openwop-conformance (it is a
  // devDependency; the runtime stage is `npm ci --omit=dev`), so the host cannot
  // resolve the host-expansion seam's fixture manifest and correctly advertises
  // nothing. behaviorGate THROWS on a profile that is neither advertised nor
  // opted out, so the honest disposition has to be declared here — ADR 0550
  // Lane 2's "opted-out profiles are recorded as not claimed, never pass".
  //
  // Container-lane ONLY. In-process the host DOES serve it, and behavior-gate.ts
  // throws on a profile that is BOTH advertised and opted out — so adding this
  // to the shared list would break the source lane.
  process.env.OPENWOP_OPTED_OUT_PROFILES = [
    ...OPTED_OUT_PROFILES,
    'workflowChainPacks.hostExpansionSeam',
  ].join(',');
  resolveConformanceRoot();

  // eslint-disable-next-line no-console
  console.log(`[conformance] EXTERNAL TARGET ${target} — no in-process boot, no pack mount, no webhook drain (the host runs its own main()).`);
  await runSuite(target);
}

async function main(): Promise<void> {
  const externalTarget = process.env.OPENWOP_CONFORMANCE_TARGET_URL?.trim();
  if (externalTarget) {
    await runAgainstExternalTarget(externalTarget);
    return;
  }
  // Boot in-process with a FRESH sqlite FILE per run — clean slate per process
  // (a new temp directory every time), and DURABLE, which `memory://` is not.
  //
  // ADR 0551 P2 made the RFC 0059 workspace advertisement conditional on the
  // selected storage adapter outliving its process, because
  // `spec/v1/agent-workspace.md` §9 makes the workspace snapshot a cross-host
  // replay guarantee. On `memory://` the capability is therefore absent — and
  // with `OPENWOP_REQUIRE_BEHAVIOR=true` the 8 shipped workspace scenarios
  // (two of them witnessing the protocol-tier `workspace-cross-tenant-isolation`
  // invariant) would have gone from EXECUTING to skipping. ADR 0550 P1
  // established that skipped is not passed, so trading them for the gate would
  // have been a coverage loss disguised as a green run.
  //
  // A temp file is the honest fix rather than a workaround: the suite now
  // exercises the host on a profile where the advert is TRUE, which is what a
  // conformance run is supposed to measure. Everything else is unchanged — the
  // same sqlite backend answers both DSNs (`memory://` resolves to `:memory:`),
  // so this is a storage LOCATION change, not a backend change.
  const dbDir = mkdtempSync(join(tmpdir(), 'openwop-conformance-db-'));
  process.env.OPENWOP_STORAGE_DSN = `sqlite://${join(dbDir, 'conformance.db')}`;
  process.on('exit', () => { try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  // ── The listen port (H17) — decided ONCE, logged ONCE, derived everywhere ──
  const selectedPort = await selectConformancePort({ pinned: process.env[CONFORMANCE_PORT_ENV] });
  const PORT = selectedPort.port;
  const BASE_URL = `http://127.0.0.1:${PORT}`;
  // eslint-disable-next-line no-console
  console.log(`[conformance] host port ${PORT} (${selectedPort.note})`);
  process.env.PORT = String(PORT);
  process.env.OPENWOP_API_KEY = API_KEY;
  // ADR 0561 — the harness needs the CROSS-TENANT operator principal, and since
  // that is no longer what a bare key gets, it asks for it explicitly.
  //
  // Two scenarios prove it is load-bearing rather than ceremonial:
  // `artifact-type-registration-source` and `artifact-type-store-emission` both
  // read a run's event log over the standard poll endpoint, and both 404 without
  // it (`host/runAccess.ts` returns a run to a wildcard principal before the
  // ownership check). MEASURED: exactly 2 of 2565 assertions, no more.
  //
  // Set via OPENWOP_API_KEYS, NOT by suffixing OPENWOP_API_KEY — that variable is
  // handed to the suite process below as the client's Bearer token, and a
  // `:*`-suffixed token would not authenticate against anything.
  //
  // ADR 0553 P3 (H53) — a SECOND, TENANT-SCOPED key, so RFC 0153 §D's
  // cross-caller cache leg (`mcp-cache-tenant-scope`) can EXECUTE instead of
  // warning `OPENWOP_TEST_SECONDARY_API_KEY not set — cross-caller half not
  // exercised (blocked)`. Follows the H38 precedent: a second entry in the same
  // CSV, never a second auth mechanism.
  //
  // It is scoped to its OWN tenant (`:conformance-secondary`) and NOT `:*`, and
  // that is the whole point rather than caution — the leg asks whether a list
  // that DIFFERS between two callers is marked `private`. Two wildcard
  // operator keys are the same authorization context, would be served the same
  // `tools/list`, and the assertion would never fire: a leg that executes and
  // cannot fail is the vacuous green the RFC 0148 ledger exists to expose.
  process.env.OPENWOP_API_KEYS = `${API_KEY}:*,${SECONDARY_API_KEY}:conformance-secondary,${TENANT_B_API_KEY}:${TENANT_B}`;
  // Conformance-only env. Both flags are spec-aligned for a black-box
  // suite run; production deploys NEVER set these.
  // - RATELIMIT_DISABLED: the suite issues 1200+ requests in a short
  //   window. The sample's per-IP rate limiter (60 req/min default)
  //   would otherwise 429-cascade and mask real failures.
  // - AUTH_DISABLE_COOKIES: the suite asserts 401 on missing
  //   credentials per `auth.md §3`. Default behavior auto-issues an
  //   anon session cookie, which silently grants access and shifts
  //   the 401 to a 200/201.
  process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // Test seam needs enabling for envelope/accept, capability-toggle,
  // llm-prompt-wrap, and the variables mutation seam.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  // RFC 0004 long-term memory (H49). `capabilities.agents.memoryBackends:
  // ['long-term']` is DERIVED from the selected memory surface, because the §A
  // dimension means a cross-run DURABLE store and the default `memory` tier is
  // process-local. Selecting the durable tier here is what EARNS the advert for
  // this lane rather than asserting it: `host/durable/durableMemory.ts` over the
  // sqlite storage configured above, CAS-safe per scope. Without this the four
  // `agentMemory*` scenarios would keep skipping on `hasLongTermMemory()` — and
  // skipping them by leaving the tier non-durable, while the driver exists,
  // would be a host declining to be measured. `initInMemorySurfaces` fails fast
  // at boot if the adapter is unwired, so a typo cannot silently fall back to
  // the non-durable tier and quietly re-skip the scenarios.
  process.env.OPENWOP_SURFACE_MEMORY = 'durable';
  // RFC 0013 host-expansion witness seam — now SERVED. With OPENWOP_TEST_SEAM_ENABLED
  // this host both advertises `workflowChainPacks.hostExpansionSeam:true` and serves
  // `/v1/host/sample/workflow-chain:expand` (routes/workflowChainExpandSeam.ts),
  // resolving the published `vendor.openwop.workflow-chain-sample` fixture through
  // `expandChain()`. So the `workflow-chain-host-expansion` scenario (openwop-conformance
  // ≥1.52.0, which loads the fixture + checks against the reference expander) RUNS
  // non-vacuously — no opt-out needed. (Was opted out in #1289 while the fixture was
  // unpublished + the seam unwired; #830 published it, this ships the seam.)

  // RFC 0108 / ADR 0121 — stand up a reachable mock compat (OpenAI-compatible)
  // endpoint so the `aiproviders-selfhosted-honesty` scenario is NON-VACUOUS: it
  // dispatches against the advertised `compat` id and asserts it reaches a real
  // endpoint (succeed OR transport-error, NOT capability_not_provided), and that
  // the endpoint URL never leaks (§D). The mock is loopback, so private egress is
  // allowed for this conformance run only. This is the host-witness step of the
  // RFC 0108 accept cycle; production NEVER sets these.
  const compatEndpoint = await startCompatMock(mockBinding(undefined));
  process.env.OPENWOP_COMPAT_PROVIDER_ENABLED = 'true';
  process.env.OPENWOP_TEST_COMPAT_ENDPOINT = compatEndpoint;
  // The compat mock is on loopback. It is reached through the webhook-family
  // egress dispatcher, so its exact origin joins OPENWOP_WEBHOOK_ALLOW_ORIGINS
  // (assembled below, once every harness double's port is known) — NOT the
  // blanket OPENWOP_WEBHOOK_ALLOW_PRIVATE this line used to set. See WHD-19.
  // ── REQUIRE_BEHAVIOR is a CLAIM, and only the certification lane makes it ──
  //
  // `behavior-gate.ts` states the contract: the DEFAULT skips a capability-gated
  // scenario the host does not advertise, "reflecting what the host has
  // implemented"; the flag "turn[s] missing advertisements into hard failures …
  // useful for hosts that want to claim FULL COVERAGE".
  //
  // Setting it unconditionally made every run assert "this host implements all
  // of v2". Nobody has started C.3 (identity) or C.6 (security defaults) here,
  // so that assertion was FALSE — and the merge gate then failed the host for
  // its own false claim. That is not strictness; a gate that cannot pass is a
  // blocked pipeline, and the standing temptation is to make it green the easy
  // way by quarantining the scenarios, which is excused evidence wearing a
  // gate's clothes.
  //
  // So the claim is made where it is actually published: the CERTIFICATION run,
  // whose bundle is the public statement. A plain run records `inapplicable`
  // for surfaces this host does not advertise — the honest disposition — while
  // every scenario for a surface it DOES advertise still runs and still must
  // pass. That is a real merge gate: it catches regressions in what exists.
  //
  // Ruled 2026-09-04 by the corpus steward, citing the flag's own contract;
  // `OPENWOP_OPTED_OUT_PROFILES` remains the way to declare a surface
  // deliberately not implemented.
  if (process.argv.slice(2).includes('--certify')) {
    process.env.OPENWOP_REQUIRE_BEHAVIOR = 'true';    // honesty gate (RFC 0108 flip pass)
  }

  // RFC 0137 form-content instantiation witness (openwop#885) — the seam
  // (routes/formContentSeam.ts) loads the conformance fixture TEMPLATES through
  // the real formContentPackLoader from this vendored root. Without it the seam
  // answers `template_not_registered` and both instantiation legs red under
  // REQUIRE_BEHAVIOR.
  if (!process.env.OPENWOP_FORM_CONTENT_CONFORMANCE_FIXTURES) {
    process.env.OPENWOP_FORM_CONTENT_CONFORMANCE_FIXTURES = resolve(
      process.cwd(),
      '..',
      '..',
      'conformance-fixtures',
      'form-content',
    );
  }

  // ── Behavior-gate posture (the honest advertise-or-opt-out ledger) ──────────
  //
  // OPENWOP_REQUIRE_BEHAVIOR=true (above) makes every capability-gated scenario
  // HARD-FAIL unless the host either advertises the profile or the operator
  // declares an opt-out. This host's optional capabilities are honest-off
  // (advertised only when their operator env is set), so a conformance boot must
  // take an explicit posture on each — silence produced 67 red gates.
  //
  // ENABLED — behavior genuinely implemented, self-contained under memory://
  // storage + the mock provider, so the scenario witnesses something real.
  // Never enable a flag here solely to turn a gate green (RFC 0142 §"acceptance
  // MUST NOT be manufactured"): each line names the implementing surface.
  process.env.OPENWOP_ANON_ACTOR_ENABLED = 'true'; // host/anonymousActor.ts — both tiers honored (read + hitl-gated bounded-write)
  process.env.OPENWOP_GOALS_ENABLED = 'true'; // features/goals — agents.goals surface
  process.env.OPENWOP_PROPOSALS_ENABLED = 'true'; // features/proposals — agents.proposals surface (ADR 0473)
  process.env.OPENWOP_PORTABILITY_ENABLED = 'true'; // features/portability — import/export
  process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED = 'true'; // features/channels — presence
  // host/i18n — locales the backend REALLY serves (errorMessages.ts pt-BR + es
  // catalog; es-419 answers from es by the §C chain) and lights i18n + content.
  // `es-419` is the RFC 0206 extended tag: it makes the v2 row
  // `0206.delivery-extended-locale` run against the §D ops (ADR 0748).
  process.env.OPENWOP_I18N_LOCALES = 'en,pt-BR,es-419';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true'; // host/mcpServerRegistry — inbound MCP tool catalog
  process.env.OPENWOP_TOOLCATALOG_COMPACTVIEW = 'true'; // toolCatalog.compactView
  // Multi-agent execution model — the version ladder is cumulative (version N
  // MUST implement phases 1..N, discovery.ts §multiAgent), and each phase's
  // BEHAVIOR rides its own flag. Advertising version 5 with an intermediate
  // phase flag off is a dishonest ladder: the shape advertises confidence
  // escalation (phase 2) / replay determinism (phase 4) that never fire.
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL = 'true'; // phase 1 — decision loop
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2 = 'true'; // confidence-floor escalation (RFC 0039)
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3 = 'true'; // cross-host causation (RFC 0040)
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4 = 'true'; // replay determinism (RFC 0041)
  process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5 = 'true'; // stateful loop (RFC 0061)
  // OPENWOP_AGENT_VERIFIER_GATING deliberately NOT set: phase 6 advertises
  // executionModel version 6 (RFC 0090), which the corpus schema's 1-5 ladder
  // rejects — advertising it reds the shape scenarios. See the opt-out below.
  process.env.OPENWOP_SELF_HOSTED_RUNNER = 'true'; // host/selfHostedRunner.ts
  process.env.OPENWOP_SELF_HOSTED_RUNNER_ACCEPTED = 'true'; // the deliberate operator-acceptance second key
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true'; // RFC 0100 A2A JSON-RPC server (agents.ts)
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true'; // ADR 0035 a2aTaskStore — durable tasks + push configs
  // ── The suite's A2A fake peer — STARTED (H25, 2026-08-16) ──────────────────
  //
  // This block used to say "deliberately NOT set — and this is a FINDING". The
  // finding was right and the disposition was the problem: every A2A leg that
  // needs the peer calls `getA2AFakePeer()` and `return`s when it is null, so
  // with the peer unstarted they were neither passing nor `blocked` — they did
  // not run, and the suite reported green over three RFC 0152 §B requirements
  // and both RFC 0100 reverse drift points.
  //
  // What kept it off was drift point #3: the `conformance-a2a-task-roundtrip`
  // fixture declares an A2A invoke node that resolved to nothing on this host,
  // so the run failed at dispatch and the host was advertising a fixture it
  // could not execute. That is closed — `bootstrap/conformanceA2aInvokeNode.ts`
  // maps the reserved typeId `core.conformance.a2a-invoke` onto the real
  // `ctx.a2a.*` client, and projects `AUTH_REQUIRED`/`REJECTED` per
  // §"State projection (reverse)". (It also answered to the pre-1.122.0
  // `core.a2a.invoke` while the pin lagged the rename; that alias was deleted at
  // H47 when the pin reached `^1.136.0` and the fixture was re-vendored.)
  //
  // The port is PINNED here rather than left to the OS because both sides need
  // the same number before either starts: the suite binds the peer in its own
  // `setup.ts`, and the host has to be told where to dispatch at boot — an
  // OS-chosen port does not exist yet at the moment the host's env is fixed
  // (the same ordering constraint `pinnedPort` documents for the container
  // lane). The RFC 0093 egress guard must admit the loopback peer — without it
  // `guardedEgressFetch` refuses it before the first socket — so its exact
  // origin joins OPENWOP_WEBHOOK_ALLOW_ORIGINS below. (This used to lean on the
  // blanket OPENWOP_WEBHOOK_ALLOW_PRIVATE; WHD-19 retired that here.)
  const a2aPeerPort = pinnedPort('OPENWOP_A2A_FAKE_PEER_PORT') || (await reservePort('127.0.0.1'));
  process.env.OPENWOP_A2A_FAKE_PEER = 'true';              // suite-side: start the peer
  process.env.OPENWOP_A2A_FAKE_PEER_PORT = String(a2aPeerPort);
  process.env.OPENWOP_A2A_CONFORMANCE_PEER_URL = `http://127.0.0.1:${a2aPeerPort}`; // host-side: where to dispatch
  // The §B requirements are ALSO witnessed at host tier by
  // `test/a2a-invoke-seam.test.ts` (real seam, real dual-era peer, headers read
  // off the peer) — see ADR 0552 § "P2 — implemented".

  // ── The suite's MCP fake server — STARTED (H21, 2026-08-17) ────────────────
  //
  // Same shape as the A2A block above, same reason. `mcp-tool-roundtrip`'s
  // host-mediated leg opens `getMcpFakeServer()` and soft-skips `blocked` when
  // it is null, so with the server unstarted the leg measured NOTHING — and the
  // direct-probe leg above it skipped too, leaving the whole file unwitnessed.
  //
  // The port is PINNED for the identical ordering reason: the suite binds the
  // server in its own `setup.ts`, and the host must be told where to reach it at
  // boot, before that bind has happened. `OPENWOP_MCP_SERVER_URL` is the H21
  // operator-config surface — the host synthesizes a curated `reach:'mcp'`
  // Connections provider from it (`host/mcpOperatorServer.ts`), so the call
  // travels the ordinary outbound pipeline rather than a conformance side door.
  // No token ref is set: the fake server is unauthenticated, and the operator
  // lane sends NO `Authorization` header rather than a placeholder bearer.
  // Its exact origin in OPENWOP_WEBHOOK_ALLOW_ORIGINS (below) is what lets the
  // RFC 0093 guard and the client's https-only rule accept this one loopback
  // target — this posture, never a default.
  const mcpServerPort = pinnedPort('OPENWOP_MCP_FAKE_SERVER_PORT') || (await reservePort('127.0.0.1'));
  process.env.OPENWOP_MCP_FAKE_SERVER = 'true';              // suite-side: start the server
  process.env.OPENWOP_MCP_FAKE_SERVER_PORT = String(mcpServerPort);
  process.env.OPENWOP_MCP_SERVER_URL = `http://127.0.0.1:${mcpServerPort}`; // host-side: operator config
  process.env.OPENWOP_MCP_SERVER_LABEL = 'Conformance MCP server';

  // ── WHD-19 — the webhook egress guard stays ON; exactly the doubles pass ────
  //
  // This lane used to boot with OPENWOP_WEBHOOK_ALLOW_PRIVATE=true, which turns
  // the whole webhook-family egress guard OFF. Two consequences, both measured
  // on suite 2.34.0: `v2-webhook-egress-refusal` saw 8 of 8 destinations
  // `webhooks.md` §SSRF says MUST be refused ACCEPTED (executed-fail, and every
  // profile built on `webhooks` denied), and — the worse half — this gate, which
  // `deploy.sh` runs before every deploy, could never have caught a guard
  // regression, because the guard it measured was never on.
  //
  // Instead the lane now names the EXACT origins of the harness doubles that
  // travel the webhook-family guard, and nothing else:
  //
  //   webhook receiver  — the suite binds it; its port is PINNED here (the suite
  //                       honours OPENWOP_WEBHOOK_RECEIVER_PORT in every file
  //                       that registers it, except `replay-fanout-suppression`,
  //                       which binds port 0 and so is refused — see WHD-19)
  //   compat mock       — reached via `webhookEgressDispatcher()` (RFC 0108)
  //   A2A fake peer     — reached via `guardedEgressFetch`
  //   MCP fake server   — the MCP client's https-only arm + the dispatcher
  //
  // The OIDC issuer is deliberately NOT listed: the verifier's JWKS read is a
  // plain `fetch`, not the webhook guard, so listing it would be a relaxation
  // that relaxes nothing — noise that reads as a need.
  //
  // Serial file execution (`--no-file-parallelism`, below) is what makes one
  // pinned receiver port safe across files.
  const receiverPort = pinnedPort('OPENWOP_WEBHOOK_RECEIVER_PORT') || (await reservePort('127.0.0.1'));
  process.env.OPENWOP_WEBHOOK_RECEIVER_PORT = String(receiverPort);
  if (process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      `[conformance] ignoring OPENWOP_WEBHOOK_ALLOW_PRIVATE=${process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE} from the environment — `
        + 'this lane measures the webhook egress guard ON and admits only the exact harness origins (WHD-19).',
    );
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  }
  const harnessOrigins = [
    `http://127.0.0.1:${receiverPort}`,
    new URL(compatEndpoint).origin,
    `http://127.0.0.1:${a2aPeerPort}`,
    `http://127.0.0.1:${mcpServerPort}`,
  ];
  process.env.OPENWOP_WEBHOOK_ALLOW_ORIGINS = harnessOrigins.join(',');
  // RFC 0201 §E / ADR 0747 — the minimum rotation overlap, so the secret-rotation
  // scenario's post-overlap leg fits the suite's 90 s wait cap and is WITNESSED
  // rather than recorded as a partial witness. And lift the per-tenant
  // verification budget (§D.17): every scenario registers under one tenant, and
  // the four 0201 files send ~9 verifications inside a minute — a lane that
  // tripped the production default would red on a SHOULD, not on the wire.
  process.env.OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S ??= '60';
  process.env.OPENWOP_WEBHOOK_VERIFY_PER_TENANT_PER_MIN ??= '1000';
  // eslint-disable-next-line no-console
  console.log(`[conformance] webhook egress guard ON; exact-origin allowlist: ${harnessOrigins.join(', ')}`);
  // RFC 0025 §C — the test-mode registry namespace (H19). Without this the
  // `packs-test` routes are not mounted, `capabilities.packs.testMode.supported`
  // is absent, and `pack-registry-publish` records `inapplicable` — i.e. the
  // 19-code publish error catalog is unmeasured and `openwop-node-packs` reads
  // as "not held". The catalog is isolated in an in-memory Map that never
  // touches the production catalog (`routes/packs-test.ts`), so enabling it in
  // a conformance boot costs nothing and claims nothing extra.
  process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED = 'true';
  process.env.OPENWOP_DATA_RESIDENCY_ENABLED = 'true'; // features/cdp/dataResidency — admission control
  process.env.OPENWOP_DATA_RESIDENCY_REGIONS = 'us'; // region this memory:// boot genuinely pins
  // RFC 0010 §D — OIDC user-bearer. The verifier (middleware/oidcVerifier.ts →
  // middleware/auth.ts bearer branch) is genuinely implemented; configuring it
  // here advertises `openwop-auth-oidc-user-bearer` + `auth.oidc.*` and points
  // trust at the suite's SYNTHETIC issuer harness: the oidc scenario binds its
  // JWKS/discovery endpoints at OPENWOP_TEST_OIDC_ISSUER_URL, so the host's
  // introspection fetches resolve hermetically in-suite. Port is reserved by a
  // momentary bind (same free-port trick as the compat mock above).
  const oidcIssuerUrl = await reserveOidcIssuer(mockBinding(undefined));
  process.env.OPENWOP_TEST_OIDC_ISSUER_URL = oidcIssuerUrl; // suite harness binds here
  process.env.OPENWOP_OIDC_ISSUER = oidcIssuerUrl; // host trusts the harness issuer
  process.env.OPENWOP_OIDC_AUDIENCE = 'openwop-conformance'; // harness default audience

  // RFC 0154 §A/§B — the workload-identity profile (ADR 0556 P3). Configuring it
  // is what makes `auth.workloadIdentity` appear in discovery and what lights
  // the §20 seam, so `workload-identity-behavior.test.ts` EXECUTES instead of
  // reporting `blocked`.
  //
  // `openwop-host` is the audience the suite's fixtures present, and the trust
  // root below is the issuer they present under. Neither is a mock: they are
  // configuration, read by the same resolver a production deployment's roots
  // are read by, and the negative legs (audience mismatch, expired delegation)
  // are refused by that resolver's own checks. The root carries a `keyRef` so
  // the credential-verification half is configured too — a root without one
  // cannot verify a presented credential and `verifyWorkloadCredential` refuses
  // it, which is the fail-closed posture, not a convenience.
  process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE = 'openwop-host';
  process.env.OPENWOP_WORKLOAD_IDENTITY_ISSUER = 'urn:openwop:conformance-host';
  process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST = JSON.stringify([
    {
      issuer: 'spiffe://example',
      scheme: 'spiffe',
      issuerClass: 'spiffe',
      tenantId: 'default',
      scopes: ['manifest:read', 'runs:read', 'artifacts:read'],
      keyRef: 'auth:workload-identity-conformance-key',
    },
  ]);
  process.env.OPENWOP_BOOT_SECRETS = JSON.stringify({
    ...(process.env.OPENWOP_BOOT_SECRETS ? (JSON.parse(process.env.OPENWOP_BOOT_SECRETS) as Record<string, string>) : {}),
    'auth:workload-identity-conformance-key': 'conformance-workload-identity-key',
  });

  // OPTED OUT — either the capability is NOT implemented (advertising it would
  // be a dishonest wire claim), or it cannot be advertised/witnessed by this
  // boot without a code change. Each entry cites why; an entry here is a TODO
  // ledger, not a licence to ignore the surface.
  process.env.OPENWOP_OPTED_OUT_PROFILES = [...OPTED_OUT_PROFILES, ...major2UndeclaredFamilies()].join(',');
  // eslint-disable-next-line no-console
  console.log(`[conformance] compat mock at ${compatEndpoint} — selfHosted advertised (RFC 0108)`);

  resolveConformanceRoot();

  // ── Pack determinism: the result must depend on the COMMIT, not the machine ──
  //
  // This harness boots via `createApp`, so `index.ts main()` never runs and
  // `ensureLocalPacksMounted()` never fires. The node-pack resolver then reads
  // whatever the SHARED `~/.openwop-packs` happens to contain — a directory
  // that other checkouts, other sessions, and stale registry installs all write
  // to. The suite was therefore measuring the machine, not the commit.
  //
  // That is not hypothetical. It is how eight scenarios ended up quarantined:
  //
  //   MEASURED 2026-08-13 on `origin/main`. `~/.openwop-packs/core.openwop.ai`
  //   was a real directory containing ONLY `.openwop-installed.json` — no
  //   `pack.json`, no `index.mjs`. That pack provides `core.ai.structuredOutput`,
  //   the single node in every `conformance-envelope-*` fixture. The typeId could
  //   not resolve, the run never reached `dispatchStructured()`, and so not one
  //   `envelope.*` event could fire. With the vendored packs mounted instead:
  //   43 files / 207 tests PASS, 0 fail. Against the ambient dir: 8 files / 26
  //   tests fail. Same commit, same code — different directory.
  //
  // The failures were recorded as "pre-existing failure on main, not diagnosed",
  // which read as host non-conformance. It was not. A conformance result that
  // depends on ambient machine state is not evidence about the host, and the
  // fact that it can be quarantined as if it were makes it actively misleading.
  //
  // So: mount THIS checkout's vendored packs into a private, per-run directory.
  // Not `~/.openwop-packs` — writing there is what created the hazard, and it
  // would race the parallel-worktree sessions CLAUDE.md warns about. Symlinks,
  // so the packs stay byte-identical to the tree under test.
  //
  // An explicit `OPENWOP_PACK_DIR` still wins: an operator pointing the suite at
  // a real installed tree is a deliberate measurement, not the accident above.
  if (!process.env.OPENWOP_PACK_DIR) {
    const vendored = resolve(process.cwd(), '..', '..', 'packs');
    const runPackDir = mkdtempSync(join(tmpdir(), 'owp-conformance-packs-'));
    let mounted = 0;
    if (existsSync(vendored)) {
      for (const entry of readdirSync(vendored)) {
        if (entry.startsWith('.')) continue;
        if (!existsSync(join(vendored, entry, 'pack.json'))) continue;
        try {
          symlinkSync(join(vendored, entry), join(runPackDir, entry), 'dir');
          mounted += 1;
        } catch {
          /* a duplicate/unlinkable entry is skipped; the count below reports the truth */
        }
      }
    }
    process.env.OPENWOP_PACK_DIR = runPackDir;
    // Report the COUNT, not just the path. Zero here means every pack-node
    // scenario is about to fail for an environmental reason, and that should be
    // legible in the log rather than inferred from a wall of red.
    // eslint-disable-next-line no-console
    console.log(`[conformance] mounted ${mounted} vendored pack(s) into ${runPackDir} (deterministic; not ~/.openwop-packs)`);
    if (mounted === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[conformance] WARNING: no vendored packs found under ${vendored} — every pack-node scenario will fail for want of a node type, NOT for non-conformance.`);
    }
  }

  // Import the app ONLY now — after OPENWOP_PACK_DIR is final. See the
  // import-site comment: the pack resolvers capture it at module scope.
  const { createApp, loadConfigFromEnv } = await import('../src/index.js');
  const { processDueWebhookDeliveries } = await import('../src/host/webhookDeliveryWorker.js');

  // The DSN is READ FROM THE ENV rather than hard-coded, and that is the whole
  // point of the sqlite temp file chosen in `main()` above. It was
  // `storageDsn: 'memory://'` here, which SILENTLY OVERRODE
  // `OPENWOP_STORAGE_DSN` — so a boot that thought it had picked a durable
  // store got a `:memory:` one, and the workspace scenarios soft-skipped while
  // the suite still reported them as 4 passing tests. Measured: the totals were
  // IDENTICAL either way, so no count could have caught it.
  const app = await createApp({
    ...loadConfigFromEnv(),
    port: PORT,
    storageDsn: process.env.OPENWOP_STORAGE_DSN ?? 'memory://',
  });

  // ADR 0745 D2 — the suite's `challenge-403-scope` leg needs a VALID credential
  // that lacks `runs:create`, and "the suite will not infer one". Minted through
  // the real self-service path (an ADR 0270 `owk_` key declaring only
  // `runs:read`), not an env-key variant: the witness is then the product's own
  // key-scope narrowing, the thing `scopes_supported` claims. In-process only —
  // an external target owns its own store, and there the leg records `blocked`.
  //
  // MAJOR 2 ONLY — the same suite defect as the tenant-B key below. MEASURED on
  // suite 2.38.0: the major-1 `interrupt-auth-required-resume` sends this key in
  // `headers` WITHOUT `authenticated: false`, so `lib/driver.ts` replaces it with
  // the OWNER key; the "low-scope" resolve is the owner's, answers 200, and the
  // row reds. The major-2 consumer (`v2-auth-challenge`) sets it correctly.
  // WIDENED to both majors at the 2.41.0 pin: openwop#1557 (2.39.3+) makes the
  // driver honour a caller-supplied Authorization, which was the defect above.
  {
    const { issueApiKey } = await import('../src/features/developer-keys/apiKeyService.js');
    process.env.OPENWOP_TEST_LOW_SCOPE_KEY = (await issueApiKey({
      tenantId: 'conformance-low-scope',
      name: 'conformance low-scope (runs:read only)',
      createdBy: 'user:conformance-harness',
      scopes: ['runs:read'],
    })).token;
  }

  await new Promise<void>((res) => {
    // H41: bind the address the suite dials (see conformance/port.ts) — never
    // the wildcard, which can "succeed" on a port a loopback-only occupant holds.
    const server = app.listen(PORT, CONFORMANCE_BIND_HOST, () => {
      // eslint-disable-next-line no-console
      console.log(`[conformance] sample backend listening at ${BASE_URL}`);
      res();
      // Keep `server` referenced so it doesn't GC.
      void server;
    });
  });

  // Drain the durable webhook-delivery queue (webhook-signed-delivery scenario).
  // The delivery worker is server-ONLY — main() starts it at index.ts:729, but
  // createApp does NOT (index.ts:631-636: tests "build the app via createApp
  // WITHOUT polling workers and drive the queue … deterministically via the
  // exported processDueWebhookDeliveries()"). So a bare createApp boot ENQUEUES
  // run-event deliveries (the routes/webhooks.ts event-log subscription is live)
  // but never POSTs them → webhooks.md §"Delivery" reads 0. This host genuinely
  // delivers webhooks in production; the boot just has to run the drain main()
  // would. We drive the exported drain seam directly (rather than
  // startWebhookDeliveryWorker's 1s poll) on a 100ms cadence so the scenario's
  // 500ms post-run grace can witness the signed POST without flaking. Honest
  // boot-wiring, not a gamed advert: webhooks.supported=true is now behaviorally
  // exercised end-to-end. .unref() so it never keeps the process alive.
  // ── RFC 0087 §B org-chart: seed rows, because an EMPTY chart is not evidence ──
  // `org-position-no-authority-escalation` reads `GET /v1/agents/org-chart` and
  // asserts that no member/department/view carries an authority-bearing field.
  // It iterates the chart's rows, so against an empty chart it makes ZERO
  // assertions and returns early — which the RFC 0148 §A ledger records as
  // `blocked`, not `executed-pass`. MEASURED: serving the route with no chart
  // seeded turned the file green while recording `blocked / 0 assertions` —
  // a passing file that checked nothing, i.e. exactly the vacuous-green class
  // the ledger exists to expose. So the boot seeds a real chart: two nested
  // departments and a roster-backed member with a workflow portfolio, which
  // also gives the §D responsibility roll-up something to roll up.
  //
  // Tenant `default`: the suite authenticates with a WILDCARD key
  // (`OPENWOP_API_KEYS = <key>:*`), and `middleware/auth.ts` deliberately leaves
  // `req.tenantId` unset for a wildcard, so the routes read `'default'`.
  {
    const { createRosterEntry } = await import('../src/host/rosterService.js');
    const { putChart } = await import('../src/host/orgChartService.js');
    const tenantId = 'default';
    const member = await createRosterEntry({
      tenantId,
      persona: 'Conformance Brief Writer',
      agentRef: { agentId: 'core.openwop.agents.brief-writer' },
      workflows: ['openwop-app.uppercase'],
    });
    const rosterId = (member as { rosterId: string }).rosterId;
    const seeded = await putChart({
      tenantId,
      departments: [
        { departmentId: 'dept-conformance', name: 'Conformance', parentDepartmentId: null, roles: [{ roleId: 'role-lead', name: 'Lead' }] },
        { departmentId: 'dept-conformance-writing', name: 'Writing', parentDepartmentId: 'dept-conformance', roles: [{ roleId: 'role-writer', name: 'Writer' }] },
      ],
      members: [{ rosterId, departmentId: 'dept-conformance-writing', roleId: 'role-writer', reportsTo: null }],
    });
    if ('error' in seeded) {
      // Fail LOUD: a silently unseeded chart is the vacuous-green state above.
      throw new Error(`[conformance] org-chart seed rejected: ${JSON.stringify(seeded.error)}`);
    }
    // eslint-disable-next-line no-console
    console.log('[conformance] seeded org-chart: 2 departments, 1 roster-backed member (RFC 0087 §B has rows to check)');
  }

  const webhookStorage = app.locals.storage as Storage;
  const webhookDrain = setInterval(() => {
    void processDueWebhookDeliveries(webhookStorage, 'webhook-conformance').catch(() => {
      /* fail-contained: a drain error must never crash the conformance host */
    });
  }, 100);
  if (typeof webhookDrain.unref === 'function') webhookDrain.unref();

  await runSuite(BASE_URL);
}

/**
 * Spawn the conformance suite against `baseUrl`.
 *
 * ONE runner, two boots (ADR 0550 P2). The in-process path above and the
 * external-target path (a running release container) both land here, because
 * the boundaries table forbids a second runner and the driver is already
 * origin-agnostic: `lib/env.ts:74` reads OPENWOP_BASE_URL and every scenario
 * self-skips when it is absent. Only the ORIGIN differs.
 */
/** Kill the suite's whole process group (npx + vitest + workers); fall back to
 *  the pid alone if the group is already gone. */
function killSuiteTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

async function runSuite(baseUrl: string): Promise<void> {
  // Run the suite SERIALLY (`--no-file-parallelism`). The conformance suite
  // shares ONE in-process host whose test seam holds GLOBAL mutable state (the
  // projected event log + `POST /test/reset`). Running files in parallel lets
  // one file's reset clobber another file's projected events mid-test → false
  // failures (most visibly the envelope-reliability + engine-projection
  // scenarios, which assert exact event counts). The steward measures
  // "in-process serial"; we match it. The vendored CLI (`dist/cli.js`) silently
  // drops unknown flags, so it CANNOT forward `--no-file-parallelism` — invoke
  // vitest directly against the suite's own config instead. The only CLI
  // behaviors we rely on (filter → --testNamePattern, the --offline subset)
  // are mirrored here.
  const conformanceRoot = resolve('node_modules', '@openwop', 'openwop-conformance');
  const configPath = resolve(conformanceRoot, 'vitest.config.ts');
  const argv = process.argv.slice(2);
  const filterIdx = argv.indexOf('--filter');
  const filter = filterIdx >= 0 ? argv[filterIdx + 1] : undefined;
  const vitestArgs = ['vitest', 'run', '--config', configPath, '--no-file-parallelism'];

  // ── ADR 0550 P4 — CERTIFY MODE ─────────────────────────────────────────────
  //
  // `--certify [outDir]` turns this run into the evidence behind a PUBLIC claim.
  // Three things change, and each is a refusal rather than a feature:
  //
  //  1. The RFC 0148 §A ledger gets a sink and vitest gets a JSON reporter. A
  //     bundle assembled from per-file pass/fail cannot tell `skipped` from
  //     `inapplicable` from `blocked` — three claims with different consequences
  //     — so without the ledger every unclassifiable file resolves to `blocked`
  //     and nothing certifies. The ledger is what makes the claim possible AND
  //     what makes it bounded.
  //  2. The quarantine is REFUSED, not merely bypassed. `scenarioManifestSha256`
  //     digests the scenario set that ran; certifying against an excluded set
  //     would bind the claim to a manifest that omits exactly the scenarios the
  //     host is failing, which is a smaller suite wearing the digest of a bigger
  //     one. `OPENWOP_CONFORMANCE_NO_QUARANTINE=1` is forced here.
  //  3. `OPENWOP_REQUIRE_BEHAVIOR=true` (RFC 0148 §B): an advertised capability
  //     whose behavioral assertion cannot execute must FAIL, not soft-skip. A
  //     claim derived from a permissive run is the vacuity the RFC exists to
  //     close.
  const certifyIdx = argv.indexOf('--certify');
  const certifyOutDir =
    certifyIdx < 0
      ? undefined
      : ((next) =>
          next !== undefined && !next.startsWith('--')
            ? resolve(next)
            // Derived from THIS FILE's location, not from cwd. The rest of the
            // runner assumes `cwd === backend/typescript` (see the
            // `node_modules` resolve below), and that assumption is fine for a
            // package script — but writing an artifact is the one place where
            // being wrong puts a file OUTSIDE the repo, silently.
            : resolve(import.meta.dirname, '..', '..', '..', 'build-meta'))(argv[certifyIdx + 1]);

  // ADR 0550 P1 — SHRINK-ONLY QUARANTINE.
  //
  // Until this phase, `test:conformance` was never wired into any gate. The
  // header comment above claims CI gates on it; that gate had never existed,
  // and behind its absence the suite drifted RED — 31 failures across 11 files
  // on `origin/main` when first measured (2026-08-11, 3373372b6).
  //
  // Wiring a red suite straight into the merge gate would block every unrelated
  // PR, so the failing scenarios are excluded by name and the REST of the suite
  // becomes a real blocking gate. That is the whole point: a new conformance
  // failure can no longer land silently, and the quarantine can only shrink.
  //
  // This is a debt ledger, NOT an opt-out. `OPENWOP_OPTED_OUT_PROFILES` above
  // says "we do not claim this capability"; an entry HERE says "we claim it and
  // we are currently failing it". Never move a scenario between the two lists
  // to make something green.
  //
  // Run the truth with `OPENWOP_CONFORMANCE_NO_QUARANTINE=1`.
  if (certifyOutDir !== undefined && process.env.OPENWOP_CONFORMANCE_NO_QUARANTINE !== '1') {
    // Forced, not assumed: see the certify-mode note above — a quarantined run
    // produces a manifest digest that does not describe the suite it claims.
    process.env.OPENWOP_CONFORMANCE_NO_QUARANTINE = '1';
    // eslint-disable-next-line no-console
    console.log('[conformance] --certify: quarantine DISABLED (a certification manifest must digest the whole suite)');
  }
  if (process.env.OPENWOP_CONFORMANCE_NO_QUARANTINE !== '1') {
    const { entries } = JSON.parse(
      readFileSync(resolve(import.meta.dirname, 'quarantine.json'), 'utf8'),
    ) as { entries: { file: string }[] };
    for (const e of entries) vitestArgs.push('--exclude', e.file);
    if (entries.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[conformance] ${entries.length} scenario file(s) QUARANTINED (ADR 0550 P1) — `
          + 'these are known-failing and excluded from the gate. '
          + 'Run with OPENWOP_CONFORMANCE_NO_QUARANTINE=1 to see the real state.',
      );
    }
  }
  if (argv.includes('--offline')) {
    vitestArgs.push('src/scenarios/fixtures-valid.test.ts', 'src/scenarios/spec-corpus-validity.test.ts');
  }
  if (filter !== undefined) vitestArgs.push('--testNamePattern', filter);

  // Certify-mode reporter + ledger sink, in a PER-RUN temp dir so two concurrent
  // runs cannot read each other's ledger — the same isolation reasoning as the
  // per-run pack dir above. Deliberately NOT deleted afterwards (the suite's own
  // CLI does delete its equivalent): a certify run is rare and its raw vitest
  // report is the first thing anyone wants when a profile unexpectedly fails to
  // certify. The path is printed in the summary.
  let certifyReport: string | undefined;
  let certifyLedger: string | undefined;
  if (certifyOutDir !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'owp-app-certify-'));
    certifyReport = join(dir, 'vitest-report.json');
    certifyLedger = join(dir, 'requirement-ledger.jsonl');
    vitestArgs.push('--reporter=json', `--outputFile=${certifyReport}`);
  }

  // Own PROCESS GROUP so the watchdog (below) can kill the whole tree: `npx`
  // spawns vitest as a grandchild, and killing only the direct child left an
  // orphaned `vitest run` (ppid 1) still holding the port — measured while
  // writing the watchdog. SIGINT/SIGTERM are forwarded to the group so Ctrl-C
  // still stops the suite despite the separate group.
  // `--no-file-parallelism` above is NOT the last word on the worker count.
  // vitest resolves `fileParallelism: false` to `maxWorkers = 1`, then LATER and
  // unconditionally applies `process.env.VITEST_MAX_WORKERS` on top of it
  // (vitest 4.1.8, resolveConfig — the env read sits after the parallelism
  // clamp, so neither the flag nor `--maxWorkers 1` survives it). A parent that
  // caps its OWN fleet with that variable — the sane thing to do when
  // `npm run ci` runs the backend lane on a 32 GB box — therefore hands this
  // suite N forks, and the suite's `setup.ts` binds its fake MCP server and A2A
  // peer on ONE pinned port per test file, so N-1 of every N files fail at load
  // with EADDRINUSE while the host itself is perfectly healthy. MEASURED
  // 2026-09-05, three gate runs in a row: VITEST_MAX_WORKERS=4 → 393/515 files
  // failed (`listen EADDRINUSE 127.0.0.1:<mcp port>`); unset → 504 passed, 0
  // failed, same tree. The serial contract is this runner's to enforce, not the
  // caller's to remember, so the knob is stripped from the child's environment.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.VITEST_MAX_WORKERS;

  const child = spawn('npx', vitestArgs, {
    cwd: conformanceRoot,
    detached: true,
    stdio: 'inherit',
    env: {
      ...childEnv,
      OPENWOP_BASE_URL: baseUrl,
      OPENWOP_API_KEY: process.env.OPENWOP_API_KEY ?? API_KEY,
      // ADR 0553 P3 (H53) — the second caller for the §D cross-caller cache leg.
      OPENWOP_TEST_SECONDARY_API_KEY: SECONDARY_API_KEY,
      // ADR 0745 D3 — the non-disclosure legs' second tenant. Set only when THIS
      // harness configured the host's key table (in-process); an external target
      // has its own keys, and a key it does not know would read as a host defect.
      //
      // MAJOR 2 ONLY, and the reason is a suite defect, not a host one. MEASURED
      // at suite 2.36.1 (still present at corpus 2.37.1): the major-1 scenario
      // `workspace-cross-tenant-isolation-blackbox` sends the tenant-B key in
      // `headers` WITHOUT `authenticated: false`, and `lib/driver.ts` then
      // overwrites `Authorization` with the OWNER key — so "tenant B's read" is
      // the owner reading its own file, 200, and the row reds as a leak. A direct
      // HTTP repro with the same two keys answers 404. Every major-2 consumer
      // (`auth-challenge-no-oracle`) passes `authenticated: false` correctly.
      // Reported upstream; widen to both majors when the scenario is fixed.
      // WIDENED to both majors at the 2.41.0 pin (openwop#1557, 2.39.3+ — the
      // driver now honours the caller's Authorization).
      ...(process.env.OPENWOP_API_KEYS?.includes(TENANT_B_API_KEY)
        ? { OPENWOP_TEST_TENANT_B_API_KEY: TENANT_B_API_KEY }
        : {}),
      OPENWOP_IMPLEMENTATION_NAME: 'openwop-workflow-engine',
      OPENWOP_IMPLEMENTATION_VERSION: '0.1.0',
      ...(certifyLedger === undefined
        ? {}
        : {
            OPENWOP_LEDGER_PATH: certifyLedger,
            // RFC 0148 §B strict behavior. An advertised capability whose
            // assertion cannot execute must fail rather than soft-skip; a claim
            // derived from a permissive run is exactly the vacuity §B closes.
            OPENWOP_REQUIRE_BEHAVIOR: 'true',
          }),
    },
  });

  // WATCHDOG (H40, 2026-08-17). The runner exits when the CHILD exits — and
  // the child is vitest, which after a failing file against a REMOTE target
  // can sit on open handles (keep-alive sockets, a stream the far end never
  // closes) and never exit. MEASURED: an external-target run with one failing
  // `mcp-mrtr-roundtrip` leg printed its results and then hung until killed at
  // 10 minutes; a wedged runner inside `npm run ci` is a wedged gate. So the
  // suite gets a wall-clock bound: default 45 min (the full local lane takes
  // ~10; the release-artifact lane less), `OPENWOP_CONFORMANCE_MAX_MS` to
  // override. On expiry the child is killed and the runner exits 124 with a
  // message that names the bound — a loud, attributable failure, never a
  // silent wedge and never a green.
  const maxMsRaw = Number(process.env.OPENWOP_CONFORMANCE_MAX_MS ?? '');
  const maxMs = Number.isFinite(maxMsRaw) && maxMsRaw > 0 ? maxMsRaw : 45 * 60_000;
  const watchdog = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(
      `[conformance] WATCHDOG: the suite did not exit within ${maxMs} ms `
        + '(OPENWOP_CONFORMANCE_MAX_MS) — killing it. This is a FAILURE (exit 124): the last '
        + 'file above did not release the process; look for open handles/streams against the target.',
    );
    killSuiteTree(child.pid);
    process.exit(124);
  }, maxMs);
  watchdog.unref();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { killSuiteTree(child.pid, sig); process.exit(130); });
  }

  child.on('exit', (code) => {
    clearTimeout(watchdog);
    // eslint-disable-next-line no-console
    console.log(`[conformance] suite exited with code ${code}`);
    if (certifyOutDir === undefined || certifyReport === undefined || certifyLedger === undefined) {
      process.exit(code ?? 1);
      return;
    }
    // The suite's exit code is NOT the certification verdict, and conflating
    // them would be the vacuity again in miniature: a failing scenario outside
    // every claimed floor does not invalidate a claim, and a green run whose
    // floor rows were never recorded does not substantiate one. The verdict
    // comes from the ledger.
    void emitCertification({ baseUrl, outDir: certifyOutDir, reportFile: certifyReport, ledgerFile: certifyLedger })
      .then((certifyExit) => process.exit(certifyExit !== 0 ? certifyExit : (code ?? 1)))
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[conformance] --certify FAILED to emit:', err);
        process.exit(2);
      });
  });
}

/**
 * ADR 0550 P4 — read the run's evidence, assemble the RFC 0148 §C bundle, derive
 * the claims, and stamp both into `build-meta/`.
 *
 * Returns the exit code the CERTIFICATION deserves: 0 when the artifacts were
 * written, 2 when they could not be (a missing report, an emitter defect, a
 * schema rejection). It never invents a claim to avoid a non-zero exit —
 * `claimedProfiles: []` is a legitimate, publishable answer and is what an
 * honest host with unproven floors should say.
 */
async function emitCertification(opts: {
  baseUrl: string;
  outDir: string;
  reportFile: string;
  ledgerFile: string;
}): Promise<number> {
  const certify = await import('./certify.js');
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

  const discoveryUrl = `${opts.baseUrl.replace(/\/+$/, '')}/.well-known/openwop`;
  const res = await fetch(discoveryUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.error(`[conformance] --certify: GET ${discoveryUrl} returned HTTP ${res.status}`);
    return 2;
  }
  const document = (await res.json()) as Record<string, unknown>;

  let report: certifyModule.VitestJsonReport;
  try {
    report = JSON.parse(readFileSync(opts.reportFile, 'utf8')) as certifyModule.VitestJsonReport;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[conformance] --certify: could not read the vitest JSON report at ${opts.reportFile}: ${String(err)}`);
    return 2;
  }

  const states = certify.scenarioStatesFromReport(report);
  const ledger = certify.readLedgerFile(opts.ledgerFile);
  const suiteVersion = JSON.parse(
    readFileSync(resolve('node_modules', '@openwop', 'openwop-conformance', 'package.json'), 'utf8'),
  ).version as string;
  const commitFile = join(repoRoot, 'build-meta', 'commit.txt');
  const commit = existsSync(commitFile) ? readFileSync(commitFile, 'utf8').trim() : undefined;

  const assembled = certify.assembleCertification({
    document,
    discoveryUrl,
    states,
    ledger,
    suiteVersion,
    hostName: 'openwop-workflow-engine',
    hostVersion: '0.1.0',
    requireBehavior: process.env.OPENWOP_REQUIRE_BEHAVIOR === 'true',
    optedOut: [...OPTED_OUT_PROFILES, ...major2UndeclaredFamilies()],
    ...(commit ? { commit } : {}),
    secrets: [process.env.OPENWOP_API_KEY ?? API_KEY, SECONDARY_API_KEY, TENANT_B_API_KEY, ...(process.env.OPENWOP_TEST_LOW_SCOPE_KEY ? [process.env.OPENWOP_TEST_LOW_SCOPE_KEY] : [])],
    // RFC 0158 §B / ADR 0585 P2 — publish the recovery bound as the per-class
    // ARITHMETIC so a reader can recompute it, not as a total to be trusted.
    // Read from the live module at emit time: a literal here would be the H97
    // defect (two numbers agreeing by luck while comments assert they must).
    recoveryBound: {
      terms: { ...recoveryBoundTerms() },
      classes: {
        unleased: declaredRecoveryBoundMs('unleased'),
        leased: declaredRecoveryBoundMs('leased'),
      },
    },
  });

  if (assembled.selfAudit.length > 0) {
    // A bundle-wide rejection is an EMITTER defect, never an evidence state.
    // Writing it anyway would publish a document the suite's own verifier
    // refuses — a claim no consumer could check.
    // eslint-disable-next-line no-console
    console.error(
      '[conformance] --certify: the assembled bundle FAILED the suite\'s own verifier (emitter defect):\n' +
        assembled.selfAudit.map((r) => `  - [${r.kind}] ${r.detail}`).join('\n'),
    );
    return 2;
  }

  const valid = await certify.validateAgainstVendoredSchema(assembled.bundle, repoRoot);
  if (!valid.ok) {
    // eslint-disable-next-line no-console
    console.error(`[conformance] --certify: bundle FAILED the VENDORED schema:\n${valid.errors}`);
    return 2;
  }

  const { bundlePath, claimsPath } = certify.writeCertification(opts.outDir, assembled);
  const t = assembled.claims.evidence.totals;
  // eslint-disable-next-line no-console
  console.log(
    `[conformance] --certify: wrote ${bundlePath} + ${claimsPath}\n` +
      `  suite ${suiteVersion}, ledger rows ${ledger.length}, scenario files ${states.size}\n` +
      `  raw evidence retained: ${opts.reportFile} + ${opts.ledgerFile}\n` +
      (assembled.redactedAt.length > 0
        // Loud, because the likely cause is a secret reaching evidence rather
        // than a routine scrub. RFC 0148 §E forbids credentials in a bundle;
        // this says WHERE one was caught, which is a finding to chase.
        ? `  ⚠ REDACTED ${assembled.redactedAt.length} field(s) carrying a configured secret or the conformance canary: ${assembled.redactedAt.slice(0, 8).join(', ')}${assembled.redactedAt.length > 8 ? ', …' : ''}\n`
        : '  redactions: none (no configured secret reached the evidence)\n') +
      `  executed-pass ${t.executedPass} / executed-fail ${t.executedFail} / skipped ${t.skipped} / inapplicable ${t.inapplicable} / blocked ${t.blocked}\n` +
      `  CLAIMED  (${assembled.claims.claimedProfiles.length}): ${assembled.claims.claimedProfiles.join(', ') || '(none)'}\n` +
      `  aliases  (${assembled.claims.aliases.length}): ${assembled.claims.aliases.join(', ') || '(none)'}\n` +
      assembled.claims.notClaimed.map((n) => `  NOT CLAIMED  ${n.profile}: ${n.reason}\n`).join('') +
      `  RFC 0156 §E permitted: ${assembled.claims.permittedClaims.join(', ') || '(none)'}\n`,
  );
  return 0;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[conformance] harness error:', err);
  process.exit(1);
});
