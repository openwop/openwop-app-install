/**
 * `mcp` namespace — user-facing copy for the MCP tools panel (RFC 0020) and
 * the MCP browser client's user-facing error fallback.
 */
export const messages = {
  title: 'Herramientas MCP',
  probing: 'Sondeando la conexión MCP del host…',
  disabledPrefix: 'El servidor MCP está desactivado en esta implementación. Un operador puede activarlo con el ajuste ',
  disabledSuffix:
    '. Una vez activado, los flujos de trabajo registrados se anuncian aquí como herramientas MCP.',
  noToolsAdvertised: 'El montaje MCP está habilitado, pero no se anuncia ninguna herramienta.',
  inputSchema: 'esquema de entrada',
  endpointReturned: 'El extremo MCP devolvió {{status}}',
  jsonRpcError: 'Error de JSON-RPC',
} as const;
