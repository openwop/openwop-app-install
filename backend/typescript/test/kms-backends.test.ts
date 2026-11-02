/**
 * Multi-cloud KMS backend dispatch (kmsBackends.ts) — ADR 0024.
 *
 * Verifies OPENWOP_BYOK_KMS_KEY routes to the right backend by shape, that the
 * AWS/Azure clients carry the stripped key handle, and that calling crypto
 * without the optional cloud SDK surfaces a helpful, actionable error.
 *
 * TST-DKB-2 (grade-tests wave 72). The two "SDK absent" cases used to be
 * `skipIf(installed)` — and every correct tree HAS the SDKs (kms-backend-preflight
 * asserts it), so they never ran in the gate. They now FORCE absence with
 * `vi.doMock` on the package the product lazily `import()`s, and assert the
 * ACTIONABLE text (`Run \`npm install …\``), not the bare package name the raw
 * ERR_MODULE_NOT_FOUND also carries. Red when: the prefix is not stripped
 * (w72 probes kb-aws-strip / kb-azure-strip), a GCP key is claimed by a non-GCP
 * backend (kb-gcp-null), or a load failure stops being mapped to the install
 * advice (kb-aws-msg).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  matchNonGcpKmsBackend,
  createAwsKmsClient,
  createAzureKeyVaultKmsClient,
  AWS_KMS_PREFIX,
  AZURE_KEYVAULT_PREFIX,
} from '../src/byok/kmsBackends.js';

describe('KMS backend dispatch', () => {
  it('routes an aws-kms: key to the AWS backend', () => {
    const client = matchNonGcpKmsBackend(`${AWS_KMS_PREFIX}arn:aws:kms:us-east-1:123:key/abc`);
    expect(client).not.toBeNull();
    // keyName() carries the handle with the prefix stripped.
    expect(client?.keyName()).toBe('arn:aws:kms:us-east-1:123:key/abc');
  });

  it('routes an azure-keyvault: key to the Azure backend', () => {
    const url = 'https://v.vault.azure.net/keys/k';
    const client = matchNonGcpKmsBackend(`${AZURE_KEYVAULT_PREFIX}${url}`);
    expect(client).not.toBeNull();
    expect(client?.keyName()).toBe(url);
  });

  it('returns null for a GCP-shaped key (caller falls back to GCP)', () => {
    expect(
      matchNonGcpKmsBackend('projects/p/locations/l/keyRings/r/cryptoKeys/k'),
    ).toBeNull();
  });

  it('returns null for an unrecognized key shape', () => {
    expect(matchNonGcpKmsBackend('not-a-key')).toBeNull();
  });
});

describe('KMS backend lazy-import errors', () => {
  afterEach(() => {
    vi.doUnmock('@aws-sdk/client-kms');
    vi.doUnmock('@azure/keyvault-keys');
  });

  it('AWS encrypt without @aws-sdk/client-kms throws an actionable error', async () => {
    vi.doMock('@aws-sdk/client-kms', () => { throw new Error('w72: forced AWS SDK load failure'); });
    const client = createAwsKmsClient('arn:aws:kms:us-east-1:123:key/abc');
    await expect(client.encrypt(Buffer.alloc(32))).rejects.toThrow(/Run `npm install @aws-sdk\/client-kms`/);
  });

  it('Azure encrypt without @azure/keyvault-keys throws an actionable error', async () => {
    vi.doMock('@azure/keyvault-keys', () => { throw new Error('w72: forced Azure SDK load failure'); });
    const client = createAzureKeyVaultKmsClient('https://v.vault.azure.net/keys/k');
    await expect(client.encrypt(Buffer.alloc(32))).rejects.toThrow(/Run `npm install @azure\/keyvault-keys @azure\/identity`/);
  });
});
