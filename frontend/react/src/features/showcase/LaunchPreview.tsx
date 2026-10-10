import { useState } from 'react';
import { Tabs, TabPanel } from '../../ui/Tabs.js';
import { InlineState } from '../../ui/InlineState.js';
import { record, records, strings, text, stageOutput, type Step } from './model.js';

const tabs = [{ id: 'website', label: 'Landing page' }, { id: 'emails', label: 'Emails' }, { id: 'campaign', label: 'Social' }, { id: 'strategy', label: 'Strategy' }, { id: 'review', label: 'Review' }];
export function LaunchPreview({ steps, running }: { steps: Record<string, Step>; running: boolean }) {
  const [selectedTab, setTab] = useState<string | null>(null);
  // Show the first real artifact while parallel creative work is underway.
  // Once a visitor chooses a tab, never steal that choice as events arrive.
  const tab = selectedTab ?? (Object.keys(stageOutput(steps, 'website')).length ? 'website' : Object.keys(stageOutput(steps, 'strategy')).length ? 'strategy' : 'website');
  const polished = stageOutput(steps, 'polish');
  const revised = Object.keys(polished).length > 0;
  const value = tab === 'review' ? stageOutput(steps, 'review') : revised ? record(polished[tab]) : stageOutput(steps, tab);
  const ready = Object.keys(value).length > 0;
  return <section className="launch-output" aria-label="Generated launch kit">
    <div className="launch-panel-head"><div><p className="launch-kicker">The work, as it arrives</p><h2>Your launch kit</h2></div><span className="chip chip--muted">{revised ? 'Revised draft' : 'Drafts'}</span></div>
    <Tabs items={tabs} value={tab} onChange={setTab} label="Launch deliverables" idBase="launch-artifacts" />
    <TabPanel tabId={tab} idBase="launch-artifacts">
      {!ready ? <div className="launch-await"><span className="launch-outline" aria-hidden>01 / 03</span><h3>{running ? 'Real work takes a moment.' : 'Your product. Your campaign.'}</h3><p>{running ? 'This deliverable appears when its step completes. Select another tab to see outputs already received.' : 'Run the workflow to see a landing page, three emails and a social campaign created from your brief.'}</p><InlineState kind={running ? 'loading' : 'empty'} message={running ? 'Waiting for this step’s output' : 'No generated content yet'} /></div> : null}
      {ready && tab === 'website' ? <article className="launch-site-preview"><p className="launch-kicker">{text(value.eyebrow)}</p><h3>{text(value.headline)}</h3><p className="launch-site-lede">{text(value.subheadline)}</p><span className="launch-preview-cta">{text(value.cta)}</span><div className="launch-benefits">{records(value.benefits).map((b,i) => <section key={i}><span className="launch-kicker">0{i+1}</span><h4>{text(b.title)}</h4><p>{text(b.body)}</p></section>)}</div><p className="launch-footnote">Copy preview — not a published website. The call to action above is part of the draft.</p></article> : null}
      {ready && tab === 'emails' ? <div className="launch-docs">{records(value.sequence).map((email,i) => <article className="launch-email" key={i}><p className="launch-kicker">Email {i+1}</p><h3>{text(email.subject)}</h3><p className="muted">{text(email.preview)}</p><p className="launch-preserve">{text(email.body)}</p><strong>{text(email.cta)}</strong></article>)}</div> : null}
      {ready && tab === 'campaign' ? <div className="launch-docs"><h3>{text(value.concept)}</h3><p>{text(value.visualDirection)}</p><p className="launch-footnote">Creative direction, not generated imagery.</p>{records(value.posts).map((post,i) => <article className="launch-email" key={i}><p className="launch-kicker">{text(post.channel)}</p><h3>{text(post.hook)}</h3><p className="launch-preserve">{text(post.body)}</p></article>)}</div> : null}
      {ready && tab === 'strategy' ? <div className="launch-docs"><h3>{text(value.product)}</h3><dl className="launch-strategy">{['audience','promise','positioning'].map(k => <div key={k}><dt>{k}</dt><dd>{text(value[k])}</dd></div>)}</dl><h4>Facts from the brief</h4><ul>{strings(value.proof).map((s,i) => <li key={i}>{s}</li>)}</ul><h4>Assumptions to check</h4><ul>{strings(value.assumptions).map((s,i) => <li key={i}>{s}</li>)}</ul></div> : null}
      {ready && tab === 'review' ? <div className="launch-docs"><h3>{text(value.verdict)}</h3><p className="launch-footnote">AI editorial feedback — not independent fact-checking.</p><h4>What needs work</h4><ul>{strings(value.issues).map((s,i) => <li key={i}>{s}</li>)}</ul>{revised ? <><h4>What the editor changed</h4><ul>{strings(polished.changes).map((s,i) => <li key={i}>{s}</li>)}</ul><h4>Before you launch</h4><ul>{strings(polished.checksBeforeLaunch).map((s,i) => <li key={i}>{s}</li>)}</ul></> : null}</div> : null}
    </TabPanel>
  </section>;
}
