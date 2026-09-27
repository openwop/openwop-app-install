/**
 * P4 continuation — the CORE-routed page spotlights (one triple per P0
 * render case). Feature-routed pages register from their own routes module
 * instead (the ownership idiom). Consumed by corePacks + the coverage test.
 */
export const CORE_PAGE_SPOTLIGHTS: ReadonlyArray<readonly [string, string, string]> = [
  ['boards.page.view', '/boards', 'boards.page'],
  ['workforces.page.view', '/workforces', 'workforces.page'],
  ['agent-templates.page.view', '/agents/templates', 'agent-templates.page'],
  ['roster.page.view', '/roster', 'roster.page'],
  ['prompts.page.view', '/prompts', 'prompts.page'],
  ['memory.page.view', '/memory', 'memory.page'],
  ['capabilities.page.view', '/capabilities', 'capabilities.page'],
  ['cli.page.view', '/cli', 'cli.page'],
  ['feature-toggles.page.view', '/feature-toggles', 'feature-toggles.page'],
  ['orgs.page.view', '/orgs', 'orgs.page'],
  ['example-data.page.view', '/example-data', 'example-data.page'],
];
