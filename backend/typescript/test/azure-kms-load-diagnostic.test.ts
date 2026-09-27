/**
 * The Azure KMS loader must not tell an operator to run a command that cannot help.
 *
 * `@azure/keyvault-keys` + `@azure/identity` are optionalDependencies, and npm does
 * not reliably install the transitive `dependencies` OF an optional dependency
 * (observed on npm 11.6.2: both Azure packages present, `@azure/core-rest-pipeline`
 * absent, so `import('@azure/identity')` throws ERR_MODULE_NOT_FOUND naming a
 * package the operator never chose). In that state the old message said the two
 * Azure packages "are not installed" and advised installing them — which npm treats
 * as already satisfied. The advice did nothing and named the wrong problem.
 */
import { describe, it, expect } from 'vitest';
import { azureLoadFailureMessage } from '../src/byok/kmsBackends.js';

const KEYS = '@azure/keyvault-keys';
const ID = '@azure/identity';

describe('Azure KMS load failure diagnostics', () => {
  it('names the ACTUAL missing transitive dep, not the packages the operator asked for', () => {
    const err = new Error(
      "Cannot find package '@azure/core-rest-pipeline' imported from /app/node_modules/@azure/identity/dist/index.js",
    );

    const msg = azureLoadFailureMessage(err, KEYS, ID);

    expect(msg).toContain('@azure/core-rest-pipeline');
    expect(msg).toContain('npm install @azure/core-rest-pipeline');
    // The misleading claim must be gone: these two ARE installed in this state.
    expect(msg).not.toContain(`npm install ${KEYS} ${ID}`);
    expect(msg).toContain('ARE installed');
  });

  it('still gives the plain advice when the Azure packages themselves are absent', () => {
    const err = new Error(`Cannot find package '${KEYS}' imported from /app/src/byok/kmsBackends.js`);

    const msg = azureLoadFailureMessage(err, KEYS, ID);

    expect(msg).toContain(`npm install ${KEYS} ${ID}`);
    expect(msg).not.toContain('ARE installed');
  });

  it('falls back to the plain advice for an unrecognised failure', () => {
    // e.g. a syntax error or a native-binding failure — no package name to extract.
    const msg = azureLoadFailureMessage(new Error('Unexpected token'), KEYS, ID);

    expect(msg).toContain(`npm install ${KEYS} ${ID}`);
    expect(msg).toContain('Unexpected token');
  });

  it('preserves the underlying error in every branch (never swallows the cause)', () => {
    const cases: unknown[] = [
      new Error("Cannot find package '@azure/core-client' imported from /x"),
      new Error(`Cannot find package '${ID}' imported from /x`),
      'a bare string rejection',
    ];
    for (const err of cases) {
      const msg = azureLoadFailureMessage(err, KEYS, ID);
      expect(msg).toContain('Underlying error:');
      expect(msg).toContain(err instanceof Error ? err.message : String(err));
    }
  });
});
