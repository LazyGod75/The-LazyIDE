/* slashCommands.ts — Slash command parsing for the assistant Composer.

   Supported commands:
   /compact       — Compress conversation context intelligently
   /diff          — Show the current agent diff
   /apply         — Apply the proposed diff
   /resume        — Resume a previous session
   /fork          — Fork the current session
   /brain-search  — Search the brain mid-conversation
   /docs          — Search brain docs
   /docs add      — Add a brain doc entry
   /clear         — Clear the conversation
   /model         — Switch model
   /help          — Show available commands

   Each command returns a parsed action the Composer/AssistantStore can execute.
*/

export type SlashCommandName =
  | 'compact'
  | 'diff'
  | 'apply'
  | 'resume'
  | 'fork'
  | 'brain-search'
  | 'docs'
  | 'docs-add'
  | 'clear'
  | 'model'
  | 'help'
  | 'unknown';

export interface ParsedSlashCommand {
  name: SlashCommandName;
  /** The argument string after the command (e.g. "/brain-search how does auth work" → "how does auth work") */
  args: string;
  /** Raw input line */
  raw: string;
}

export interface SlashCommandDef {
  name: SlashCommandName;
  aliases?: string[];
  description: string;
  usage: string;
  /** Whether this command takes arguments */
  takesArgs: boolean;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'compact',
    description: 'Compress conversation context intelligently using brain recall',
    usage: '/compact',
    takesArgs: false,
  },
  {
    name: 'diff',
    description: 'Show the current agent diff',
    usage: '/diff',
    takesArgs: false,
  },
  {
    name: 'apply',
    description: 'Apply the proposed diff',
    usage: '/apply',
    takesArgs: false,
  },
  {
    name: 'resume',
    description: 'Resume a previous session',
    usage: '/resume [session-id]',
    takesArgs: true,
  },
  {
    name: 'fork',
    description: 'Fork the current session (keeps original, creates a copy)',
    usage: '/fork',
    takesArgs: false,
  },
  {
    name: 'brain-search',
    aliases: ['bs'],
    description: 'Search the brain memory mid-conversation',
    usage: '/brain-search <query>',
    takesArgs: true,
  },
  {
    name: 'docs',
    description: 'Search brain docs (curated internet resources)',
    usage: '/docs <query>',
    takesArgs: true,
  },
  {
    name: 'docs-add',
    description: 'Add a brain doc entry (URL + tags)',
    usage: '/docs add <url> | <title> | <tag1,tag2,...>',
    takesArgs: true,
  },
  {
    name: 'clear',
    description: 'Clear the conversation',
    usage: '/clear',
    takesArgs: false,
  },
  {
    name: 'model',
    description: 'Switch model',
    usage: '/model <model-id>',
    takesArgs: true,
  },
  {
    name: 'help',
    description: 'Show available slash commands',
    usage: '/help',
    takesArgs: false,
  },
];

/**
 * Parse a user input line for a slash command.
 * Returns null when the input is not a slash command.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  // Extract command name (first token) and args (rest)
  const spaceIdx = trimmed.indexOf(' ');
  const cmdToken = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  // Match against known commands and aliases
  for (const def of SLASH_COMMANDS) {
    if (def.name === cmdToken.toLowerCase() ||
        (def.aliases && def.aliases.includes(cmdToken.toLowerCase()))) {
      // Special case: "/docs add" → docs-add
      if (def.name === 'docs' && args.toLowerCase().startsWith('add ')) {
        return {
          name: 'docs-add',
          args: args.slice(4).trim(),
          raw: trimmed,
        };
      }
      return { name: def.name, args, raw: trimmed };
    }
  }

  return { name: 'unknown', args, raw: trimmed };
}

/**
 * Get command suggestions for autocomplete when the user types "/".
 * Returns commands matching the partial input.
 */
export function suggestSlashCommands(partial: string): SlashCommandDef[] {
  const q = partial.toLowerCase().replace(/^\//, '').trim();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(def =>
    def.name.startsWith(q) ||
    (def.aliases && def.aliases.some(a => a.startsWith(q))),
  );
}

/**
 * Format the help text for /help command.
 */
export function formatSlashHelp(): string {
  const lines: string[] = ['**Slash commands:**\n'];
  for (const def of SLASH_COMMANDS) {
    const aliases = def.aliases ? ` (${def.aliases.map(a => `/${a}`).join(', ')})` : '';
    lines.push(`  **${def.usage}**${aliases} — ${def.description}`);
  }
  return lines.join('\n');
}

/**
 * Parse a /docs add argument string: "<url> | <title> | <tag1,tag2,...>"
 */
export function parseDocsAddArgs(args: string): { url: string; title: string; tags: string[] } | null {
  const parts = args.split('|').map(s => s.trim());
  if (parts.length < 2) return null;
  const url = parts[0];
  const title = parts[1];
  const tags = parts[2] ? parts[2].split(',').map(t => t.trim()).filter(Boolean) : [];
  if (!url || !title) return null;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
  return { url, title, tags };
}
