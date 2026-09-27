/**
 * `mcp` namespace — user-facing copy for the MCP tools panel (RFC 0020) and
 * the MCP browser client's user-facing error fallback.
 */
export const messages = {
  title: 'Ferramentas MCP',
  probing: 'Sondando a costura MCP do host…',
  disabledPrefix: 'O servidor MCP está desativado nesta implantação. Um operador pode ativá-lo com a configuração ',
  disabledSuffix:
    '. Uma vez ativado, os fluxos de trabalho registrados são anunciados aqui como ferramentas MCP.',
  noToolsAdvertised: 'A montagem MCP está ativada, mas nenhuma ferramenta é anunciada.',
  inputSchema: 'esquema de entrada',
  endpointReturned: 'O endpoint MCP retornou {{status}}',
  jsonRpcError: 'Erro de JSON-RPC',
} as const;
