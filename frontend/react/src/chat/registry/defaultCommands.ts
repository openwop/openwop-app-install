/**
 * Built-in slash commands. Adopters extend by calling
 * `registerCommand({...})` from any module at boot.
 */

import { registerCommand, listCommands, resolveDescription } from './CommandRegistry.js';
import i18n from '../../i18n/index.js';

let registered = false;

export function registerDefaultCommands(): void {
  if (registered) return;

  registerCommand({
    name: '/clear',
    aliases: ['/new', '/reset'],
    description: () => i18n.t('chat:cmdNewDescription'),
    handler: async (_args, ctx) => {
      ctx.reset();
      return true;
    },
  });

  registerCommand({
    name: '/help',
    aliases: ['/?', '/commands'],
    description: () => i18n.t('chat:cmdHelpDescription'),
    handler: async (_args, ctx) => {
      const lines = listCommands().map((c) => {
        const aliases = c.aliases?.length ? i18n.t('chat:cmdHelpAliases', { aliases: c.aliases.join(', ') }) : '';
        const usage = c.usage ? `\n      ${c.usage}` : '';
        return `  ${c.name} — ${resolveDescription(c.description)}${aliases}${usage}`;
      });
      ctx.emitSystem(i18n.t('chat:cmdHelpHeader', { lines: lines.join('\n') }));
      return true;
    },
  });

  registerCommand({
    name: '/stop',
    aliases: ['/cancel'],
    description: () => i18n.t('chat:cmdStopDescription'),
    handler: async (_args, ctx) => {
      await ctx.cancel();
      return true;
    },
  });

  registered = true;
}
