/**
 * Multi-cloud KMS backend dispatch (kmsBackends.ts).
 *
 * Verifies OPENWOP_BYOK_KMS_KEY routes to the right backend by shape, that the
 * AWS/Azure clients carry the stripped key handle, and that calling crypto
 * without the optional cloud SDK installed surfaces a helpful, actionable
 * error (the SDKs are NOT dev dependencies, so the dynamic import fails here —
 * which is exactly the non-using-host code path we want to exercise).
 */

import { describe, expect, it } from 'vitest';
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

// These two assert the "optional SDK is absent → actionable install error" path,
// which is ONLY reachable when the SDK genuinely isn't resolvable. In some envs
// (e.g. a fresh CI `npm ci`) `@aws-sdk/client-kms` / `@azure/keyvault-keys` are
// present transitively — there the import succeeds and the code proceeds to real
// auth/network, so the actionable-error path can't occur. Gate on actual absence
// so the check is deterministic everywhere (run when valid, skip otherwise).
// Probe via a variable specifier so tsc doesn't statically resolve the optional
// (often-uninstalled) modules — `import(name)` with a non-literal is dynamic.
const isInstalled = (name: string): Promise<boolean> => import(name).then(() => true, () => false);
const awsKmsInstalled = await isInstalled('@aws-sdk/client-kms');
const azureKvInstalled = await isInstalled('@azure/keyvault-keys');

describe('KMS backend lazy-import errors', () => {
  it.skipIf(awsKmsInstalled)('AWS encrypt without @aws-sdk/client-kms throws an actionable error', async () => {
    const client = createAwsKmsClient('arn:aws:kms:us-east-1:123:key/abc');
    await expect(client.encrypt(Buffer.alloc(32))).rejects.toThrow(/@aws-sdk\/client-kms/);
  });

  it.skipIf(azureKvInstalled)('Azure encrypt without @azure/keyvault-keys throws an actionable error', async () => {
    const client = createAzureKeyVaultKmsClient('https://v.vault.azure.net/keys/k');
    await expect(client.encrypt(Buffer.alloc(32))).rejects.toThrow(/@azure\/keyvault-keys/);
  });
});
