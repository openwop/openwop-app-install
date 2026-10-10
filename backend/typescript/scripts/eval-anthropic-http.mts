/** Manual model gates must never score transport failures as negative verdicts.
 * Error messages contain no key, request text, response body or provider error.
 */
export class EvalInfrastructureError extends Error {
  constructor(readonly code: 'http' | 'network' | 'timeout' | 'response', status?: number) {
    super(`Model evaluation aborted: ${code}${status === undefined ? '' : ` (HTTP ${status})`}. No quality score is valid.`);
    this.name = 'EvalInfrastructureError';
  }
}

export async function requestEvalText(
  input: { apiKey: string; model: string; maxTokens: number; system: string; user: string },
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const controller = new AbortController();
  // Cover both receiving headers and reading the response body.
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000);
  try {
    const response = await (deps.fetchImpl ?? fetch)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: input.model, max_tokens: input.maxTokens, system: input.system, messages: [{ role: 'user', content: input.user }] }),
    });
    if (!response.ok) throw new EvalInfrastructureError('http', response.status);
    let envelope: unknown;
    try { envelope = await response.json(); }
    catch { throw new EvalInfrastructureError(controller.signal.aborted ? 'timeout' : 'response'); }
    if (typeof envelope !== 'object' || envelope === null) throw new EvalInfrastructureError('response');
    const message = envelope as Record<string, unknown>;
    if (message.type !== 'message' || !Array.isArray(message.content) || message.content.length === 0) {
      throw new EvalInfrastructureError('response');
    }
    const parts: string[] = [];
    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) throw new EvalInfrastructureError('response');
      const part = block as Record<string, unknown>;
      if (part.type !== 'text' || typeof part.text !== 'string') throw new EvalInfrastructureError('response');
      parts.push(part.text);
    }
    // Successful malformed model output is still scored by the real parser.
    return parts.join('');
  } catch (error) {
    if (error instanceof EvalInfrastructureError) throw error;
    throw new EvalInfrastructureError(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}
