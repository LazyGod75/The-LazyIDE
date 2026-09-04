/* actionClassifier.test.ts — unit tests for the deterministic cloud action
   classifier (src/lib/agents/approval/actionClassifier.ts) and its pluggable
   model fallback seam.
*/

import { describe, it, expect, vi } from 'vitest';
import { classifyAction, classifyWithFallback } from '../lib/agents/approval/actionClassifier';
import { CLOUD_READONLY_TOOLS } from '../lib/agents/approval/approvalTypes';

describe('classifyAction — password inputs', () => {
  it('classifies typing into a password input as credentials via inputType', () => {
    expect(classifyAction('cloud_browser_type', {}, { inputType: 'password' })).toBe('credentials');
  });

  it('classifies a selector containing type=password as credentials', () => {
    expect(classifyAction('cloud_browser_type', { selector: 'input[type=password]' }, {})).toBe('credentials');
    expect(classifyAction('cloud_browser_type', { selector: '#login input[type="password"]' }, {})).toBe('credentials');
  });
});

describe('classifyAction — exec and file tools', () => {
  it('classifies tools ending in _exec as exec', () => {
    expect(classifyAction('cloud_sandbox_run_bash_exec', {}, {})).toBe('exec');
  });

  it('classifies cloud_sandbox_run_code as exec', () => {
    expect(classifyAction('cloud_sandbox_run_code', {}, {})).toBe('exec');
  });

  it('classifies cloud_sandbox_write_file as file_write', () => {
    expect(classifyAction('cloud_sandbox_write_file', {}, {})).toBe('file_write');
  });
});

describe('classifyAction — read-only tools', () => {
  it('classifies every CLOUD_READONLY_TOOLS entry as browse', () => {
    expect(CLOUD_READONLY_TOOLS.size).toBeGreaterThan(0);
    for (const tool of CLOUD_READONLY_TOOLS) {
      expect(classifyAction(tool, {}, {})).toBe('browse');
    }
  });
});

describe('classifyAction — publish/send path', () => {
  it('a compose URL with a Post click classifies as compose (drafting is safe)', () => {
    expect(classifyAction('cloud_browser_click', {}, { url: 'https://x.com/compose', targetText: 'Post' })).toBe('compose');
  });

  it('a Post click on a non-compose URL classifies as send', () => {
    expect(classifyAction('cloud_browser_click', {}, { url: 'https://x.com/home', targetText: 'Post' })).toBe('send');
  });
});

describe('classifyAction — pay / delete / credentials patterns', () => {
  it('a Buy now button classifies as pay', () => {
    expect(classifyAction('cloud_browser_click', {}, { targetText: 'Buy now' })).toBe('pay');
  });

  it('a checkout URL classifies as pay', () => {
    expect(classifyAction('cloud_browser_click', {}, { url: 'https://shop.example.com/checkout' })).toBe('pay');
  });

  it('a Delete account button classifies as delete', () => {
    expect(classifyAction('cloud_browser_click', {}, { targetText: 'Delete account' })).toBe('delete');
  });

  it('a login URL classifies as credentials', () => {
    expect(classifyAction('cloud_browser_click', {}, { url: 'https://x.com/login' })).toBe('credentials');
  });
});

describe('classifyAction — honest unknown (fail-safe)', () => {
  it('a Read more link on a blog is unknown, not a send/pay/delete pattern', () => {
    expect(
      classifyAction('cloud_browser_click', {}, { url: 'https://blog.example.com/2024/01/hello-world', targetText: 'Read more' }),
    ).toBe('unknown');
  });
});

describe('classifyWithFallback', () => {
  it('a deterministic class wins without calling the fallback (spy)', async () => {
    const fallback = vi.fn().mockResolvedValue('send');
    const klass = await classifyWithFallback('cloud_browser_click', {}, { targetText: 'Post' }, fallback);
    expect(klass).toBe('send');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('unknown defers to a fallback that returns a class', async () => {
    const fallback = vi.fn().mockResolvedValue('send');
    const klass = await classifyWithFallback('cloud_browser_click', {}, {}, fallback);
    expect(klass).toBe('send');
    expect(fallback).toHaveBeenCalledWith('cloud_browser_click', {}, {});
  });

  it('unknown stays unknown when the fallback throws', async () => {
    const fallback = vi.fn().mockRejectedValue(new Error('model down'));
    const klass = await classifyWithFallback('cloud_browser_click', {}, {}, fallback);
    expect(klass).toBe('unknown');
  });

  it('unknown stays unknown when no fallback is provided', async () => {
    const klass = await classifyWithFallback('cloud_browser_click', {}, {});
    expect(klass).toBe('unknown');
  });
});
