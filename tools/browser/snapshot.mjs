// ARIA snapshot parser for Playwright
// Parses locator.ariaSnapshot() output and assigns @ref IDs to elements

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox',
  'option', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
  'menu', 'listbox', 'dialog',
]);

const SKIP_ROLES = new Set(['document', 'generic', 'none', 'presentation']);

/**
 * Parse Playwright ARIA snapshot text and annotate with @ref IDs.
 *
 * @param {string} snapshotText - Raw ariaSnapshot() output
 * @param {{ interactive?: boolean }} options
 * @returns {{ annotated: string, refs: Array<{ id: string, role: string, name: string|null, nthIndex: number }> }}
 */
export function parseAriaSnapshot(snapshotText, options = {}) {
  const lines = snapshotText.split('\n');
  const refs = [];
  let refCounter = 1;
  const roleCounts = new Map(); // "role::name" -> count (for nth disambiguation)
  const annotatedLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('-')) {
      annotatedLines.push(line);
      continue;
    }

    const parsed = parseLine(line);
    if (!parsed || SKIP_ROLES.has(parsed.role)) {
      annotatedLines.push(line);
      continue;
    }

    const isInteractive = INTERACTIVE_ROLES.has(parsed.role);
    const shouldRef = options.interactive ? isInteractive : true;

    if (shouldRef) {
      const key = `${parsed.role}::${parsed.name || ''}`;
      const count = roleCounts.get(key) || 0;
      roleCounts.set(key, count + 1);

      const refId = `e${refCounter++}`;
      refs.push({
        id: refId,
        role: parsed.role,
        name: parsed.name,
        nthIndex: count,
      });

      annotatedLines.push(`${line}  <- @${refId}`);
    } else {
      annotatedLines.push(line);
    }
  }

  return { annotated: annotatedLines.join('\n'), refs };
}

/**
 * Parse a single ARIA snapshot line.
 * Format: "  - role \"name\" [attrs]: text"
 */
function parseLine(line) {
  // Remove leading whitespace and "- " prefix
  let content = line.replace(/^\s*-\s+/, '');
  if (!content) return null;

  // Playwright wraps lines with special chars in single quotes — strip them
  if (content.startsWith("'") && content.includes("':")) {
    content = content.slice(1, content.lastIndexOf("':"));
  } else if (content.startsWith("'")) {
    content = content.replace(/^'|'$/g, '');
  }

  // Role is the first word (may contain hyphens)
  const roleMatch = content.match(/^([\w-]+)/);
  if (!roleMatch) return null;

  const role = roleMatch[1];
  const nameMatch = content.match(/"([^"]*)"/);
  const name = nameMatch ? nameMatch[1] : null;

  return { role, name };
}
