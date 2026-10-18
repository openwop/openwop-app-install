/**
 * PERMANENT SHIM — never delete this file (ADR 0873 D2).
 *
 * Push used to register a worker at this URL. Browsers keep updating an
 * installed worker by refetching its script URL, and on this host a missing
 * file is answered by the `**` rewrite with `200 text/html`: the update would
 * fail and the old worker would run forever. So this URL stays, and loads the
 * one generated worker. `scripts/check-sw-permanence.mjs` fails the build if
 * either file is missing or is not JavaScript.
 *
 * The next `register()` from the app uses `SW_URL` (`src/sw/swUrl.ts`) at the
 * same scope, which moves the registration to `/sw.js` with its push
 * subscription intact (ADR 0873 Verification 4).
 */
importScripts('/sw.js');
