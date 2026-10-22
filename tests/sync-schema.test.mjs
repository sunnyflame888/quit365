import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSyncState, validateDocument, documentBytes } from '../src/sync-schema.js';
import { fixture, withDay } from './fixtures.mjs';
test('accepts existing state without inventing log dates', () => {
  const s = withDay(fixture());
  assert.deepEqual(validateSyncState(s), s);
  assert.equal(Object.keys(s.logs).length, 1);
});
test('rejects future document versions and UTF8 payloads larger than 1MiB', () => {
  assert.throws(() => validateDocument({ formatVersion: 2, appState: fixture() }));
  const d = { formatVersion: 1, appState: withDay(fixture()) };
  assert.ok(documentBytes(d) > 100);
  d.appState.logs['2026-10-22'].notes = '中'.repeat(400000);
  assert.throws(() => validateDocument(d));
});
test('rejects template injection, false booleans, invalid numbers and prototype keys', () => {
  for (const mutate of [
    (s) => (s.settings.amTime = '" autofocus onfocus=alert(1)'),
    (s) => (s.logs['2026-10-22'].complete = 'false'),
    (s) => (s.logs['2026-10-22'].iqos = '2'),
    (s) => (s.logs['2026-10-22'].craving = NaN),
    (s) => (s.logs = JSON.parse('{"__proto__":{}}'))
  ]) {
    const s = withDay(fixture());
    mutate(s);
    assert.throws(() => validateSyncState(s));
  }
});
test('preserves unconfirmed zero versus confirmed zero', () => {
  const s = withDay(fixture());
  s.logs['2026-10-22'].complete = false;
  assert.equal(validateSyncState(s).logs['2026-10-22'].complete, false);
});
test('large valid local journals remain usable while the cloud document size cap rejects upload', async () => {
  const { addDays } = await import('../src/logic.js');
  const s = fixture();
  for (let i = 0; i < 150; i++) {
    const d = addDays('2026-01-01', i);
    s.logs[d] = withDay(fixture(), d, '中'.repeat(3000)).logs[d];
  }
  assert.equal(validateSyncState(s), s);
  assert.ok(documentBytes({ formatVersion: 1, appState: s }) > 1048576);
  assert.throws(() => validateDocument({ formatVersion: 1, appState: s }));
});
