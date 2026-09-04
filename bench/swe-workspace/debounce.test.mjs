import assert from 'node:assert';
import { test } from 'node:test';
import debounce from './debounce.mjs';

test('fn does not fire immediately', () => {
  let calls = 0;
  const d = debounce(() => calls++, 50);
  d();
  assert.strictEqual(calls, 0, 'fn should not fire immediately');
});

test('fn fires after delay', async () => {
  let calls = 0;
  const d = debounce(() => calls++, 50);
  d();
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(calls, 1, 'fn should fire once after delay');
});

test('fn does not fire if called again within delay', async () => {
  let calls = 0;
  const d = debounce(() => calls++, 50);
  d();
  await new Promise(r => setTimeout(r, 30));
  d();  // reset timer
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(calls, 0, 'fn should not fire yet (timer was reset)');
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(calls, 1, 'fn should fire after second delay');
});

test('passes arguments correctly', async () => {
  let result;
  const d = debounce((a, b) => result = a + b, 30);
  d(3, 4);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(result, 7, 'arguments should be passed through');
});
