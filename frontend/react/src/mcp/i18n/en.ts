/**
 * `mcp` namespace — user-facing copy for the MCP tools panel (RFC 0020) and
 * the MCP browser client's user-facing error fallback.
 */
export const messages = {
  title: 'MCP tools',
  probing: 'Probing host MCP seam…',
  disabledPrefix: "This host doesn't expose an MCP server mount (",
  disabledSuffix:
    ' is off). When enabled, the host advertises its registered workflows as MCP tools here.',
  noToolsAdvertised: 'MCP mount is enabled, but no tools are advertised.',
  inputSchema: 'input schema',
  endpointReturned: 'MCP endpoint returned {{status}}',
  jsonRpcError: 'JSON-RPC error',
} as const;
