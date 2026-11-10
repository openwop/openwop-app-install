/** Actual backend integration over bounded IPC, never a backend TS import.
 * Backend helper is checked by backend tsconfig; this client by FE test types. */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const MAX_BYTES = 1_048_576;
// Vitest uses its unchanged 5s default; stop the owned child before that budget.
const TIMEOUT_MS = 4_000;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function callContract(request: { command: 'expand-kernel' } | { command: 'validate'; definition: unknown } | { command: 'build-inputs'; definition: unknown; target: string; outputs: Record<string, Record<string, unknown>> }): Promise<Record<string, unknown>> {
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_BYTES) throw new Error('Builder contract request exceeds limit');
  const backend = resolve(process.cwd(), '../../backend/typescript');
  const helper = join(backend, 'test/support/builderContractProcess.ts');
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', NODE_ENV: 'test', OPENWOP_LOG_LEVEL: 'error' };
    // Preserve only present resource guards; never forward the parent's secrets.
    for (const key of ['NODE_OPTIONS', 'GOMEMLIMIT', 'GOGC', 'GOMAXPROCS', 'UV_THREADPOOL_SIZE', 'RAYON_NUM_THREADS']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const child = spawn(process.execPath, ['--import', 'tsx', helper], {
      cwd: backend, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env,
    });
    let reply: Record<string, unknown> | undefined;
    let failure: Error | undefined;
    let stderr = '';
    const timer = setTimeout(() => { failure = new Error('Builder contract helper timed out'); child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.on('message', (value: unknown) => {
      if (reply || !isRecord(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) {
        failure = new Error('Invalid builder contract response'); child.kill('SIGKILL'); return;
      }
      reply = value;
    });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (code !== 0 || !reply || reply.ok !== true) {
        reject(new Error(`Builder contract helper failed: ${typeof reply?.error === 'string' ? reply.error : stderr || `exit ${code}`}`)); return;
      }
      resolve(reply);
    });
    child.send(request, error => { if (error) { failure = error; child.kill('SIGKILL'); } });
  });
}
interface ContractEdge { sourceNodeId: string; targetNodeId: string; sourceOutput?: string | undefined; targetInput?: string | undefined }
interface KernelDefinition { nodes: Array<{ nodeId: string; typeId: string }>; edges: ContractEdge[] }
function isContractEdges(value: unknown): value is ContractEdge[] {
  return Array.isArray(value) && value.every(e => isRecord(e) && typeof e.sourceNodeId === 'string' && typeof e.targetNodeId === 'string'
    && (e.sourceOutput === undefined || typeof e.sourceOutput === 'string') && (e.targetInput === undefined || typeof e.targetInput === 'string'));
}
function isKernelDefinition(value: unknown): value is KernelDefinition {
  return isRecord(value) && Array.isArray(value.nodes) && value.nodes.every(n => isRecord(n) && typeof n.nodeId === 'string' && typeof n.typeId === 'string') && isContractEdges(value.edges);
}
export async function expandKernelForBuilder(): Promise<{ definition: KernelDefinition; order: string[] }> {
  const reply = await callContract({ command: 'expand-kernel' });
  if (!isKernelDefinition(reply.definition) || !Array.isArray(reply.order) || !reply.order.every(id => typeof id === 'string')) throw new Error('Invalid expanded kernel response');
  return { definition: reply.definition, order: reply.order };
}
export async function validateBuilderDefinition(definition: unknown): Promise<{ metadata: unknown; edges: ContractEdge[] }> {
  const reply = await callContract({ command: 'validate', definition });
  if (!isContractEdges(reply.edges)) throw new Error('Invalid validated edge response');
  return { metadata: reply.metadata, edges: reply.edges };
}

/** Only the real pure scheduler input projection; never executes a node. */
export async function projectBuilderInputs(definition: unknown, target: string, outputs: Record<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
  const reply = await callContract({ command: 'build-inputs', definition, target, outputs });
  if (!isRecord(reply.inputs)) throw new Error('Invalid projected input response');
  return reply.inputs;
}
