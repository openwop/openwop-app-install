/**
 * Editor-doc validation for `canvas.document` working copies (ADR 0334 Phase 1).
 * A `canvas.document` state is `{ title, content }` where `content` is a
 * ProseMirror document node (the TipTap engine's canonical JSON). The FRONTEND
 * engine enforces the full schema; this backend guard is a light STRUCTURAL +
 * DoS check so a malformed or oversized PATCH fails closed (422) rather than
 * persisting garbage or exhausting memory on a later read/render (the ADR 0328
 * import-DoS lesson): bound the total node count and nesting depth, and require
 * the ProseMirror node shape (`{ type: string, content?: [], text?: string,
 * marks?: [], attrs?: {} }`). Hard errors reject the PATCH; no soft warnings.
 */

export interface DocumentValidation {
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

/** Bounds (DoS guards). A large document is legitimate, so these are generous
 *  but finite — a runaway/adversarial payload is rejected, not persisted. */
export const MAX_TITLE = 400;
export const MAX_NODES = 50_000;
export const MAX_DEPTH = 100;
/** Per-embed HTML cap (ADR 0334 2b-3) — the sandboxed frame truncates at render,
 *  but bound the stored attr too so a persisted doc can't be bloated arbitrarily. */
export const MAX_EMBED_HTML = 512_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function validateDocumentDoc(state: Record<string, unknown>): DocumentValidation {
  const errors: { path: string; message: string }[] = [];
  const err = (path: string, message: string): void => { errors.push({ path, message }); };

  if (state.title !== undefined && (typeof state.title !== 'string' || state.title.length > MAX_TITLE)) {
    err('title', `title must be a string of at most ${MAX_TITLE} characters`);
  }

  const content = state.content;
  if (!isObj(content)) {
    err('content', 'content must be a ProseMirror document node ({ type: "doc", ... })');
    return { errors, warnings: [] };
  }
  if (content.type !== 'doc') {
    err('content.type', 'the root content node must have type "doc"');
  }

  // Bounded recursive structural walk (node count + depth guarded).
  let count = 0;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (errors.length > 20) return; // stop early — the client only needs the first errors
    if (depth > MAX_DEPTH) { err(path, `content nesting exceeds ${MAX_DEPTH} levels`); return; }
    if (!isObj(node)) { err(path, 'each content node must be an object'); return; }
    if (typeof node.type !== 'string' || !node.type) { err(`${path}.type`, 'each node needs a non-empty string type'); return; }
    if (++count > MAX_NODES) { err('content', `document exceeds the ${MAX_NODES}-node limit`); return; }
    if (node.text !== undefined && typeof node.text !== 'string') err(`${path}.text`, 'node text must be a string');
    if (node.attrs !== undefined && !isObj(node.attrs)) err(`${path}.attrs`, 'node attrs must be an object');
    if (node.type === 'embedBlock' && isObj(node.attrs) && typeof node.attrs.html === 'string' && node.attrs.html.length > MAX_EMBED_HTML) {
      err(`${path}.attrs.html`, `embed HTML exceeds the ${MAX_EMBED_HTML}-character limit`);
    }
    if (node.marks !== undefined && !Array.isArray(node.marks)) err(`${path}.marks`, 'node marks must be an array');
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) { err(`${path}.content`, 'node content must be an array'); return; }
      node.content.forEach((child, i) => walk(child, `${path}.content[${i}]`, depth + 1));
    }
  };
  walk(content, 'content', 0);

  return { errors, warnings: [] };
}
