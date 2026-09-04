import { describe, it, expect } from 'vitest';
import {
  agentErrorEvent,
  formatAgentError,
  isAgentErrorEvent,
  isAgentErrorText,
  stripAgentErrorPrefix,
} from '../lib/agents/agentError';

describe('formatAgentError', () => {
  it('uses the i18n prefix when t is supplied', () => {
    const t = (key: string) => (key === 'agents.runtime.agentErrorPrefix' ? 'Agent error:' : key);
    expect(formatAgentError('backend down', t)).toBe('Agent error: backend down');
  });

  it('falls back to the French sentinel without t', () => {
    expect(formatAgentError('backend down')).toBe('Erreur agent: backend down');
  });

  it('does not nest prefixes', () => {
    expect(formatAgentError('Erreur agent: already wrapped')).toBe('Erreur agent: already wrapped');
  });
});

describe('isAgentErrorText / isAgentErrorEvent', () => {
  it('recognises the historical French sentinel', () => {
    expect(isAgentErrorText('Erreur agent: wallet empty')).toBe(true);
  });

  it('recognises translated prefixes', () => {
    expect(isAgentErrorText('Agent error: wallet empty')).toBe(true);
    expect(isAgentErrorText('Agentfehler: timeout')).toBe(true);
  });

  it('does not match ordinary timeline text', () => {
    expect(isAgentErrorText('Read README.md')).toBe(false);
  });

  it('treats kind=error as an error even when the text is translated', () => {
    expect(isAgentErrorEvent({ kind: 'error', text: 'Boom' })).toBe(true);
    expect(isAgentErrorEvent({ text: 'Boom' })).toBe(false);
  });

  it('agentErrorEvent stamps kind=error', () => {
    const ev = agentErrorEvent('00:01', 'no credits');
    expect(ev.kind).toBe('error');
    expect(isAgentErrorEvent(ev)).toBe(true);
    expect(stripAgentErrorPrefix(ev.text)).toBe('no credits');
  });

  it('exposes AGENT_ERROR_MARKER as the stable machine token', async () => {
    const { AGENT_ERROR_MARKER, AGENT_ERROR_KIND } = await import('../lib/agents/agentError');
    expect(AGENT_ERROR_MARKER).toBe('error');
    expect(AGENT_ERROR_MARKER).toBe(AGENT_ERROR_KIND);
  });
});
