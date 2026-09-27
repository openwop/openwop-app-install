/**
 * `mcp` namespace — user-facing copy for the MCP tools panel (RFC 0020) and
 * the MCP browser client's user-facing error fallback.
 */
export const messages = {
  title: 'MCP tools',
  probing: 'Probing host MCP seam…',
  disabledPrefix: 'The MCP server is disabled on this deployment. An operator can enable it with the ',
  disabledSuffix:
    ' deployment setting. Once enabled, registered workflows are advertised as MCP tools here.',
  noToolsAdvertised: 'MCP mount is enabled, but no tools are advertised.',
  inputSchema: 'input schema',
  endpointReturned: 'MCP endpoint returned {{status}}',
  jsonRpcError: 'JSON-RPC error',
} as const;
