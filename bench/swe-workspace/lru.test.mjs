import assert from 'node:assert';
import { test } from 'node:test';
import LRUCache from './lru.mjs';

test('get returns cached value', () => {
  const cache = new LRUCache(2);
  cache.put('a', 1);
  assert.strictEqual(cache.get('a'), 1);
});

test('evicts least recently used when full', () => {
  const cache = new LRUCache(2);
  cache.put('a', 1);
  cache.put('b', 2);
  cache.get('a');  // a is now MRU
  cache.put('c', 3);  // should evict b (LRU)
  assert.strictEqual(cache.get('b'), -1, 'b should be evicted');
  assert.strictEqual(cache.get('a'), 1, 'a should still be cached');
  assert.strictEqual(cache.get('c'), 3, 'c should be cached');
});

test('get returns -1 for missing key', () => {
  const cache = new LRUCache(2);
  assert.strictEqual(cache.get('missing'), -1);
});

test('put updates existing key', () => {
  const cache = new LRUCache(2);
  cache.put('a', 1);
  cache.put('a', 2);
  assert.strictEqual(cache.get('a'), 2);
});

test('capacity 1 evicts correctly', () => {
  const cache = new LRUCache(1);
  cache.put('a', 1);
  cache.put('b', 2);
  assert.strictEqual(cache.get('a'), -1);
  assert.strictEqual(cache.get('b'), 2);
});
