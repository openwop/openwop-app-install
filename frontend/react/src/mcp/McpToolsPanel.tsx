/**
 * McpToolsPanel — lists the MCP tools the connected host advertises
 * (RFC 0020), via a `tools/list` JSON-RPC call. Embedded on the
 * Capabilities page as another host-discovery surface.
 *
 * The host's MCP mount is opt-in (`OPENWOP_MCP_SERVER_ENABLED`), so the
 * panel renders a clear "not enabled" state rather than an error when
 * the seam is off.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listMcpTools, type McpTool } from './mcpClient.js';

export function McpToolsPanel() {
  const { t } = useTranslation('mcp');
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'disabled' } | { status: 'error'; message: string } | { status: 'ready'; tools: McpTool[] }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    listMcpTools().then((r) => {
      if (cancelled) return;
      if (!r.enabled) setState({ status: 'disabled' });
      else if (r.error) setState({ status: 'error', message: r.error });
      else setState({ status: 'ready', tools: r.tools });
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="card">
      <h2>{t('title')}</h2>
      {state.status === 'loading' && <div className="muted">{t('probing')}</div>}
      {state.status === 'disabled' && (
        <p className="muted u-fs-13">
          {t('disabledPrefix')}<code>OPENWOP_MCP_SERVER_ENABLED</code>{t('disabledSuffix')}
        </p>
      )}
      {state.status === 'error' && <div className="alert error">{state.message}</div>}
      {state.status === 'ready' && state.tools.length === 0 && (
        <p className="muted u-fs-13">{t('noToolsAdvertised')}</p>
      )}
      {state.status === 'ready' && state.tools.length > 0 && (
        <ul className="mcp-tool-list">
          {state.tools.map((tool) => (
            <li key={tool.name} className="mcp-tool">
              <div className="mcp-tool-head">
                <code className="mcp-tool-name">{tool.name}</code>
              </div>
              {tool.description && <p className="mcp-tool-desc muted">{tool.description}</p>}
              {tool.inputSchema && Object.keys(tool.inputSchema).length > 0 && (
                <details>
                  <summary className="muted">{t('inputSchema')}</summary>
                  <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
