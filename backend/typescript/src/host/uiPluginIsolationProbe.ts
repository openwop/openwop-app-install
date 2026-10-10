/**
 * ADR 0493 / ADR 0840 — the isolation self-test's probe document.
 *
 * First-party and tiny. It is SERVED the way a plugin frame is served (the same
 * `pluginFrameCsp` header, mounted by `src` under the same `sandbox` attribute),
 * so the self-test exercises the boundary plugins actually get, including any
 * proxy in front of the host. It carries no `<meta>` policy of its own: a meta
 * tag would hold even if the header were stripped, and the header is what
 * RFC 0238 makes the boundary.
 *
 * It reports what it observes and never asserts a verdict; the host page decides.
 *
 * Egress (ADR 0840 correction): the probe used to fetch `https://example.invalid/`,
 * which never resolves, so the fetch rejected with or without a policy and the leg
 * passed vacuously. It now counts as blocked only when the browser fires
 * `securitypolicyviolation` for the fetch, which only an enforced policy does.
 */
export const ISOLATION_PROBE_HTML = `<!doctype html><html><head><title>isolation probe</title></head><body><script>
(function () {
  function send(m) { parent.postMessage(Object.assign({ probe: 'openwop-isolation' }, m), '*'); }
  // Leg 1 — ISOLATED: with allow-scripts and NO allow-same-origin the document is
  // an opaque origin, so origin serializes as "null".
  try { send({ leg: 'isolated', origin: String(window.origin) }); }
  catch (e) { send({ leg: 'isolated', origin: 'threw: ' + String(e) }); }
  // Leg 2 — EGRESS-DENIED: only a policy violation counts as blocked.
  var reported = false;
  function report(m) { if (!reported) { reported = true; send(m); } }
  document.addEventListener('securitypolicyviolation', function (ev) {
    report({ leg: 'egress', blocked: true, note: 'blocked by ' + ev.violatedDirective });
  });
  try {
    fetch('https://example.com/openwop-egress-probe', { mode: 'no-cors' })
      .then(function () { report({ leg: 'egress', blocked: false, note: 'fetch resolved' }); })
      .catch(function (e) {
        // Give the violation event a turn to arrive before calling it a network failure.
        setTimeout(function () { report({ leg: 'egress', blocked: false, note: 'fetch failed without a policy violation: ' + String(e && e.name || e) }); }, 250);
      });
  } catch (e) { report({ leg: 'egress', blocked: false, note: 'threw without a policy violation: ' + String(e) }); }
})();
</script></body></html>`;
