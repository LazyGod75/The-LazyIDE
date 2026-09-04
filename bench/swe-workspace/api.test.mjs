import assert from 'node:assert';
import { test } from 'node:test';
import { fetchData } from './api.mjs';

test('fetchData returns a Promise', () => {
  const result = fetchData('https://api.example.com/users');
  assert.ok(result instanceof Promise, 'should return a Promise');
});

test('fetchData resolves with data', async () => {
  const result = await fetchData('https://api.example.com/users');
  assert.deepStrictEqual(result, { url: 'https://api.example.com/users', data: 'response-https://api.example.com/users' });
});

test('fetchData rejects on error URL', async () => {
  await assert.rejects(
    () => fetchData('https://api.example.com/error'),
    /Network error/
  );
});

test('fetchData has no callback parameter', () => {
  assert.strictEqual(fetchData.length, 1, 'function should accept only url parameter');
});
