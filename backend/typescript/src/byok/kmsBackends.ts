/**
 * Multi-cloud KMS backends behind the provider-neutral `KmsClient` interface
 * (kmsEncryption.ts). Each cloud's SDK is an OPTIONAL dependency, dynamically
 * imported on first use via a non-literal specifier so typecheck/build stay
 * green and a non-using host never installs it.
 *
 * `OPENWOP_BYOK_KMS_KEY` selects the backend by shape:
 *   GCP    projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>
 *   AWS    aws-kms:arn:aws:kms:<region>:<acct>:key/<id>   (or aws-kms:<key-id>)
 *   Azure  azure-keyvault:https://<vault>.vault.azure.net/keys/<key>[/<version>]
 *
 * The envelope scheme (kmsEncryption.ts) only needs each backend to wrap and
 * unwrap a 32-byte DEK; AWS uses Encrypt/Decrypt, Azure uses wrapKey/unwrapKey
 * (RSA-OAEP-256), GCP uses encrypt/decrypt.
 */

// Type-only import — erased at compile time, so there is no runtime edge back
// to kmsEncryption.ts and no import cycle. The GCP-aware dispatch lives in
// kmsEncryption.ts::bootstrapKmsFromEnv, which calls matchNonGcpKmsBackend().
import type { KmsClient } from './kmsEncryption.js';

export const AWS_KMS_PREFIX = 'aws-kms:';
export const AZURE_KEYVAULT_PREFIX = 'azure-keyvault:';

/**
 * Resolve a non-GCP `OPENWOP_BYOK_KMS_KEY` to its KmsClient, or null when the
 * key isn't an AWS/Azure handle (the caller then tries the GCP shape). Keeps
 * this module free of any dependency on the GCP factory.
 */
export function matchNonGcpKmsBackend(keyName: string): KmsClient | null {
  if (keyName.startsWith(AWS_KMS_PREFIX)) {
    return createAwsKmsClient(keyName.slice(AWS_KMS_PREFIX.length));
  }
  if (keyName.startsWith(AZURE_KEYVAULT_PREFIX)) {
    return createAzureKeyVaultKmsClient(keyName.slice(AZURE_KEYVAULT_PREFIX.length));
  }
  return null;
}

/**
 * AWS KMS — symmetric Encrypt/Decrypt of the DEK. The `@aws-sdk/client-kms`
 * package is loaded lazily. Region is parsed from the ARN when present so the
 * SDK does not depend on AWS_REGION being set; a bare key-id falls back to the
 * ambient SDK region resolution.
 */
export function createAwsKmsClient(keyId: string): KmsClient {
  const region = parseAwsRegion(keyId);
  interface AwsKms {
    send(cmd: unknown): Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array }>;
  }
  interface AwsKmsModule {
    KMSClient: new (cfg: { region?: string }) => AwsKms;
    EncryptCommand: new (input: { KeyId: string; Plaintext: Uint8Array }) => unknown;
    DecryptCommand: new (input: { KeyId: string; CiphertextBlob: Uint8Array }) => unknown;
  }
  let modPromise: Promise<{ mod: AwsKmsModule; client: AwsKms }> | null = null;
  function getClient() {
    if (!modPromise) {
      const pkg = '@aws-sdk/client-kms';
      modPromise = import(pkg)
        // import() of a non-literal specifier yields `any`, so the typed
        // assignment needs no cast (the optional package has no compile-time
        // types here by design — see the module header).
        .then((m): { mod: AwsKmsModule; client: AwsKms } => {
          const mod: AwsKmsModule = m;
          return { mod, client: new mod.KMSClient({ region }) };
        })
        .catch((err) => {
          throw new Error(
            `OPENWOP_BYOK_KMS_KEY selects AWS KMS but the optional @aws-sdk/client-kms ` +
              `package is not installed. Run \`npm install @aws-sdk/client-kms\`. ` +
              `Underlying error: ${(err as Error).message}`,
          );
        });
    }
    return modPromise;
  }
  return {
    keyName: () => keyId,
    // ADR 0024 follow-up: resolve the SDK without a KMS round-trip, so boot can
    // tell whether this backend could ever work.
    preflight: async () => { await getClient(); },
    async encrypt(plaintextDek) {
      const { mod, client } = await getClient();
      const resp = await client.send(new mod.EncryptCommand({ KeyId: keyId, Plaintext: plaintextDek }));
      if (!resp.CiphertextBlob) throw new Error('AWS KMS encrypt returned empty ciphertext');
      return Buffer.from(resp.CiphertextBlob);
    },
    async decrypt(wrappedDek) {
      const { mod, client } = await getClient();
      const resp = await client.send(new mod.DecryptCommand({ KeyId: keyId, CiphertextBlob: wrappedDek }));
      if (!resp.Plaintext) throw new Error('AWS KMS decrypt returned empty plaintext');
      return Buffer.from(resp.Plaintext);
    },
  };
}

/**
 * Azure Key Vault — wrapKey/unwrapKey (RSA-OAEP-256) over the DEK. Auth uses
 * DefaultAzureCredential (managed identity on Container Apps / env creds in
 * dev). `@azure/keyvault-keys` + `@azure/identity` are loaded lazily.
 */
/**
 * Why this is not just `"…are not installed"`.
 *
 * `@azure/keyvault-keys` + `@azure/identity` are declared `optionalDependencies`,
 * and npm does not reliably install the transitive `dependencies` OF an optional
 * dependency. Observed on npm 11.6.2: both Azure packages install, but
 * `@azure/core-rest-pipeline` and `@azure/core-client` — which they `require` —
 * do not, so `import('@azure/identity')` fails with ERR_MODULE_NOT_FOUND on a
 * package the operator never named. (npm then wants to REWRITE the lockfile to
 * record that incomplete tree, which is how this surfaced.)
 *
 * In that state the old message was actively misleading: it told the operator to
 * run `npm install @azure/keyvault-keys @azure/identity`, which npm considers
 * already satisfied, so the advice does nothing and the operator is left with an
 * error that names the wrong problem. Name the module that is ACTUALLY missing.
 *
 * Exported for the test — the branch matters more than the string.
 */
export function azureLoadFailureMessage(err: unknown, keysPkg: string, idPkg: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const missing = /Cannot find package '([^']+)'/.exec(message)?.[1];
  // A missing package that is NOT one of the two we asked for means the Azure
  // packages themselves are present but their dependency tree is incomplete.
  if (missing && missing !== keysPkg && missing !== idPkg) {
    return (
      `OPENWOP_BYOK_KMS_KEY selects Azure Key Vault. \`${keysPkg}\` and \`${idPkg}\` ARE ` +
      `installed, but their dependency \`${missing}\` is not — npm does not always install ` +
      `the transitive dependencies of an optionalDependency, which leaves the Azure backend ` +
      `present but unloadable. Install the missing package explicitly: ` +
      `\`npm install ${missing}\`. Underlying error: ${message}`
    );
  }
  return (
    `OPENWOP_BYOK_KMS_KEY selects Azure Key Vault but the optional ` +
    `${keysPkg} / ${idPkg} packages are not installed. Run ` +
    `\`npm install ${keysPkg} ${idPkg}\`. ` +
    `Underlying error: ${message}`
  );
}

export function createAzureKeyVaultKmsClient(keyUrl: string): KmsClient {
  const ALGO = 'RSA-OAEP-256' as const;
  interface AzureCrypto {
    wrapKey(algo: string, key: Uint8Array): Promise<{ result: Uint8Array }>;
    unwrapKey(algo: string, encryptedKey: Uint8Array): Promise<{ result: Uint8Array }>;
  }
  let clientPromise: Promise<AzureCrypto> | null = null;
  function getClient() {
    if (!clientPromise) {
      const keysPkg = '@azure/keyvault-keys';
      const idPkg = '@azure/identity';
      clientPromise = Promise.all([import(keysPkg), import(idPkg)])
        .then(([keys, identity]): AzureCrypto => {
          // Both modules are `any` (non-literal dynamic import); typed locals,
          // no cast.
          const k: { CryptographyClient: new (keyUrl: string, cred: unknown) => AzureCrypto } = keys;
          const id: { DefaultAzureCredential: new () => unknown } = identity;
          return new k.CryptographyClient(keyUrl, new id.DefaultAzureCredential());
        })
        .catch((err) => {
          throw new Error(azureLoadFailureMessage(err, keysPkg, idPkg));
        });
    }
    return clientPromise;
  }
  return {
    keyName: () => keyUrl,
    // ADR 0024 follow-up. This is the backend the deferral actually bit: the
    // Azure dependency tree can be incomplete while the two named packages are
    // present, so "configured" meant nothing until something tried to use it.
    preflight: async () => { await getClient(); },
    async encrypt(plaintextDek) {
      const client = await getClient();
      const resp = await client.wrapKey(ALGO, plaintextDek);
      if (!resp.result) throw new Error('Azure Key Vault wrapKey returned empty result');
      return Buffer.from(resp.result);
    },
    async decrypt(wrappedDek) {
      const client = await getClient();
      const resp = await client.unwrapKey(ALGO, wrappedDek);
      if (!resp.result) throw new Error('Azure Key Vault unwrapKey returned empty result');
      return Buffer.from(resp.result);
    },
  };
}

/** Parse the region out of a KMS ARN (`arn:aws:kms:<region>:...`); undefined for a bare key-id. */
function parseAwsRegion(keyId: string): string | undefined {
  const m = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):/.exec(keyId);
  return m ? m[1] : undefined;
}
