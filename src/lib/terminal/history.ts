const MAX_TERMINAL_OUTPUT_CHARS = 20000;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

let outputBuffer = '';
let inputBuffer = '';
let lastCommand = '';

export function recordTerminalOutput(data: string): void {
  outputBuffer += data;
  if (outputBuffer.length > MAX_TERMINAL_OUTPUT_CHARS) {
    outputBuffer = outputBuffer.slice(-MAX_TERMINAL_OUTPUT_CHARS);
  }
}

export function recordTerminalInput(data: string): void {
  for (const char of data) {
    if (char === '\r' || char === '\n') {
      const command = inputBuffer.trim();
      if (command) lastCommand = command;
      inputBuffer = '';
    } else if (char === '\x7f' || char === '\b') {
      inputBuffer = inputBuffer.slice(0, -1);
    } else if (char >= ' ') {
      inputBuffer += char;
    }
  }
}

export function getTerminalOutput(lines = 50): string {
  return outputBuffer
    .replace(ANSI_ESCAPE_PATTERN, '')
    .split(/\r?\n/)
    .slice(-lines)
    .join('\n')
    .trim();
}

export function getLastTerminalCommand(): string {
  return lastCommand;
}
