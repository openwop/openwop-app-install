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
    description: <>Browse the host's prompt library (RFC 0027) and render a template with variables locally.</>,
  },
  {
    group: 'memory',
    commands: ['list', 'get', 'write'],
    description: <>Inspect and write tenant-scoped agent memory (with SR-1 redaction).</>,
  },
  {
    group: 'agents',
    commands: ['list', 'get', 'dispatch'],
    description: <>List the host's manifest-runtime agent inventory (RFC 0070/0072) and dispatch directly.</>,
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
        lede={<>The <Cmd>openwop</Cmd> command operates this host (and any OpenWOP-compatible host) from the terminal — auth onboarding, capabilities discovery, run submission + streaming, prompts + memory + agents, channel messaging, and host doctor.</>}
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
          non-normative host extension under <Cmd>/v1/host/sample/messaging/*</Cmd>:
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
          Bug reports especially welcome — the CLI is new (v0.2.x) and
          additive changes will land throughout v1.x.
        </p>
      </section>
    </section>
  );
}
