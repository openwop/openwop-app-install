/**
 * Daemon-status body (`routes/daemonStatus.ts`) — TST-CUA-2.
 *
 * The CLI's `demo {status,stop,restart}` and `doctor` read this host-extension
 * route as their readiness signal: pid, when the process started, how long it has
 * been up, and the observation time as the liveness marker.
 *
 * Red when `lastHeartbeat` is stamped from anything but the observation time, or
 * when the derived `startTime` stops subtracting `process.uptime()` from `now`.
 * `process.uptime()` is stubbed so both are exact and independent of worker age.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDaemonStatus } from '../src/routes/daemonStatus.js';

const config = {
  port: 18199,
  storageDsn: 'memory://',
  serviceName: 'daemon-status-test',
  serviceVersion: '0.0.1',
  enableConsoleTracer: false,
};

const NOW = Date.UTC(2026, 4, 26, 12, 0, 0); // 2026-05-26T12:00:00.000Z

afterEach(() => { vi.restoreAllMocks(); });

describe('daemon status route', () => {
  it('reports pid / startTime / uptimeSeconds / lastHeartbeat', () => {
    vi.spyOn(process, 'uptime').mockReturnValue(7.9);
    const body = buildDaemonStatus({ config, startTimeMs: NOW - 5000 }, NOW);
    expect(body).toEqual({
      app: { name: 'workflow-engine', serviceName: 'daemon-status-test', serviceVersion: '0.0.1' },
      pid: process.pid,
      startTime: '2026-05-26T11:59:55.000Z',
      uptimeSeconds: 7,
      lastHeartbeat: '2026-05-26T12:00:00.000Z',
    });
  });

  it('derives startTime from process.uptime() when not supplied', () => {
    vi.spyOn(process, 'uptime').mockReturnValue(42.7);
    const body = buildDaemonStatus({ config }, NOW);
    expect(body['uptimeSeconds']).toBe(42);
    expect(body['startTime']).toBe('2026-05-26T11:59:18.000Z'); // NOW − 42 s
  });
});
