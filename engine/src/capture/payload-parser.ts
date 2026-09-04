/**
 * Parse Claude Code hook payloads (PostToolUse / Bash / Edit / Write / Read)
 * into structured fields: tool name, files touched, and any prose worth keeping.
 *
 * The validator skips raw JSON noise; this parser runs *before* the validator
 * so we can preserve the *semantic* part (files + truncated prose) and let the
 * rest be discarded.
 */

export interface ParsedToolPayload {
  tool: string;
  filesRead: string[];
  filesModified: string[];
  prose: string;
}

const TOOLS_THAT_READ = new Set(['Read', 'NotebookRead', 'Grep', 'Glob']);
const TOOLS_THAT_MODIFY = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const FILE_PATH_REGEX =
  /(?:^|[\s'"])((?:[A-Z]:[\\/]|\.{1,2}[\\/]|\/)[^\s'":<>|*?]{2,}\.[a-z0-9]{1,8})/gi;

/**
 * Returns null when the text is not a recognisable Claude Code hook payload —
 * caller should treat as free-form prose.
 */
export function parseToolPayload(text: string): ParsedToolPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Truncated JSON — still try to salvage with regex
    return salvageWithRegex(trimmed);
  }

  const tool = strField(raw, 'tool_name') ?? '';
  if (!tool) return null;

  const input = (raw.tool_input ?? raw.input ?? {}) as Record<string, unknown>;
  const response = (raw.tool_response ?? raw.response ?? raw.result ?? {}) as
    | Record<string, unknown>
    | string;

  const filesRead = new Set<string>();
  const filesModified = new Set<string>();

  const inputPath = strField(input, 'file_path') ?? strField(input, 'notebook_path');
  if (inputPath) {
    if (TOOLS_THAT_READ.has(tool)) filesRead.add(inputPath);
    else if (TOOLS_THAT_MODIFY.has(tool)) filesModified.add(inputPath);
  }

  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    // file_path applies to all edits within MultiEdit
    if (inputPath) filesModified.add(inputPath);
  }

  if (tool === 'Bash') {
    const cmd = strField(input, 'command') ?? '';
    for (const p of extractBashFiles(cmd)) {
      if (/^(?:cat|less|tail|head|grep|find|ls|wc|file|stat)\b/.test(cmd)) filesRead.add(p);
      else filesModified.add(p);
    }
  }

  // Prose: prefer textual response output; fall back to nothing.
  let prose = '';
  if (typeof response === 'string') prose = response;
  else if (response && typeof response === 'object') {
    prose =
      strField(response, 'output') ??
      strField(response, 'stdout') ??
      strField(response, 'text') ??
      '';
  }
  prose = clipProse(prose);

  return {
    tool,
    filesRead: [...filesRead],
    filesModified: [...filesModified],
    prose,
  };
}

function strField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function extractBashFiles(cmd: string): string[] {
  const out = new Set<string>();
  FILE_PATH_REGEX.lastIndex = 0;
  for (let m = FILE_PATH_REGEX.exec(cmd); m !== null; m = FILE_PATH_REGEX.exec(cmd)) {
    out.add(m[1]);
  }
  return [...out];
}

function clipProse(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length === 0) return '';
  // Strip ANSI, collapse repeated chars, cap at 400 chars
  const stripped = trimmed
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC char (0x1b) is required for ANSI stripping
    // eslint-disable-next-line no-control-regex -- ESC char (0x1b) is required to strip ANSI escape sequences
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/(.)\1{6,}/g, '$1$1$1') // collapse runs ≥ 7 to 3
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, 400);
}

function salvageWithRegex(text: string): ParsedToolPayload | null {
  const toolMatch = text.match(/"tool_name"\s*:\s*"([^"]+)"/);
  if (!toolMatch) return null;
  const tool = toolMatch[1];
  const filePathMatch = text.match(/"file_path"\s*:\s*"([^"]+)"/);
  const filesRead = new Set<string>();
  const filesModified = new Set<string>();
  if (filePathMatch) {
    const path = filePathMatch[1].replace(/\\\\/g, '\\');
    if (TOOLS_THAT_READ.has(tool)) filesRead.add(path);
    else if (TOOLS_THAT_MODIFY.has(tool)) filesModified.add(path);
  }
  return {
    tool,
    filesRead: [...filesRead],
    filesModified: [...filesModified],
    prose: '',
  };
}
