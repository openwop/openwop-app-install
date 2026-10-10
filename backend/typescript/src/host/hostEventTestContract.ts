/**
 * RFC 0241 §B.1 — does the INSTALLED contract define `POST /host/events/test`
 * (`emitTestHostEvent`)? This host lists the reserved `host-test.*` types, and so
 * serves the trigger, only when it does. Listing the type IS the claim (§B.1);
 * reading the vendored `schemas/v2/path-manifest.json` keeps the claim tied to the
 * contract this build ships, so the trigger lights up with the corpus pin bump
 * (2.45.26+) and never ahead of it. Same rule as the v2 reference host
 * (openwop-examples #160). Read once: the manifest is part of the build.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from './_repoPath.js';

export const HOST_EVENT_TEST_TRIGGER_PATH = '/host/events/test';

let defined: boolean | undefined;

export function hostEventTestTriggerDefined(): boolean {
  if (defined === undefined) {
    try {
      const manifest = join(locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'), 'v2', 'path-manifest.json');
      defined = readFileSync(manifest, 'utf8').includes(`"${HOST_EVENT_TEST_TRIGGER_PATH}"`);
    } catch {
      // No manifest is no contract: claim nothing rather than guess.
      defined = false;
    }
  }
  return defined;
}
