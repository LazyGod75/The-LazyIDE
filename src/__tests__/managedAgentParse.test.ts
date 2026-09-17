import { describe, it, expect } from 'vitest';
import { parseReActAction } from '../lib/agents/managedAgentParse';

describe('parseReActAction', () => {
  it('parses a clean ACTION + ARGS block', () => {
    const r = parseReActAction('THOUGHT: open it\nACTION: cloud_browser_open\nARGS: {"url":"https://example.com"}');
    expect(r).toEqual({ action: 'cloud_browser_open', args: { url: 'https://example.com' } });
  });

  it('M114 regression: ARGS inlined on the ACTION line does not glue into the tool name', () => {
    const r = parseReActAction('ACTION: cloud_browser_open ARGS: {"url":"https://example.com"}');
    expect(r?.action).toBe('cloud_browser_open');
    expect(r?.args).toEqual({ url: 'https://example.com' });
  });

  it('ARGS glued without space stays out of the tool name', () => {
    const r = parseReActAction('ACTION: cloud_browser_openARGS: {}');
    expect(r?.action).toBe('cloud_browser_open');
    expect(r?.args).toEqual({});
  });

  it('inline JSON after the tool name does not glue into the name either', () => {
    const r = parseReActAction('ACTION: cloud_browser_navigate {"url":"https://example.com"}');
    expect(r?.action).toBe('cloud_browser_navigate');
    expect(r?.args).toEqual({ url: 'https://example.com' });
  });

  it('M132 regression: ACTION glued onto the THOUGHT sentence still parses', () => {
    const r = parseReActAction('THOUGHT: Session up — capture screen.ACTION: cloud_desktop_screenshot');
    expect(r?.action).toBe('cloud_desktop_screenshot');
    expect(r?.args).toEqual({});
  });

  it('a no-arg tool with no ARGS yields empty args', () => {
    const r = parseReActAction('THOUGHT: done\nACTION: cloud_browser_close');
    expect(r).toEqual({ action: 'cloud_browser_close', args: {} });
  });

  it('FINAL stays FINAL', () => {
    const r = parseReActAction('ACTION: FINAL\nARGS: {"summary":"Title: Example Domain"}');
    expect(r?.action).toBe('FINAL');
    expect(r?.args).toEqual({ summary: 'Title: Example Domain' });
  });
});
