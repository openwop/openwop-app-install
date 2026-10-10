import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { TextareaField } from '../../ui/Field.js';
import { Notice, PageHeader, StateCard } from '../../ui/index.js';
import { announce } from '../../ui/announce.js';
import { PlayIcon, CheckIcon, PauseIcon, SparklesIcon, DownloadIcon } from '../../ui/icons/index.js';
import { GraphSurface, type GraphSurfaceLabels } from '../../canvas/graph/GraphSurface.js';
import { downloadBlob } from '../../canvas/exportUtils.js';
import { getActiveConfig, type ActiveConfigEnvelope } from '../../byok/lib/byokClient.js';
import { instantiateChain } from '../../builder/persistence/backendStore.js';
import { createRun, cancelRun } from '../../client/runsClient.js';
import { onAuthChange } from '../../client/config.js';
import { RenderInterrupt } from '../../interrupts/RenderInterrupt.js';
import { LaunchPreview } from './LaunchPreview.js';
import { approvalPreview, kitMarkdown } from './exportKit.js';
import { useShowcaseRun } from './useShowcaseRun.js';
import { CHAIN_ID, graphOf, projectSteps, record, stageOf, text, terminal, type StepStatus } from './model.js';

const sampleBrief = 'Launch Fieldnote, a pocket-sized voice recorder for independent consultants. Turn a conversation into searchable notes and a draft follow-up, without typing during the meeting. It works offline while recording; transcription happens after syncing. Target consultants who lose billable time reconstructing client conversations. Tone: calm, sharp, practical. Invite people to join the early-access list. Do not invent prices, testimonials, performance metrics, privacy certifications or an availability date.';
const labels: GraphSurfaceLabels = { surface: 'Live launch workflow. Select a step to inspect it.', connectFrom: '', connectTo: '', cancelConnect: '', connectArmed: '', connected: '', deletedEdge: '', home: 'Start', empty: 'No workflow steps available', addConnected: '', edgeSelected: 'Dependency from {from} to {to}', deviceFrame: 'Frame', minimap: 'Workflow overview' };
const chip: Record<StepStatus, string> = { queued:'muted', running:'accent', completed:'success', failed:'danger', waiting:'warning', skipped:'muted', cancelled:'danger' };
const detail: Record<string, string> = { strategy:'Audience + positioning', website:'A complete landing-page draft', emails:'Three launch emails', campaign:'Concept + three social posts', review:'Claims + consistency check', polish:'Specific corrections applied', approval:'You control the handoff', deliver:'Approved, ready to download', rejected:'No approved handoff' };

/** Remount content on identity transitions so prior-tenant results cannot linger. */
export function ShowcasePage() {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => onAuthChange(() => setEpoch(n => n+1)), []);
  return <ShowcaseSession key={epoch} />;
}

function ShowcaseSession() {
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');
  const run = useShowcaseRun(runId);
  const [brief, setBrief] = useState(sampleBrief);
  const [connection, setConnection] = useState<ActiveConfigEnvelope | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionNonce, setConnectionNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [edge, setEdge] = useState<string | null>(null);
  const attempt = useRef<{ workflowId: string; credentialRef: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setConnection(null); setConnectionError(null);
    getActiveConfig().then(c => { if (current) setConnection(c); }).catch(e => { if (current) setConnectionError(String(e)); });
    return () => { current = false; };
  }, [connectionNonce]);
  const steps = useMemo(() => projectSteps(run.events), [run.events]);
  const status = run.snapshot?.status ?? (runId ? 'loading' : 'ready');
  const finished = terminal(status);
  const statusLabel = ({ 'waiting-approval':'Waiting for your decision', running:'Running', pending:'Queued', completed:'Completed', failed:'Failed', cancelled:'Stopped', loading:'Loading' } as Record<string,string>)[status] ?? status;
  const graph = useMemo(() => graphOf(run.definition, steps, finished), [run.definition, steps, finished]);
  const ready = !!connection?.valid && !!connection.config && connection.config.provider !== 'mock' && !connection.config.credentialRef.startsWith('managed:');
  const approvedEntry = Object.entries(steps).find(([id]) => stageOf(id) === 'deliver')?.[1];
  const approvedKit = approvedEntry?.status === 'completed' ? record(approvedEntry.output).value : undefined;
  const rejected = Object.entries(steps).some(([id, step]) => stageOf(id) === 'rejected' && step.status === 'completed');
  const selectedStep = selected ? steps[selected] : undefined;
  const current = graph.nodes.filter(n => steps[n.id]?.status === 'running' || steps[n.id]?.status === 'waiting');
  const completedCount = Object.values(steps).filter(s => s.status === 'completed').length;
  const savedWorkflowId = run.snapshot?.workflowId ?? workflowId;
  const announcement = current.map(n => n.label).join('. ');
  useEffect(() => { if (announcement) announce(announcement); }, [announcement]);

  async function start() {
    if (inFlight.current || (!attempt.current && (!ready || brief.trim().length < 20))) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      if (!attempt.current) {
        // Recheck the server binding at dispatch; never substitute a provider.
        const fresh = await getActiveConfig();
        if (!fresh.valid || !fresh.config || fresh.config.provider === 'mock' || fresh.config.credentialRef.startsWith('managed:')) throw new Error('Connect a workflow AI provider before starting. Free chat does not supply workflow credentials.');
        const created = await instantiateChain(CHAIN_ID, { brief: brief.trim(), provider: fresh.config.provider, model: fresh.config.model });
        if (!alive.current) return;
        setWorkflowId(created.workflowId);
        if (created.warnings?.length || created.incompleteNodes?.length) throw new Error('The workflow was saved, but this host is missing required nodes or configuration. Open the workflow to inspect it.');
        attempt.current = { workflowId: created.workflowId, credentialRef: fresh.config.credentialRef, key: crypto.randomUUID() };
      }
      const a = attempt.current;
      const created = await createRun({ workflowId: a.workflowId, configurable: { version: 1, ai: { credentialRef: a.credentialRef } } }, { idempotencyKey: a.key });
      if (!alive.current) return;
      attempt.current = null;
      setParams({ run: created.runId });
      announce('Launch workflow started.');
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function stop() {
    if (!runId || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await cancelRun(runId, 'Stopped from launch showcase'); run.refresh(); }
    catch (e) { if (alive.current) setError(String(e)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  function download() {
    if (!approvedKit) return;
    downloadBlob(new Blob([kitMarkdown(approvedKit)], { type:'text/markdown;charset=utf-8' }), 'launch-kit.md');
  }

  return <div className="launch-showcase" lang="en">
    <PageHeader eyebrow="A real workflow. A real deliverable." title={<>One brief.<br /><span className="launch-title-accent">An entire launch.</span></>} lede="Watch specialist steps turn your product idea into a landing page, emails and a social campaign. Then challenge the work—and decide what leaves the workflow." actions={<Link to="/builder" className="inline-link">Explore the workflow builder</Link>} />
    {!runId ? <section className="launch-brief surface-card" aria-label="Launch brief">
      <div><p className="launch-kicker">01 / Give it a worthwhile job</p><h2>What are you launching?</h2><p>Start with the fictional Fieldnote brief, or make it yours. The results are generated from what you write.</p><p className="launch-footnote">Six AI steps; validation and transport retries can add calls. Your provider’s usage charges apply. Your brief and generated drafts are sent to that provider and saved with the workflow. Nothing is published or emailed.</p></div>
      <div><TextareaField label="Product brief" rows={6} maxLength={6000} minLength={20} value={brief} disabled={busy || !!attempt.current} onChange={e => setBrief(e.target.value)} />
        <div className="action-bar"><Button variant="accent-solid" onClick={() => void start()} disabled={busy || (!attempt.current && (!ready || brief.trim().length < 20))} loading={busy}><PlayIcon size={16}/>{busy ? 'Starting…' : attempt.current ? 'Retry this run request' : 'Build my launch kit'}</Button><span className="launch-footnote">{ready ? `${connection?.config?.provider} / ${connection?.config?.model}` : 'Workflow AI connection required'}</span></div>
        {connectionError ? <StateCard announce title="Could not check your AI connection" body="Its readiness is unknown; no workflow has been started." action={<Button variant="secondary" onClick={() => setConnectionNonce(n=>n+1)}>Check again</Button>} /> : connection && !ready ? <Notice variant="info">Connect a model provider in <Link to="/keys" className="inline-link">Keys</Link>, then <Button variant="link" onClick={() => setConnectionNonce(n=>n+1)}>check the connection</Button>. The free chat tier does not run these workflow steps.</Notice> : null}
      </div>
    </section> : null}
    {error ? <Notice variant="error" announce={error}>{error} {savedWorkflowId ? <Link className="inline-link" to={`/builder/${encodeURIComponent(savedWorkflowId)}`}>Open saved workflow</Link> : <Link className="inline-link" to="/workflows">Check saved workflows before starting again</Link>}</Notice> : null}
    {run.error ? <StateCard announce title="Could not refresh this run" body={<>The view may be out of date; this does not mean the workflow failed. {run.error}</>} action={<Button variant="secondary" onClick={run.refresh}>Refresh run</Button>} /> : null}
    {run.snapshot?.error ? <Notice variant="error" announce={`The workflow stopped: ${run.snapshot.error.message}`}>The workflow stopped: {run.snapshot.error.message}. Completed drafts remain available below.</Notice> : null}
    <section className="launch-workspace" aria-label="Workflow and deliverables">
      <div className="launch-flow">
        <div className="launch-panel-head"><div><p className="launch-kicker">02 / Watch the work happen</p><h2>{runId ? finished ? 'Run finished' : 'Your launch, in motion' : 'Meet your launch workflow'}</h2></div><span className={`chip chip--${status === 'failed' ? 'danger' : status === 'cancelled' || rejected || status === 'waiting-approval' ? 'warning' : finished ? 'success' : 'muted'}`}>{runId ? statusLabel : 'Not started'}</span></div>
        <div className="launch-runbar"><span>{runId ? `${completedCount} steps completed · ${finished ? 'Recorded run' : run.connected ? 'Live events' : 'Refreshing from the run log'}` : 'Strategy → parallel creation → review → your decision'}</span>{runId && !finished ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void stop()}>Stop run</Button> : null}</div>
        {runId && !finished && current.length ? <p className="launch-active-work">Now: {current.map(n => text(record(n.data).name)).join(" + ")}</p> : null}
        <div className="launch-graph">
          <GraphSurface nodes={graph.nodes} edges={graph.edges} nodeSize={{ w:200, h:105 }} readOnly renderNode={n => {
            const d = record(n.data); const state = text(d.status) as StepStatus;
            return <div className={`launch-node launch-node--${state}`}><span className={`chip chip--${chip[state] ?? 'muted'}`}>{state === 'completed' ? <CheckIcon size={13}/> : state === 'waiting' ? <PauseIcon size={13}/> : <SparklesIcon size={13}/>} {state}</span><p>{detail[text(d.stage)] ?? text(d.name)}</p></div>;
          }} selectedNodeId={selected} selectedEdgeId={edge} onSelectNode={setSelected} onSelectEdge={setEdge} onMoveNode={() => {}} onActivateNode={setSelected} onAnnounce={(message, politeness) => announce(message, { assertive: politeness === 'assertive' })} labels={labels}/>
        </div>
        <div className="launch-step-summary">{selected ? <><strong>{graph.nodes.find(n => n.id === selected)?.label}</strong><p>{detail[stageOf(selected)]}</p>{selectedStep?.status === 'completed' && runId ? <Link className="inline-link" to={`/runs/${encodeURIComponent(runId)}#node-${encodeURIComponent(selected)}`}>Inspect this step’s recorded output</Link> : null}</> : <p>Select any step to inspect it. Drag the background to pan; use the zoom controls to explore.</p>}</div>
        <details className="launch-step-list"><summary>All workflow steps</summary><ol>{graph.nodes.map(n=><li key={n.id}><Button variant="link" onClick={()=>setSelected(n.id)}>{n.label}</Button></li>)}</ol></details>
      </div>
      <LaunchPreview steps={steps} running={!!runId && !finished}/>
    </section>
    {runId && run.interrupts.length ? <section className="launch-decision"><p className="launch-kicker">03 / You have the final say</p><h2>The workflow waits for you.</h2><p>Inspect the revised drafts and editorial review above. Approve to release the download, or reject the kit. Neither action publishes anything.</p>{run.interrupts.map(active => <RenderInterrupt key={active.interruptId} runId={runId} active={{ ...active, data:approvalPreview(run.definition, steps, active.nodeId, active.data) }} onResolved={run.refresh}/>)}</section> : null}
    {rejected ? <Notice variant="info" announce="You rejected this kit. No approved handoff was created.">You rejected this kit. Drafts remain available for inspection; no approved handoff was created.</Notice> : null}
    {approvedKit ? <section className="launch-handoff surface-card"><div><p className="launch-kicker">Your decision. Your deliverables.</p><h2>Your launch kit is ready.</h2><p>The human-approved kit includes your strategy, landing page, email sequence, social copy and editorial changes.</p></div><Button variant="accent-solid" onClick={download}><DownloadIcon size={16}/> Download launch kit</Button></section> : null}
    {runId ? <div className="action-bar launch-links"><Link className="inline-link" to={`/runs/${encodeURIComponent(runId)}`}>Inspect the full run</Link>{savedWorkflowId ? <Link className="inline-link" to={`/builder/${encodeURIComponent(savedWorkflowId)}`}>Make this workflow your own</Link> : null}{finished ? <Button variant="secondary" onClick={()=>{ setParams({}); setSelected(null); setWorkflowId(null); }}>Start another launch</Button> : null}</div> : null}
    <footer className="launch-explainer"><strong>This is what OpenWOP makes visible.</strong><p>One workflow coordinates specialist steps, carries their outputs forward, records what happened and pauses for a human decision. The app runs it; the protocol defines how clients and hosts communicate about the work.</p></footer>
  </div>;
}
