/**
 * Test servers do not close an idle keep-alive socket under the test.
 *
 * ~900 test files boot a server with `app.listen(0, …)` and talk to it with the
 * global `fetch`, which pools sockets. Node's default `keepAliveTimeout` is 5s
 * (about 6s in effect: this Node adds ~1s of grace),
 * and the server and the client share ONE event loop here. So when a test does
 * more than 5s of SYNCHRONOUS work between two requests (CPU-bound renders,
 * or any test at all on a starved machine), the server's timer fires the moment
 * the loop resumes and closes the pooled socket; the next request reuses it and
 * dies with `fetch failed` / ECONNRESET in milliseconds (undici does not retry
 * a POST). It reads as a load timeout and is not one: `creative-briefs-render`
 * failed this way for months before #4295 named it.
 *
 * #4295 fixed that one file with `connection: close`. This closes the class at
 * the one place every file shares — the listen call — instead of sweeping each
 * client. The timeout is set BEFORE the original `listen` runs, so a test that
 * assigns its own `server.keepAliveTimeout` afterwards still wins.
 *
 * Production is untouched: this file is a vitest `setupFiles` entry only.
 * Witness: `test/test-server-keepalive.test.ts` blocks past the old 5s limit.
 */
import http from 'node:http';

/** Longer than any synchronous stretch a test could survive its own timeout with. */
export const TEST_SERVER_KEEP_ALIVE_MS = 10 * 60_000;

/** Node's default `keepAliveTimeout`: the bound teardown used to get for free. */
const DEFAULT_KEEP_ALIVE_MS = 5_000;

const PATCHED = Symbol.for('openwop.test.serverKeepAlive');
const proto = http.Server.prototype as http.Server & { [PATCHED]?: true };

if (!proto[PATCHED]) {
  const listen = proto.listen;
  proto.listen = function patchedListen(this: http.Server, ...args: unknown[]) {
    this.keepAliveTimeout = TEST_SERVER_KEEP_ALIVE_MS;
    return (listen as (...a: unknown[]) => http.Server).apply(this, args);
  } as typeof proto.listen;

  // The other half of the same change. `server.close()` reaps idle sockets ONCE,
  // at the call. Anything still open then — a request in flight, or a finished
  // exchange Node does not count as idle (a handler that never read the request
  // body) — used to be destroyed by the 5s keep-alive. With the keep-alive
  // lifted it would hold `close` open until the hook timed out (measured: two
  // files' `afterAll` hit 30s). So a closing server (a) keeps reaping idle
  // sockets, and (b) after the OLD 5s bound drops whatever is left, which is
  // when the old timer would have. A request in flight at close() still gets
  // those 5s to finish.
  const close = proto.close;
  proto.close = function patchedClose(this: http.Server, cb?: (err?: Error) => void) {
    const result = close.call(this, cb);
    const reap = setInterval(() => this.closeIdleConnections(), 50);
    const drop = setTimeout(() => this.closeAllConnections(), DEFAULT_KEEP_ALIVE_MS);
    reap.unref();
    drop.unref();
    this.once('close', () => { clearInterval(reap); clearTimeout(drop); });
    return result;
  } as typeof proto.close;
  proto[PATCHED] = true;
}
