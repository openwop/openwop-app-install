/**
 * @openwop/cli — installation, quickstart, and command catalog.
 *
 * This page is the in-app surface for discovering the OpenWOP CLI: how to
 * install it, how to point it at this host, and what every subcommand does.
 * Linked from the homepage hero (see site/src/build.mjs) and the header nav.
 *
 * Static-content page (no API calls) so it renders identically against any
 * host, including hosts that haven't deployed CLI-specific endpoints yet.
 */

import type { ReactNode } from 'react';
import { PageHeader } from './ui/PageHeader.js';
import { DataTable, type DataColumn } from './ui/DataTable.js';
import { IconButton } from './ui/IconButton.js';
import { toast } from './ui/toast.js';
import {
  ClipboardIcon,
  LinkIcon,
  PlugIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  TerminalIcon,
} from './ui/icons/index.js';

const INSTALL_CMD = 'npm install -g @openwop/cli';
const CLI_REPO = 'https://github.com/openwop/openwop-cli';

function copy(text: string, label = 'Command copied'): void {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success(label))
    .catch(() => {
      /* clipboard blocked */
    });
}

function Cmd({ children }: { children: string }) {
  return <code>{children}</code>;
}

/** A shell snippet with a one-click copy affordance (the page's core job). */
function CommandBlock({ children, copyLabel }: { children: string; copyLabel?: string }) {
  return (
    <div className="u-flex u-flex-col u-gap-1">
      <div className="u-flex u-justify-end">
        <IconButton
          label="Copy command"
          className="btn-ghost btn-sm"
          icon={<ClipboardIcon size={15} />}
          onClick={() => copy(children, copyLabel)}
        />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** One row of the command catalog. */
interface CatalogEntry {
  group: string;
  commands: string[];
  description: ReactNode;
}

const CATALOG: CatalogEntry[] = [
  {
    group: 'onboard',
    commands: ['--non-interactive'],
    description: <>Stores a tenant API key + writes <Cmd>~/.openwop/config.json</Cmd>.</>,
  },
  {
    group: 'doctor',
    commands: ['--json'],
    description: <>Connectivity + auth + advertised capability check; non-zero exit on hard failure.</>,
  },
  {
    group: 'capabilities',
    commands: [],
    description: <>Print this host's <Cmd>/.well-known/openwop</Cmd> document.</>,
  },
  {
    group: 'runs',
    commands: ['create', 'get', 'events', 'annotations', 'debug-bundle'],
    description: (
      <>
        Submit a workflow run, stream its events (<Cmd>values</Cmd>/<Cmd>updates</Cmd>/
        <Cmd>messages</Cmd>/<Cmd>debug</Cmd>), and pull the diagnostic bundle.
      </>
    ),
  },
  {
    group: 'prompts',
    commands: ['list', 'render'],
    description: <>Browse the host's prompt library and render a template with variables locally.</>,
  },
  {
    group: 'memory',
    commands: ['list', 'get', 'write'],
    description: <>Inspect and write tenant-scoped agent memory (with SR-1 redaction).</>,
  },
  {
    group: 'agents',
    commands: ['list', 'get', 'dispatch'],
    description: <>List the host's manifest-runtime agent inventory and dispatch directly.</>,
  },
  {
    group: 'interrupts',
    commands: ['list', 'resume'],
    description: <>Browse open HITL interrupts and answer them via the signed-token callback.</>,
  },
  {
    group: 'messaging',
    commands: ['connectors', 'routing', 'policy', 'pairing', 'allowlist', 'logs'],
    description: (
      <>
        Manage the messaging relay-gateway: list connectors, route a channel + peer to a workflow or
        agent, enforce pairing + allowlist + mention policy.
      </>
    ),
  },
  {
    group: 'relay',
    commands: ['signal', 'imessage', 'whatsapp', 'discord'],
    description: <>Run a channel-adapter daemon locally that bridges the named channel into this host (non-normative host extension).</>,
  },
  {
    group: 'notifications',
    commands: ['list', 'ack'],
    description: <>Read + acknowledge the per-tenant inbox feed.</>,
  },
  {
    group: 'proposals',
    commands: ['list', 'get', 'revise', 'apply', 'reject', 'archive'],
    description: (
      <>
        Reviewable-learning proposal lifecycle (RFC 0096): an agent's learned change lands{' '}
        <strong>inert</strong>; a human applies it through the host's activation gate. The CLI never
        activates locally.
      </>
    ),
  },
  {
    group: 'goals',
    commands: ['list', 'get', 'create', 'pause', 'resume', 'abandon'],
    description: (
      <>
        Standing goals (RFC 0097): a durable objective the host pursues across runs until a{' '}
        <strong>judge</strong> verdicts it satisfied or a <strong>bound</strong> stops it. Completion
        is the judge's verdict — no <Cmd>satisfy</Cmd> verb.
      </>
    ),
  },
  {
    group: 'export / import',
    commands: ['--kinds', '--dry-run'],
    description: (
      <>
        Agent-platform portability (RFC 0098): move reusable estate between hosts as a{' '}
        <strong>refs-only</strong> bundle — <Cmd>--dry-run</Cmd> plan, then idempotent apply. Never
        carries secret values.
      </>
    ),
  },
  {
    group: 'triggers',
    commands: ['list', 'get', 'register'],
    description: (
      <>
        External-event trigger subscriptions (RFC 0099): bind a <strong>webhook / email / form</strong>{' '}
        source to a workflow; the host verifies, dedups, and runs the durable delivery state machine. A
        binding secret is shown <strong>once</strong> at creation — the CLI renders the fingerprint only.
      </>
    ),
  },
  {
    group: 'a2a',
    commands: ['status', 'task'],
    description: (
      <>
        Async / durable A2A tasks (RFC 0100): read a backing run's persisted <Cmd>A2ATaskState</Cmd>{' '}
        (<Cmd>taskId === runId</Cmd>) that survives caller disconnect, host restart, and HITL pauses. The
        record is content-free; the durable read needs <Cmd>a2a.durableTasks</Cmd>.
      </>
    ),
  },
  {
    group: 'approvals',
    commands: ['list', 'get', 'claim', 'reject'],
    description: <>The human side of "agents propose, humans dispose" — resolve the host's policy-gated approval inbox.</>,
  },
  {
    group: 'governance',
    commands: ['policy', 'audit'],
    description: <>Read/set tenant policy (provider allowlist, per-action mode, retention) + the tenant audit log. The group is also invocable as <Cmd>openwop policy</Cmd>.</>,
  },
  {
    group: 'consent',
    commands: ['policy', 'records', 'get', 'erase'],
    description: <>Tenant-scoped, region-aware consent + GDPR erasure (public + authed surfaces).</>,
  },
  {
    group: 'toggles',
    commands: ['list', 'get'],
    description: <>Render the host-resolved feature-toggle / variant assignments for the caller (render-only; the host is the authority).</>,
  },
  {
    group: 'users',
    commands: ['list', 'get', 'create', 'disable', 'me'],
    description: <>Tenant identity directory + account lifecycle.</>,
  },
  {
    group: 'profiles',
    commands: ['get', 'edit', 'skills', 'endorse'],
    description: <>Self-service persona / skills / portfolio.</>,
  },
  {
    group: 'auth',
    commands: ['status', 'saml', 'scim'],
    description: <>Enterprise SSO / SAML / SCIM config — refs only, secrets never printed (alias <Cmd>sso</Cmd>).</>,
  },
  {
    group: 'mcp',
    commands: ['info', 'tools', 'resources', 'prompts'],
    description: <>JSON-RPC MCP client for the host's server mount (RFC 0020).</>,
  },
  {
    group: 'connections',
    commands: ['list', 'test', 'authorize', 'oauth-clients'],
    description: <>Inspect third-party connections + OAuth client config — refs only (alias <Cmd>conn</Cmd>).</>,
  },
  {
    group: 'workforces',
    commands: ['list', 'metrics', 'governance', 'status'],
    description: <>Durable multi-agent orchestration + graduated-autonomy governance posture (alias <Cmd>fleet</Cmd>).</>,
  },
  {
    group: 'analytics',
    commands: ['summary', 'events', 'collect'],
    description: <>Org-scoped usage / cost / observability (alias <Cmd>usage</Cmd>).</>,
  },
  {
    group: 'cron',
    commands: ['list', 'add', 'enable', 'disable', 'remove'],
    description: <>Scheduled jobs (RFC 0052) — enable/disable a schedule + a <Cmd>--roster</Cmd> filter.</>,
  },
];

const CATALOG_COLUMNS: DataColumn<CatalogEntry>[] = [
  {
    key: 'group',
    header: 'Group',
    width: '160px',
    render: (row) => <span className="chip chip--accent">{row.group}</span>,
  },
  {
    key: 'commands',
    header: 'Commands',
    width: '34%',
    render: (row) =>
      row.commands.length === 0 ? (
        <span className="muted">—</span>
      ) : (
        <span className="u-iflex u-gap-1 u-wrap">
          {row.commands.map((c) => (
            <span key={c} className="chip chip--muted">{c}</span>
          ))}
        </span>
      ),
  },
  {
    key: 'description',
    header: 'What it does',
    render: (row) => row.description,
  },
];

/** One channel-adapter card in the relay grid. */
interface Adapter {
  name: string;
  icon: ReactNode;
  note: ReactNode;
  command: string;
}

const ADAPTERS: Adapter[] = [
  {
    name: 'Signal',
    icon: <PlugIcon size={18} />,
    note: <><Cmd>signal-cli</Cmd> must be installed and registered separately.</>,
    command: 'openwop relay signal --account +15555550100',
  },
  {
    name: 'iMessage',
    icon: <MessageSquareIcon size={18} />,
    note: <>macOS host with Messages access; bridges your local iMessage account.</>,
    command: 'openwop relay imessage',
  },
  {
    name: 'WhatsApp',
    icon: <MessageCircleIcon size={18} />,
    note: <><Cmd>npm install @whiskeysockets/baileys</Cmd>; first run prompts a QR scan.</>,
    command: 'openwop relay whatsapp',
  },
  {
    name: 'Discord',
    icon: <TerminalIcon size={18} />,
    note: <><Cmd>npm install discord.js</Cmd>; provide <Cmd>DISCORD_TOKEN</Cmd>.</>,
    command: 'DISCORD_TOKEN=… openwop relay discord',
  },
];

export function CliPage() {
  return (
    <section className="cli-page page-stack">
      <PageHeader
        eyebrow="CLI"
        title="OpenWOP CLI"
        lede={<>The <Cmd>openwop</Cmd> command operates this host (and any OpenWOP-compatible host) from the terminal — auth onboarding, capabilities discovery, run submission + streaming, prompts + memory + agents, channel messaging, governance + identity + portability, and host doctor. Every command is <strong>capability-gated</strong>: it drives only what the host advertises at <Cmd>/.well-known/openwop</Cmd> and fails closed otherwise.</>}
        actions={
          <>
            <button
              type="button"
              className="btn-primary u-iflex u-gap-1"
              onClick={() => copy(INSTALL_CMD, 'Install command copied')}
            >
              <ClipboardIcon size={15} /> Copy install command
            </button>
            <a className="btn-ghost u-iflex u-gap-1" href={CLI_REPO}>
              <LinkIcon size={15} /> Source &amp; issues
            </a>
          </>
        }
      />

      <section id="install" className="surface-card u-gap-3">
        <h2>Install</h2>
        <p>Global (recommended for daily use):</p>
        <CommandBlock copyLabel="Install command copied">{`npm install -g @openwop/cli
openwop --version`}</CommandBlock>
        <p>One-off (no install) — useful in CI or scratch shells:</p>
        <CommandBlock>{`npx -y @openwop/cli@latest --help`}</CommandBlock>
        <p className="muted">
          Requires Node ≥ 20. Channel adapters for Discord and WhatsApp are
          declared as <em>optional</em> peer dependencies; install them only
          if you actually use those channels.
        </p>
      </section>

      <section id="point-at-host" className="surface-card u-gap-3">
        <h2>Point it at this host</h2>
        <p>
          The CLI reads <Cmd>OPENWOP_BASE_URL</Cmd> (or <Cmd>--base-url</Cmd>)
          and <Cmd>OPENWOP_API_KEY</Cmd> (or the interactive onboard flow).
          Against this deployment:
        </p>
        <CommandBlock>{`export OPENWOP_BASE_URL=https://app.openwop.dev/api
openwop onboard           # interactive auth + key issuance
openwop doctor            # check connectivity + capability surface
openwop capabilities      # read /.well-known/openwop`}</CommandBlock>
      </section>

      <section id="new-capabilities" className="surface-card u-gap-3">
        <h2>New: agent-platform capabilities</h2>
        <p>
          The latest CLI adds command groups for the host's agent-platform
          surfaces — governance &amp; safety (<Cmd>approvals</Cmd>,{' '}
          <Cmd>governance</Cmd>, <Cmd>consent</Cmd>, <Cmd>toggles</Cmd>),
          identity &amp; access (<Cmd>users</Cmd>, <Cmd>profiles</Cmd>,{' '}
          <Cmd>auth</Cmd>), extensibility (<Cmd>mcp</Cmd>,{' '}
          <Cmd>connections</Cmd>), orchestration (<Cmd>workforces</Cmd>), and
          observability (<Cmd>analytics</Cmd>) — plus five capabilities that
          land behind their governing RFCs:
        </p>
        <div className="card-grid">
          <div className="surface-card u-gap-2">
            <h3>Reviewable learning — <Cmd>proposals</Cmd></h3>
            <p className="muted">
              RFC 0096. An agent's learned change is stored as an{' '}
              <strong>inert</strong> proposal; a human reviews and applies it
              through the host's activation gate. The CLI renders the host's
              verdict and never activates locally.
            </p>
            <CommandBlock>{`openwop proposals list --state pending
openwop proposals apply prop_123`}</CommandBlock>
          </div>
          <div className="surface-card u-gap-2">
            <h3>Standing goals — <Cmd>goals</Cmd></h3>
            <p className="muted">
              RFC 0097. A durable objective the host pursues across runs until a{' '}
              <strong>judge</strong> verdicts it satisfied or a{' '}
              <strong>bound</strong> stops it. Completion is the judge's verdict —
              you can't declare victory from the client.
            </p>
            <CommandBlock>{`openwop goals create --objective "Keep backlog < 20" \\
  --judge verifier --max-iterations 50`}</CommandBlock>
          </div>
          <div className="surface-card u-gap-2">
            <h3>Portability — <Cmd>export</Cmd> / <Cmd>import</Cmd></h3>
            <p className="muted">
              RFC 0098. Move reusable estate between hosts as a{' '}
              <strong>refs-only</strong> bundle — secrets never travel as values.
              Always dry-run first; apply is idempotent and re-owned to you.
            </p>
            <CommandBlock>{`openwop export --kinds agent --out estate.json
openwop import estate.json --dry-run`}</CommandBlock>
          </div>
          <div className="surface-card u-gap-2">
            <h3>Trigger bridge — <Cmd>triggers</Cmd></h3>
            <p className="muted">
              RFC 0099. Bind an external <strong>webhook / email / form</strong>{' '}
              source to a workflow; the host verifies, dedups, and runs the durable
              delivery state machine. The binding secret is shown <strong>once</strong> —
              the CLI prints the fingerprint, never the value.
            </p>
            <CommandBlock>{`openwop triggers register --source webhook \\
  --workflow wf_intake --dedup --verification required`}</CommandBlock>
          </div>
          <div className="surface-card u-gap-2">
            <h3>Durable A2A tasks — <Cmd>a2a</Cmd></h3>
            <p className="muted">
              RFC 0100. Read a backing run's persisted <Cmd>A2ATaskState</Cmd>{' '}
              (<Cmd>taskId === runId</Cmd>) that survives caller disconnect, host
              restart, and HITL pauses. The record is content-free; the CLI renders
              the host's projection, never a locally-derived state.
            </p>
            <CommandBlock>{`openwop a2a status
openwop a2a task <taskId>`}</CommandBlock>
          </div>
        </div>
        <p className="muted">
          These groups are capability-gated: they appear only when this host
          advertises <Cmd>agents.proposals</Cmd>, <Cmd>agents.goals</Cmd>,{' '}
          <Cmd>portability</Cmd>, <Cmd>triggerBridge</Cmd>, or <Cmd>a2a</Cmd> in
          its <Cmd>/.well-known/openwop</Cmd> document.
        </p>
      </section>

      <section id="command-catalog" className="surface-card u-gap-3">
        <h2>Command catalog</h2>
        <DataTable
          columns={CATALOG_COLUMNS}
          rows={CATALOG}
          rowKey={(row) => row.group}
          density="comfortable"
          caption="OpenWOP CLI command groups and their subcommands"
        />
      </section>

      <section id="channel-relay" className="surface-card u-gap-3">
        <h2>Channel relay (optional)</h2>
        <p>
          The <Cmd>messaging</Cmd> and <Cmd>relay</Cmd> commands are a
          non-normative host extension under <Cmd>/v1/host/openwop-app/messaging/*</Cmd>:
          they let the CLI act as a local bridge between a chat channel and a
          workflow or agent on this host. Each adapter is opt-in — install only
          what you use:
        </p>
        <div className="card-grid">
          {ADAPTERS.map((a) => (
            <div key={a.name} className="surface-card u-gap-2">
              <h3 className="u-iflex u-gap-1">
                <span aria-hidden className="u-iflex">{a.icon}</span>
                {a.name}
              </h3>
              <p className="muted">{a.note}</p>
              <CommandBlock>{a.command}</CommandBlock>
            </div>
          ))}
        </div>
        <p className="muted">
          The CLI never sees a user's primary credentials directly. It pairs
          with the host via a 6-character code over an authenticated session,
          and channel-side auth lives only in the local adapter process.
        </p>
      </section>

      <section id="source" className="surface-card u-gap-3">
        <h2>Source &amp; issues</h2>
        <p>
          The CLI is <a href="https://www.npmjs.com/package/@openwop/cli">@openwop/cli</a> on
          npm. Source, docs, and issue tracker live in
          {' '}<a href={CLI_REPO}>github.com/openwop/openwop-cli</a>.
          Bug reports especially welcome — the CLI is young (the agent-platform
          groups plus the trigger bridge and durable A2A tasks ship in{' '}
          <strong>v0.3.0</strong>) and additive changes will land throughout v1.x.
        </p>
      </section>
    </section>
  );
}
