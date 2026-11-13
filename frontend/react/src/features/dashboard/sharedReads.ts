/**
 * Named shared reads for reads that more than one tile makes (ADR 0844), so a
 * cache key is spelled once. Each wraps an EXISTING client in `sharedRead`, so
 * two tiles on the same page cost one request.
 */
import { listChatSessions, type ChatSessionHeader } from '../../client/chatSessionsClient.js';
import { listConnections, type Connection } from '../connections/connectionsClient.js';
import { listWorkflowSummaries, type WorkflowSummaryDTO } from '../../workflows/workflowsClient.js';
import { CHAT_SESSIONS_KEY, CONNECTIONS_KEY, WORKFLOW_SUMMARIES_KEY, sharedRead } from './sharedRead.js';

export function readChatSessions(): Promise<ChatSessionHeader[]> {
  return sharedRead(CHAT_SESSIONS_KEY, () => listChatSessions());
}

export function readConnections(): Promise<Connection[]> {
  return sharedRead(CONNECTIONS_KEY, () => listConnections());
}

export function readWorkflowSummaries(): Promise<WorkflowSummaryDTO[]> {
  return sharedRead(WORKFLOW_SUMMARIES_KEY, () => listWorkflowSummaries());
}
