/**
 * Where the in-process conformance host listens (H17).
 *
 * WHY THIS EXISTS. `run.ts` hard-coded `const PORT = 18080`, and
 * `scripts/ci.sh` runs `npm run test:conformance` as part of `npm run ci`. Two
 * worktrees on one machine — the working arrangement CLAUDE.md assumes — then
 * race for the same socket, and the loser dies with `EADDRINUSE` in the middle
 * of a merge gate. MEASURED 2026-08-16: two agents' lanes collided exactly this
 * way, and the failure reads as a real break rather than as contention.
 *
 * THE SEMANTICS ARE DELIBERATELY THOSE OF `scripts/ci.sh` / `gate_pick_free_port`,
 * because a second, differently-behaved port policy in the same repo is its own
 * trap:
 *
 *   - A PINNED port (`OPENWOP_CONFORMANCE_PORT`) that is busy is an ERROR, never
 *     silently moved. Pinning is how a caller tells BOTH sides of a run the same
 *     number (see `pinnedPort()` in `run.ts` for the container lane's version of
 *     that constraint); quietly binding somewhere else would leave the other side
 *     dispatching into a closed port and every callback-shaped scenario failing
 *     as false non-conformance.
 *   - UNPINNED scans upward from 18080 for the first free port, and gives up
 *     after the same 40 additional candidates `gate_pick_free_port` allows —
 *     rather than returning a busy port, which is how a probe ends up answered by
 *     the OCCUPANT (the "adopt a different build" defect `ci.sh` calls out).
 *
 * The probe BINDS rather than shelling out to `lsof`: this runs inside the same
 * process that is about to bind, and a bind that fails is direct evidence where
 * `lsof`'s non-zero exit is ambiguous between "free" and "lsof is unusable" (the
 * defect `scripts/lib/gate-ports.sh` was written to close).
 *
 * It binds LOOPBACK V4 (`127.0.0.1`), and so does the host (H41, 2026-08-17).
 * The first cut probed the `[::]` wildcard "because that is what
 * `app.listen(port)` binds" — and that reasoning had a hole: on macOS a
 * `[::]:P` wildcard bind SUCCEEDS while another process holds `127.0.0.1:P`,
 * yet the suite dials `127.0.0.1:P`, so both the probe and the host would
 * report the port free/bound while every request went to the OCCUPANT (a
 * resident TLS listener produced exactly that: `HTTPParserError … 15 03 03`).
 * Probing and binding the address the suite actually dials is the only probe
 * that answers the question the suite asks. `EADDRINUSE` fires for BOTH kinds
 * of occupant (a wildcard holder and a loopback-only holder) when binding
 * 127.0.0.1, so nothing is lost.
 */
export const CONFORMANCE_BIND_HOST = '127.0.0.1';

import net from 'node:net';

/** The one env var that pins the conformance host's port. */
export const CONFORMANCE_PORT_ENV = 'OPENWOP_CONFORMANCE_PORT';

/** Where the unpinned scan starts — the historical hard-coded value. */
export const CONFORMANCE_PORT_DEFAULT = 18080;

/**
 * How many ADDITIONAL candidates the unpinned scan tries before giving up.
 * Mirrors `gate_pick_free_port`'s `tries > 40`, so the scanned window is
 * `[start, start + 40]` — 41 ports, the same width `ci.sh` reports as
 * "8080-8120".
 */
export const CONFORMANCE_PORT_SCAN_LIMIT = 40;

/** Free, or not-free with the reason the bind was refused. */
export type PortProbeResult = { free: true } | { free: false; code: string };

export type PortProbe = (port: number) => Promise<PortProbeResult>;

/**
 * Can this process bind `port`?
 *
 * Binds and immediately releases. There is an unavoidable window between the
 * release and the caller's real `listen()` — the same window `reservePort()` in
 * `run.ts` carries — but a lost race surfaces as a loud `EADDRINUSE` at boot,
 * which is strictly better than the silent collision this helper replaces.
 */
export async function probePort(port: number): Promise<PortProbeResult> {
  return await new Promise<PortProbeResult>((resolvePromise) => {
    const probe = net.createServer();
    let settled = false;
    const settle = (result: PortProbeResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    probe.once('error', (err: NodeJS.ErrnoException) => {
      // NOT listening, so nothing to close. `EADDRINUSE` is the expected code;
      // `EACCES` (privileged port) is reported verbatim rather than collapsed
      // into "in use", so a pinned :80 says why.
      settle({ free: false, code: err.code ?? err.name });
    });
    probe.listen(port, CONFORMANCE_BIND_HOST, () => {
      probe.close(() => settle({ free: true }));
    });
  });
}

export interface ConformancePortSelection {
  port: number;
  /** `pinned` — the operator chose it; `default` — the scan's first candidate
   *  was free; `scanned` — the start was busy and we moved up. */
  source: 'pinned' | 'default' | 'scanned';
  /** One line, ready for the `[conformance] …` boot log. */
  note: string;
}

/**
 * Decide the port the in-process conformance host binds.
 *
 * `probe` is injectable for tests that want to drive the decision without real
 * sockets; the shipped tests use REAL ephemeral listeners, because a fake probe
 * would let the bind semantics drift out from under this helper.
 */
export async function selectConformancePort(
  opts: {
    pinned?: string | undefined;
    start?: number;
    limit?: number;
    probe?: PortProbe;
  } = {},
): Promise<ConformancePortSelection> {
  const start = opts.start ?? CONFORMANCE_PORT_DEFAULT;
  const limit = opts.limit ?? CONFORMANCE_PORT_SCAN_LIMIT;
  const probe = opts.probe ?? probePort;
  const pinnedRaw = opts.pinned?.trim();

  if (pinnedRaw) {
    const pinned = Number(pinnedRaw);
    if (!Number.isInteger(pinned) || pinned <= 0 || pinned > 65535) {
      throw new Error(
        `[conformance] ${CONFORMANCE_PORT_ENV}=${pinnedRaw} is not a valid port (expected an integer 1-65535)`,
      );
    }
    const result = await probe(pinned);
    if (!result.free) {
      throw new Error(
        `[conformance] pinned port :${pinned} cannot be bound (${result.code}) — free it, or unset `
          + `${CONFORMANCE_PORT_ENV} to auto-select from ${CONFORMANCE_PORT_DEFAULT}. A pinned port is `
          + 'NEVER silently moved: the caller pinned it so both sides of the run agree on the number, '
          + 'and binding elsewhere would aim the other side at a closed port.',
      );
    }
    return { port: pinned, source: 'pinned', note: `pinned via ${CONFORMANCE_PORT_ENV}` };
  }

  for (let offset = 0; offset <= limit; offset += 1) {
    const candidate = start + offset;
    if (candidate > 65535) break;
    const result = await probe(candidate);
    if (result.free) {
      return offset === 0
        ? { port: candidate, source: 'default', note: `default; override with ${CONFORMANCE_PORT_ENV}` }
        : {
            port: candidate,
            source: 'scanned',
            note: `auto-selected — :${start} was busy (another conformance lane?); override with ${CONFORMANCE_PORT_ENV}`,
          };
    }
  }

  throw new Error(
    `[conformance] no free port in ${start}-${Math.min(start + limit, 65535)} — free one, or pin `
      + `${CONFORMANCE_PORT_ENV}. Refusing to return a busy port: the readiness probe would then be `
      + 'answered by whatever else is listening there.',
  );
}
