/**
 * `mcp` namespace — user-facing copy for the MCP tools panel (RFC 0020) and
 * the MCP browser client's user-facing error fallback.
 */
export const messages = {
  title: 'Herramientas MCP',
  probing: 'Sondeando la conexión MCP del host…',
  disabledPrefix: 'Este host no expone un montaje de servidor MCP (',
  disabledSuffix:
    ' está desactivado). Cuando se habilite, el host anunciará aquí sus flujos de trabajo registrados como herramientas MCP.',
  noToolsAdvertised: 'El montaje MCP está habilitado, pero no se anuncia ninguna herramienta.',
  inputSchema: 'esquema de entrada',
  endpointReturned: 'El extremo MCP devolvió {{status}}',
  jsonRpcError: 'Error de JSON-RPC',
} as const;
