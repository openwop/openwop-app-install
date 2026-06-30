/**
 * `mcp` namespace — user-facing copy for the MCP tools panel (RFC 0020) and
 * the MCP browser client's user-facing error fallback.
 */
export const messages = {
  title: 'Outils MCP',
  probing: 'Sondage de la jonction MCP de l\'hôte…',
  disabledPrefix: 'Cet hôte n\'expose pas de montage de serveur MCP (',
  disabledSuffix:
    ' est désactivé). Une fois activé, l\'hôte présente ses workflows enregistrés comme outils MCP ici.',
  noToolsAdvertised: 'Le montage MCP est activé, mais aucun outil n\'est présenté.',
  inputSchema: 'schéma d\'entrée',
  endpointReturned: 'Le point de terminaison MCP a renvoyé {{status}}',
  jsonRpcError: 'Erreur JSON-RPC',
} as const;
