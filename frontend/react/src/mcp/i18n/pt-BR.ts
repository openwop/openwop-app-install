/**
 * `mcp` namespace — user-facing copy for the MCP tools panel (RFC 0020) and
 * the MCP browser client's user-facing error fallback.
 */
export const messages = {
  title: 'Ferramentas MCP',
  probing: 'Sondando a costura MCP do host…',
  disabledPrefix: 'Este host não expõe um ponto de montagem de servidor MCP (',
  disabledSuffix:
    ' está desligado). Quando ativado, o host anuncia aqui seus workflows registrados como ferramentas MCP.',
  noToolsAdvertised: 'A montagem MCP está ativada, mas nenhuma ferramenta é anunciada.',
  inputSchema: 'esquema de entrada',
  endpointReturned: 'O endpoint MCP retornou {{status}}',
  jsonRpcError: 'Erro de JSON-RPC',
} as const;
