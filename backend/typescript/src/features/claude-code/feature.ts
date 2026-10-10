/**
 * ADR 0785 — Claude Code in the app: a paired local agent host.
 *
 * P1 (this): pairing by device code, paired devices, revocation. A paired
 * device's authority IS an ordinary ADR 0270 developer key; this package adds
 * the pairing ceremony, the consent record, and a device view over those keys.
 *
 * Later phases (ADR 0785 §Phased plan): P2 the terminal relay + chat-deck tab,
 * P3 MCP tools, P4 permission prompts as approval cards, P5 RFC 0122 dispatch.
 *
 * Double-gated: the operator env `OPENWOP_CLAUDE_CODE_AT_OWN_RISK=true` AND the
 * `claude-code` toggle (default OFF, bucket `user` — a companion, its pairing and
 * its runner are personal; RFC 0122 matches by subject). A workspace admin can
 * still switch it off tenant-wide through the ordinary toggle override.
 *
 * @see docs/adr/0785-claude-code-local-agent-host.md
 */
import type { BackendFeature } from '../types.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { registerClaudeCodeApprovalPolicy } from './approvalPolicy.js';
import { CLAUDE_CODE_TOGGLE } from './constants.js';
import { eraseClaudeCodeSubjectKey } from './pairingService.js';
import { registerClaudeCodeRoutes } from './routes.js';
import { registerClaudeCodeSockets } from './terminalSockets.js';
import { registerClaudeCodeMcpNodes } from './mcpTools.js';
import { registerClaudeCodeTaskNode, registerClaudeCodeTaskRoutes } from './tasks.js';

let erasureWired = false;

export const claudeCodeFeature: BackendFeature = {
  id: CLAUDE_CODE_TOGGLE,
  registerRoutes: (deps) => {
    if (!erasureWired) {
      erasureWired = true;
      registerSubjectEraser(eraseClaudeCodeSubjectKey);
      registerClaudeCodeApprovalPolicy(); // ADR 0785 P4
    }
    registerClaudeCodeRoutes(deps);
    registerClaudeCodeSockets();
    registerClaudeCodeMcpNodes(); // ADR 0785 P3 — backing nodes for the MCP tools
    registerClaudeCodeTaskNode(); // ADR 0785 P5 — the app-dispatched task step
    registerClaudeCodeTaskRoutes(deps);
  },
  toggleDefault: {
    id: CLAUDE_CODE_TOGGLE,
    label: 'Claude Code',
    description:
      'Pair your own Claude Code (a small companion app on your machine) with this workspace. '
      + 'Requires the operator to enable it; runs on your own Claude credential, at your own risk.',
    category: 'Developer', // ADR 0820 §8.2 — sold in the Developer bundle
    status: 'off',
    bucketUnit: 'user',
    salt: 'claude-code',
  },
};
