#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideSyncAction, shouldTreatConflictAsSynced } = require('../out/sync-state.js');

const cases = [
  {
    name: 'local matches cloud → noop',
    input: { localHash: 'a', cloudHash: 'a', lastSyncedHash: 'b', hasPendingLocalEdit: false },
    want: 'noop',
  },
  {
    name: 'cloud moved, local unchanged → pull',
    input: { localHash: 'a', cloudHash: 'b', lastSyncedHash: 'a', hasPendingLocalEdit: false },
    want: 'pull',
  },
  {
    name: 'local edited since last sync → push',
    input: { localHash: 'b', cloudHash: 'c', lastSyncedHash: 'a', hasPendingLocalEdit: false },
    want: 'push',
  },
  {
    name: 'pending edit blocks pull → push',
    input: { localHash: 'a', cloudHash: 'b', lastSyncedHash: 'a', hasPendingLocalEdit: true },
    want: 'push',
  },
  {
    name: 'no lastSynced, cloud differs → push (new local file)',
    input: { localHash: 'a', cloudHash: 'b', hasPendingLocalEdit: false },
    want: 'push',
  },
  {
    name: 'no lastSynced, matches cloud → noop',
    input: { localHash: 'a', cloudHash: 'a', hasPendingLocalEdit: false },
    want: 'noop',
  },
];

let failed = 0;
for (const c of cases) {
  const got = decideSyncAction(c.input);
  try {
    assert.equal(got, c.want);
    console.log(`✓ ${c.name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${c.name}: expected ${c.want}, got ${got}`);
  }
}

assert.equal(shouldTreatConflictAsSynced('x', 'x'), true);
assert.equal(shouldTreatConflictAsSynced('x', 'y'), false);
console.log('✓ shouldTreatConflictAsSynced');

process.exit(failed ? 1 : 0);
