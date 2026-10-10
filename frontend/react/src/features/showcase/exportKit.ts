import { record, records, strings, text, type Step } from './model.js';

/** Reuse the approval renderer's inline-evidence lane. Only a completed output
 * on the persisted gate's direct artifact edge qualifies; no guessed stage IDs
 * or fixture content. This is the same run-log content displayed in the tabs. */
export function approvalPreview(definition: Record<string, unknown> | null, steps: Record<string, Step>, nodeId: string, data: unknown): unknown {
  const edge = records(definition?.edges).find(e => e.targetNodeId === nodeId && e.targetInput === 'artifact');
  if (!edge || edge.sourceOutput !== 'data') return data;
  const source = steps[text(edge.sourceNodeId)];
  const kit = record(source?.output).data;
  if (source?.status !== 'completed' || !record(kit).website) return data;
  const node = records(definition?.nodes).find(n => n.nodeId === nodeId);
  return { ...record(data), prompt: text(record(node?.config).title) || 'Review this launch kit before handoff.', options: [{ key:'recorded-launch-kit', label:'Revised launch kit · recorded workflow output', content:kitMarkdown(kit) }] };
}

/** A usable text handoff, rendered from the approved artifact only. */
export function kitMarkdown(value: unknown): string {
  const kit = record(value), strategy = record(kit.strategy), site = record(kit.website);
  const bullets = (v: unknown) => strings(v).map(s => `- ${s}`).join('\n');
  return [
    `# ${text(strategy.product) || 'Your launch kit'}`,
    'AI-generated drafts. Verify the checks below before publishing.',
    '## Strategy', `Audience: ${text(strategy.audience)}`, text(strategy.promise), text(strategy.positioning),
    '### Facts from the brief', bullets(strategy.proof), '### Assumptions', bullets(strategy.assumptions),
    '## Landing page', text(site.eyebrow), `### ${text(site.headline)}`, text(site.subheadline), `Call to action: ${text(site.cta)}`,
    ...records(site.benefits).flatMap(b => [`### ${text(b.title)}`, text(b.body)]),
    '## Email sequence', ...records(record(kit.emails).sequence).flatMap((e,i) => [`### ${i+1}. ${text(e.subject)}`, `Preview: ${text(e.preview)}`, text(e.body), `Call to action: ${text(e.cta)}`]),
    '## Social campaign', text(record(kit.campaign).concept), `Creative direction: ${text(record(kit.campaign).visualDirection)}`,
    ...records(record(kit.campaign).posts).flatMap(p => [`### ${text(p.channel)} — ${text(p.hook)}`, text(p.body)]),
    '## Editorial changes', bullets(kit.changes), '## Checks before launch', bullets(kit.checksBeforeLaunch),
  ].join('\n\n') + '\n';
}
