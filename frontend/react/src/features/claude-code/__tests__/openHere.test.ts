/**
 * ADR 0785 D5 (corrected) — "Open in Claude Code" rides the palette's
 * route-aware seam: offered on a workflow, a run or an app-builder canvas, and
 * nowhere else; it links to a deck tab carrying a context that tells Claude Code
 * to READ the thing over MCP before changing it.
 */
import { describe, it, expect } from 'vitest';
import { claudeCodeLaunchFor } from '../routes.js';
import { routeCommandsFor } from '../../../ui/commandContributions.js';

describe('Open in Claude Code', () => {
  it('matches the pages where work lives, and only those', () => {
    expect(claudeCodeLaunchFor('/builder/wf_1')?.context).toMatch(/workflow wf_1.*Read it/);
    expect(claudeCodeLaunchFor('/runs/run_9')?.context).toMatch(/run run_9/);
    expect(claudeCodeLaunchFor('/app-builder/cv_2')?.context).toMatch(/app-builder canvas cv_2/);
    expect(claudeCodeLaunchFor('/builder')).toBeNull();
    expect(claudeCodeLaunchFor('/runs/run_9/audit')).toBeNull();
    expect(claudeCodeLaunchFor('/chat')).toBeNull();
  });

  it('the palette offers it on a workflow page as a gated link into a new deck tab', () => {
    const cmds = routeCommandsFor('/builder/wf_1').filter((c) => c.featureId === 'claude-code');
    expect(cmds).toHaveLength(1);
    const to = new URL(cmds[0]!.to, 'http://x');
    expect(to.pathname).toBe('/chat');
    expect(to.searchParams.get('newTab')).toBe('claude-code');
    expect(to.searchParams.get('tabContext')).toMatch(/workflow wf_1/);
    expect(routeCommandsFor('/dashboard').filter((c) => c.featureId === 'claude-code')).toEqual([]);
  });
});
