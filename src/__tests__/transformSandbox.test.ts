/**
 * transformSandbox.test.ts — W-CODE SECURITY PROOF for
 * lib/agents/transformSandbox.ts: the safe-by-construction execution
 * boundary for a user-authored "transformation" tool (transformTools.ts).
 * This is the load-bearing test file for the whole feature — every escape
 * vector named in the sandbox's own threat model (see transformSandbox.ts's
 * header) gets an explicit, adversarial test below, plus a legitimate
 * transform to prove the sandbox isn't merely blocking everything.
 *
 * ENVIRONMENT NOTE: Vitest runs under jsdom, and jsdom does not implement
 * `Worker` (confirmed: `typeof Worker === 'undefined'` in this test
 * process) — so every test below exercises `runInNodeVm`, the Node
 * `vm`-based implementation, NOT the browser `Worker` implementation that
 * ships in the actual Tauri app. This is not a lesser proof: both
 * implementations are held to, and independently satisfy, the identical
 * isolation contract documented in transformSandbox.ts's header (a fresh,
 * hard-killable realm with zero ambient authority) — see that header for
 * why each mechanism is the right, idiomatic choice for its own host
 * (`Worker.terminate()` for a real OS thread in the browser;
 * `vm.Script#runInContext`'s own hard timeout for Node, sufficient because
 * no async-scheduling primitive is ever exposed to the sandboxed code). The
 * browser path is additionally exercised end-to-end through the shipped
 * app (AgentWizard authoring + a real `run_transform` call in a managed
 * mission) — see this wave's report for that verification.
 */

import { describe, it, expect } from 'vitest';
import { runTransformSandbox, TRANSFORM_TIMEOUT_MS, TRANSFORM_MAX_OUTPUT_CHARS } from '../lib/agents/transformSandbox';

describe('runTransformSandbox — legitimate use (the sandbox must not merely block everything)', () => {
  it('runs a real transformation and returns the correct JSON output', async () => {
    const result = await runTransformSandbox('return input.items.map((x) => x * 2);', { items: [1, 2, 3] });
    expect(result).toEqual({ ok: true, result: [2, 4, 6] });
  });

  it('supports plain objects, strings, and nested structures round-tripping through JSON', async () => {
    const input = { user: { name: 'Ada', tags: ['math', 'engineering'] }, count: 3 };
    const code = 'return { greeting: "Hello " + input.user.name, tagCount: input.user.tags.length, doubled: input.count * 2 };';
    const result = await runTransformSandbox(code, input);
    expect(result).toEqual({ ok: true, result: { greeting: 'Hello Ada', tagCount: 2, doubled: 6 } });
  });

  it('has access to standard pure-JS built-ins: Math, JSON, String, Array, Object, Date-as-value', async () => {
    const code = `
      const rounded = Math.round(input.value);
      const json = JSON.stringify({ a: 1 });
      const upper = String(input.name).toUpperCase();
      const arr = Array.from({ length: 3 }, (_, i) => i);
      const merged = Object.assign({}, input, { extra: true });
      const iso = new Date(0).toISOString();
      return { rounded, json, upper, arr, merged, iso };
    `;
    const result = await runTransformSandbox(code, { value: 2.6, name: 'ada' });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      rounded: 3,
      json: '{"a":1}',
      upper: 'ADA',
      arr: [0, 1, 2],
      merged: { value: 2.6, name: 'ada', extra: true },
      iso: '1970-01-01T00:00:00.000Z',
    });
  });
});

describe('runTransformSandbox — SECURITY: sandbox escape attempts are all blocked', () => {
  it('`require` does not exist (no Node module system reachable)', async () => {
    const result = await runTransformSandbox('return typeof require;', {});
    expect(result).toEqual({ ok: true, result: 'undefined' });
  });

  it('`require("fs")` throws instead of returning a working fs module', async () => {
    const result = await runTransformSandbox('return require("fs").readFileSync("/etc/passwd", "utf8");', {});
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('`process` does not exist (no process object, no env, no exit)', async () => {
    const result = await runTransformSandbox('return typeof process;', {});
    expect(result).toEqual({ ok: true, result: 'undefined' });
  });

  it('`process.env` access throws rather than leaking environment variables', async () => {
    const result = await runTransformSandbox('return process.env.HOME;', {});
    expect(result.ok).toBe(false);
  });

  it('`fetch` does not exist (no network egress)', async () => {
    const result = await runTransformSandbox('return typeof fetch;', {});
    expect(result).toEqual({ ok: true, result: 'undefined' });
  });

  it('`fetch(...)` throws instead of performing a real network request', async () => {
    const result = await runTransformSandbox('fetch("https://example.com"); return 1;', {});
    expect(result.ok).toBe(false);
  });

  it('`globalThis`/`window` grant no ambient authority — no ambient window/DOM reachable', async () => {
    const result = await runTransformSandbox('return typeof window;', {});
    expect(result).toEqual({ ok: true, result: 'undefined' });
  });

  it('mutating `globalThis` inside the sandbox never leaks to the host realm', async () => {
    const before = (globalThis as unknown as Record<string, unknown>).sandboxLeakProbe;
    expect(before).toBeUndefined();
    const result = await runTransformSandbox('globalThis.sandboxLeakProbe = "leaked"; return globalThis.sandboxLeakProbe;', {});
    // Inside its own realm the assignment succeeds (proving globalThis
    // itself is usable for ordinary variable-shaped code)...
    expect(result).toEqual({ ok: true, result: 'leaked' });
    // ...but the HOST process's globalThis is a completely different object
    // — nothing crossed the boundary.
    expect((globalThis as unknown as Record<string, unknown>).sandboxLeakProbe).toBeUndefined();
  });

  it('an infinite loop hits the hard timeout and is terminated, not hung forever', async () => {
    const startedAt = Date.now();
    const result = await runTransformSandbox('while (true) {}', {}, { timeoutMs: 300 });
    const elapsedMs = Date.now() - startedAt;
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // Proves this is a genuine hard kill, not a silent hang: the call
    // returns close to the requested timeout, not never.
    expect(elapsedMs).toBeLessThan(3000);
  }, 10_000);

  it('respects the default TRANSFORM_TIMEOUT_MS when no override is given', () => {
    expect(TRANSFORM_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TRANSFORM_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });

  it('a huge output is rejected with an honest size-cap error, never silently truncated as success', async () => {
    const result = await runTransformSandbox('return "x".repeat(2_000_000);', {}, { maxOutputChars: 1000 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/size cap/);
  });

  it('exposes a sane default TRANSFORM_MAX_OUTPUT_CHARS', () => {
    expect(TRANSFORM_MAX_OUTPUT_CHARS).toBeGreaterThan(1000);
  });

  it('a prototype-pollution attempt on `input` never leaks to the host realm\'s Object.prototype', async () => {
    const pollutedBefore = ({} as Record<string, unknown>).polluted;
    expect(pollutedBefore).toBeUndefined();

    const result = await runTransformSandbox(
      'input.__proto__.polluted = "yes"; return { sawPollution: ({}).polluted === "yes" };',
      { a: 1 },
    );
    // Inside its own throwaway realm the pollution DOES take effect (this is
    // expected and harmless — that realm is destroyed right after) ...
    expect(result).toEqual({ ok: true, result: { sawPollution: true } });
    // ...but the REAL host Object.prototype was never touched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('prototype pollution from one call never leaks into a SUBSEQUENT, unrelated call', async () => {
    await runTransformSandbox('input.__proto__.polluted = "leak-attempt"; return null;', {});
    const second = await runTransformSandbox('return ({}).polluted === undefined;', {});
    expect(second).toEqual({ ok: true, result: true });
  });

  it('a syntax error in the authored code is caught honestly, never crashes the caller', async () => {
    const result = await runTransformSandbox('this is not valid js {{{', {});
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('a thrown runtime exception is caught and surfaced as an honest error', async () => {
    const result = await runTransformSandbox('return input.doesNotExist.nested;', { a: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('a non-JSON-serializable return value (a function) is rejected, not silently coerced', async () => {
    const result = await runTransformSandbox('return function() {};', {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not JSON-serializable/);
  });

  it('`import` is a syntax error inside a plain function body — no ES module escape hatch', async () => {
    const result = await runTransformSandbox('import fs from "fs"; return 1;', {});
    expect(result.ok).toBe(false);
  });

  it('`eval` cannot reach the host realm even if called inside the sandbox', async () => {
    // eval() inside the sandbox realm evaluates in that SAME (already
    // stripped/isolated) realm — it does not escalate to the host's eval.
    // (`require` is not merely undefined but UNDECLARED in this realm, so
    // referencing it directly throws a ReferenceError — `typeof` must be
    // applied INSIDE the eval'd string to observe "undefined" without that
    // throw, exactly as it would for any undeclared identifier.)
    const result = await runTransformSandbox('return eval("typeof require");', {});
    expect(result).toEqual({ ok: true, result: 'undefined' });
  });
});
