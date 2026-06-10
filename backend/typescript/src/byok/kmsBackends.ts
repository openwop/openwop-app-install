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
          throw new Error(
            `OPENWOP_BYOK_KMS_KEY selects Azure Key Vault but the optional ` +
              `@azure/keyvault-keys / @azure/identity packages are not installed. Run ` +
              `\`npm install @azure/keyvault-keys @azure/identity\`. ` +
              `Underlying error: ${(err as Error).message}`,
          );
        });
    }
    return clientPromise;
  }
  return {
    keyName: () => keyUrl,
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
