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
import { Trans, useTranslation } from 'react-i18next';
import i18n from './i18n/index.js';
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

function copy(text: string, label?: string): void {
  const message = label ?? i18n.t('chrome:cliCommandCopied');
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success(message))
    .catch(() => {
      /* clipboard blocked */
    });
}

function Cmd({ children }: { children?: ReactNode }) {
  return <code>{children}</code>;
}

/** A shell snippet with a one-click copy affordance (the page's core job). */
function CommandBlock({ children, copyLabel }: { children: string; copyLabel?: string }) {
  return (
    <div className="u-flex u-flex-col u-gap-1">
      <div className="u-flex u-justify-end">
        <IconButton
          label={i18n.t('chrome:cliCopyCommand')}
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
    description: <Trans i18nKey="cliCatOnboard" ns="chrome" components={{ 0: <Cmd /> }} />,
  },
  {
    group: 'doctor',
    commands: ['--json'],
    description: <Trans i18nKey="cliCatDoctor" ns="chrome" />,
  },
  {
    group: 'capabilities',
    commands: [],
    description: <Trans i18nKey="cliCatCapabilities" ns="chrome" components={{ 0: <Cmd /> }} />,
  },
  {
    group: 'runs',
    commands: ['create', 'get', 'events', 'annotations', 'debug-bundle'],
    description: <Trans i18nKey="cliCatRuns" ns="chrome" components={{ 0: <Cmd />, 1: <Cmd />, 2: <Cmd />, 3: <Cmd /> }} />,
  },
  {
    group: 'prompts',
    commands: ['list', 'render'],
    description: <Trans i18nKey="cliCatPrompts" ns="chrome" />,
  },
  {
    group: 'memory',
    commands: ['list', 'get', 'write'],
    description: <Trans i18nKey="cliCatMemory" ns="chrome" />,
  },
  {
    group: 'agents',
    commands: ['list', 'get', 'dispatch'],
    description: <Trans i18nKey="cliCatAgents" ns="chrome" />,
  },
  {
    group: 'interrupts',
    commands: ['list', 'resume'],
    description: <Trans i18nKey="cliCatInterrupts" ns="chrome" />,
  },
  {
    group: 'messaging',
    commands: ['connectors', 'routing', 'policy', 'pairing', 'allowlist', 'logs'],
    description: <Trans i18nKey="cliCatMessaging" ns="chrome" />,
  },
  {
    group: 'relay',
    commands: ['signal', 'imessage', 'whatsapp', 'discord'],
    description: <Trans i18nKey="cliCatRelay" ns="chrome" />,
  },
  {
    group: 'notifications',
    commands: ['list', 'ack'],
    description: <Trans i18nKey="cliCatNotifications" ns="chrome" />,
  },
  {
    group: 'proposals',
    commands: ['list', 'get', 'revise', 'apply', 'reject', 'archive'],
    description: <Trans i18nKey="cliCatProposals" ns="chrome" components={{ 0: <strong /> }} />,
  },
  {
    group: 'goals',
    commands: ['list', 'get', 'create', 'pause', 'resume', 'abandon'],
    description: <Trans i18nKey="cliCatGoals" ns="chrome" components={{ 0: <strong />, 1: <strong />, 2: <Cmd /> }} />,
  },
  {
    group: 'export / import',
    commands: ['--kinds', '--dry-run'],
    description: <Trans i18nKey="cliCatExportImport" ns="chrome" components={{ 0: <strong />, 1: <Cmd /> }} />,
  },
  {
    group: 'triggers',
    commands: ['list', 'get', 'register'],
    description: <Trans i18nKey="cliCatTriggers" ns="chrome" components={{ 0: <strong />, 1: <strong /> }} />,
  },
  {
    group: 'a2a',
    commands: ['status', 'task'],
    description: <Trans i18nKey="cliCatA2a" ns="chrome" components={{ 0: <Cmd />, 1: <Cmd />, 2: <Cmd /> }} />,
  },
  {
    group: 'approvals',
    commands: ['list', 'get', 'claim', 'reject'],
    description: <Trans i18nKey="cliCatApprovals" ns="chrome" />,
  },
  {
    group: 'governance',
    commands: ['policy', 'audit'],
    description: <Trans i18nKey="cliCatGovernance" ns="chrome" components={{ 0: <Cmd /> }} />,
  },
  {
    group: 'consent',
    commands: ['policy', 'records', 'get', 'erase'],
    description: <Trans i18nKey="cliCatConsent" ns="chrome" />,
  },
  {
    group: 'toggles',
    commands: ['list', 'get'],
    description: <Trans i18nKey="cliCatToggles" ns="chrome" />,
  },
  {
    group: 'users',
    commands: ['list', 'get', 'create', 'disable', 'me'],
    description: <Trans i18nKey="cliCatUsers" ns="chrome" />,
  },
  {
    group: 'profiles',
    commands: ['get', 'edit', 'skills', 'endorse'],
    description: <Trans i18nKey="cliCatProfiles" ns="chrome" />,
  },
  {
    group: 'auth',
    commands: ['status', 'saml', 'scim'],
    description: <Trans i18nKey="cliCatAuth" ns="chrome" components={{ 0: <Cmd /> }} />,
  },
  {
    group: 'mcp',
    commands: ['info', 'tools', 'resources', 'prompts'],
    description: <Trans i18nKey="cliCatMcp" ns="chrome" />,
  },
  {
    group: 'connections',
    commands: ['list', 'test', 'authorize', 'oauth-clients'],
    description: <Trans i18nKey="cliCatConnections" ns="chrome" components={{ 0: <Cmd /> }} />,
  },
  {
    group: 'workforces',
    commands: ['list', 'metrics', 'governance', 'status'],
    description: <Trans i18nKey="cliCatWorkforces" ns="chrome" components={{ 0: <Cmd /> }} />,
  },
  {
    group: 'analytics',
    commands: ['summary', 'events', 'collect'],
    description: <Trans i18nKey="cliCatAnalytics" ns="chrome" components={{ 0: <Cmd /> }} />,
  },
  {
    group: 'cron',
    commands: ['list', 'add', 'enable', 'disable', 'remove'],
    description: <Trans i18nKey="cliCatCron" ns="chrome" components={{ 0: <Cmd /> }} />,
  },
];

const CATALOG_COLUMNS: DataColumn<CatalogEntry>[] = [
  {
    key: 'group',
    header: i18n.t('chrome:cliColGroup'),
    width: '160px',
    render: (row) => <span className="chip chip--accent">{row.group}</span>,
  },
  {
    key: 'commands',
    header: i18n.t('chrome:cliColCommands'),
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
    header: i18n.t('chrome:cliColWhatItDoes'),
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
    note: <Trans i18nKey="cliAdapterSignalNote" ns="chrome" components={{ 0: <Cmd /> }} />,
    command: 'openwop relay signal --account +15555550100',
  },
  {
    name: 'iMessage',
    icon: <MessageSquareIcon size={18} />,
    note: <Trans i18nKey="cliAdapterImessageNote" ns="chrome" />,
    command: 'openwop relay imessage',
  },
  {
    name: 'WhatsApp',
    icon: <MessageCircleIcon size={18} />,
    note: <Trans i18nKey="cliAdapterWhatsappNote" ns="chrome" components={{ 0: <Cmd /> }} />,
    command: 'openwop relay whatsapp',
  },
  {
    name: 'Discord',
    icon: <TerminalIcon size={18} />,
    note: <Trans i18nKey="cliAdapterDiscordNote" ns="chrome" components={{ 0: <Cmd />, 1: <Cmd /> }} />,
    command: 'DISCORD_TOKEN=… openwop relay discord',
  },
];

export function CliPage() {
  const { t } = useTranslation('chrome');
  return (
    <section className="cli-page page-stack">
      <PageHeader
        eyebrow={t('cliEyebrow')}
        title={t('cliTitle')}
        lede={<Trans t={t} i18nKey="cliLede" components={{ 0: <Cmd />, 1: <strong />, 2: <Cmd /> }} />}
        actions={
          <>
            <button
              type="button"
              className="btn-primary u-iflex u-gap-1"
              onClick={() => copy(INSTALL_CMD, t('cliInstallCommandCopied'))}
            >
              <ClipboardIcon size={15} /> {t('cliCopyInstall')}
            </button>
            <a className="btn-ghost u-iflex u-gap-1" href={CLI_REPO}>
              <LinkIcon size={15} /> {t('cliSourceAndIssues')}
            </a>
          </>
        }
      />

      <section id="install" className="surface-card u-gap-3">
        <h2>{t('cliInstallHeading')}</h2>
        <p>{t('cliInstallGlobal')}</p>
        <CommandBlock copyLabel={t('cliInstallCommandCopied')}>{`npm install -g @openwop/cli
openwop --version`}</CommandBlock>
        <p>{t('cliInstallOneOff')}</p>
        <CommandBlock>{`npx -y @openwop/cli@latest --help`}</CommandBlock>
        <p className="muted">
          <Trans t={t} i18nKey="cliInstallRequires" components={{ 0: <em /> }} />
        </p>
      </section>

      <section id="point-at-host" className="surface-card u-gap-3">
        <h2>{t('cliPointHeading')}</h2>
        <p>
          <Trans t={t} i18nKey="cliPointBody" components={{ 0: <Cmd />, 1: <Cmd />, 2: <Cmd /> }} />
        </p>
        <CommandBlock>{`export OPENWOP_BASE_URL=https://app.openwop.dev/api
openwop onboard           # interactive auth + key issuance
openwop doctor            # check connectivity + capability surface
openwop capabilities      # read /.well-known/openwop`}</CommandBlock>
      </section>

      <section id="new-capabilities" className="surface-card u-gap-3">
        <h2>{t('cliNewCapsHeading')}</h2>
        <p>
          <Trans
            t={t}
            i18nKey="cliNewCapsBody"
            components={{
              0: <Cmd />, 1: <Cmd />, 2: <Cmd />, 3: <Cmd />, 4: <Cmd />, 5: <Cmd />,
              6: <Cmd />, 7: <Cmd />, 8: <Cmd />, 9: <Cmd />, 10: <Cmd />,
            }}
          />
        </p>
        <div className="card-grid">
          <div className="surface-card u-gap-2">
            <h3><Trans t={t} i18nKey="cliCardProposalsTitle" components={{ 0: <Cmd /> }} /></h3>
            <p className="muted">
              <Trans t={t} i18nKey="cliCardProposalsBody" components={{ 0: <strong /> }} />
            </p>
            <CommandBlock>{`openwop proposals list --state pending
openwop proposals apply prop_123`}</CommandBlock>
          </div>
          <div className="surface-card u-gap-2">
            <h3><Trans t={t} i18nKey="cliCardGoalsTitle" components={{ 0: <Cmd /> }} /></h3>
            <p className="muted">
              <Trans t={t} i18nKey="cliCardGoalsBody" components={{ 0: <strong />, 1: <strong /> }} />
            </p>
            <CommandBlock>{`openwop goals create --objective "Keep backlog < 20" \\
  --judge verifier --max-iterations 50`}</CommandBlock>
          </div>
          <div className="surface-card u-gap-2">
            <h3><Trans t={t} i18nKey="cliCardPortabilityTitle" components={{ 0: <Cmd />, 1: <Cmd /> }} /></h3>
            <p className="muted">
              <Trans t={t} i18nKey="cliCardPortabilityBody" components={{ 0: <strong /> }} />
            </p>
            <CommandBlock>{`openwop export --kinds agent --out estate.json
openwop import estate.json --dry-run`}</CommandBlock>
          </div>
          <div className="surface-card u-gap-2">
            <h3><Trans t={t} i18nKey="cliCardTriggersTitle" components={{ 0: <Cmd /> }} /></h3>
            <p className="muted">
              <Trans t={t} i18nKey="cliCardTriggersBody" components={{ 0: <strong />, 1: <strong /> }} />
            </p>
            <CommandBlock>{`openwop triggers register --source webhook \\
  --workflow wf_intake --dedup --verification required`}</CommandBlock>
          </div>
          <div className="surface-card u-gap-2">
            <h3><Trans t={t} i18nKey="cliCardA2aTitle" components={{ 0: <Cmd /> }} /></h3>
            <p className="muted">
              <Trans t={t} i18nKey="cliCardA2aBody" components={{ 0: <Cmd />, 1: <Cmd /> }} />
            </p>
            <CommandBlock>{`openwop a2a status
openwop a2a task <taskId>`}</CommandBlock>
          </div>
        </div>
        <p className="muted">
          <Trans
            t={t}
            i18nKey="cliNewCapsGated"
            components={{ 0: <Cmd />, 1: <Cmd />, 2: <Cmd />, 3: <Cmd />, 4: <Cmd />, 5: <Cmd /> }}
          />
        </p>
      </section>

      <section id="command-catalog" className="surface-card u-gap-3">
        <h2>{t('cliCatalogHeading')}</h2>
        <DataTable
          columns={CATALOG_COLUMNS}
          rows={CATALOG}
          rowKey={(row) => row.group}
          density="comfortable"
          caption={t('cliCatalogCaption')}
        />
      </section>

      <section id="channel-relay" className="surface-card u-gap-3">
        <h2>{t('cliRelayHeading')}</h2>
        <p>
          <Trans t={t} i18nKey="cliRelayBody" components={{ 0: <Cmd />, 1: <Cmd />, 2: <Cmd /> }} />
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
          {t('cliRelayPairing')}
        </p>
      </section>

      <section id="source" className="surface-card u-gap-3">
        <h2>{t('cliSourceHeading')}</h2>
        <p>
          <Trans
            t={t}
            i18nKey="cliSourceBody"
            components={{
              0: <a href="https://www.npmjs.com/package/@openwop/cli" />,
              1: <a href={CLI_REPO} />,
              2: <strong />,
            }}
          />
        </p>
      </section>
    </section>
  );
}
