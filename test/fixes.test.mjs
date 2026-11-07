import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adviseFix, applyRepair, applyRepairs, chooseFix, describeFix, setFix, fixFields,
} from '../archify/renderers/shared/fixes.mjs';

test('fixes: describe keeps the text agents already read', () => {
  assert.deepEqual(describeFix(setFix('/messages/2/y', 182)), ['set /messages/2/y to 182']);
  assert.deepEqual(describeFix(setFix('/meta/viewBox', [960, 540])), ['set /meta/viewBox to [960, 540]']);
  assert.deepEqual(
    describeFix(setFix('/messages/1/from', 'db', { label: 'verified node id' })),
    ['set /messages/1/from to verified node id "db"'],
  );
  assert.deepEqual(describeFix(chooseFix([setFix('/a', 1), setFix('/a', 2)])), ['set /a to 1', 'set /a to 2']);
  assert.deepEqual(
    describeFix(setFix('/segments/0/to', 204, { note: 'to leave the message above it' })),
    ['set /segments/0/to to 204 to leave the message above it'],
  );
  assert.deepEqual(describeFix(adviseFix('shorten the note')), ['shorten the note']);
});

test('fixes: split turns typed fixes into text plus edits and leaves plain text alone', () => {
  const { supportedFixes, edits } = fixFields([
    setFix('/messages/1/from', 'db', { label: 'verified node id' }),
    adviseFix('shorten the note'),
    'provide one readable JSON input file',
  ]);
  assert.deepEqual(supportedFixes, [
    'set /messages/1/from to verified node id "db"',
    'shorten the note',
    'provide one readable JSON input file',
  ]);
  assert.deepEqual(edits, [{ op: 'set', pointer: '/messages/1/from', value: 'db' }]);
  assert.deepEqual(fixFields(['only advice']), { supportedFixes: ['only advice'] });
});

test('fixes: a repair writes exact JSON values and leaves the input untouched', () => {
  const candidate = { meta: { viewBox: [960, 400] }, messages: [{ y: 150 }, { y: 160 }] };
  const result = applyRepair(candidate, [
    { op: 'set', pointer: '/messages/1/y', value: 178 },
    { op: 'set', pointer: '/meta/viewBox', value: [960, 540] },
    { op: 'set', pointer: '/messages/0/from', value: 'db' },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidate, { meta: { viewBox: [960, 540] }, messages: [{ y: 150, from: 'db' }, { y: 178 }] });
  assert.deepEqual(candidate.messages[1], { y: 160 });
});

test('fixes: a repair applies whole or not at all', () => {
  const candidate = { messages: [{ y: 150 }] };
  const missingParent = applyRepair(candidate, [
    { op: 'set', pointer: '/messages/0/y', value: 178 },
    { op: 'set', pointer: '/segments/0/to', value: 200 },
  ]);
  assert.equal(missingParent.ok, false);
  assert.match(missingParent.reason, /no existing parent/);
  assert.equal(applyRepair(candidate, [{ op: 'set', pointer: '/messages/4', value: {} }]).ok, false);
  assert.equal(applyRepair(candidate, [{ op: 'set', pointer: 'messages/0/y', value: 1 }]).ok, false);
});

test('fixes: choices and advice are left for the agent', () => {
  const candidate = { messages: [{ from: 'dbx', y: 150 }, { y: 160 }] };
  const choice = fixFields([chooseFix([
    setFix('/messages/0/from', 'db', { label: 'verified node id' }),
    setFix('/messages/0/from', 'cache', { label: 'verified node id' }),
  ])]);
  const result = applyRepairs(candidate, [
    { code: 'sequence/unknown-endpoint', severity: 'error', edits: choice.edits },
    { code: 'engineering/deployment-owner-missing', severity: 'error', edits: [] },
    { code: 'sequence/message-spacing', severity: 'error', edits: [{ op: 'set', pointer: '/messages/1/y', value: 178 }] },
    { code: 'sequence/note-overlap', severity: 'error', edits: [{ op: 'set', pointer: '/messages/1/y', value: 190 }] },
  ]);
  assert.deepEqual(result.candidate, { messages: [{ from: 'dbx', y: 150 }, { y: 178 }] });
  assert.deepEqual(result.applied.map((entry) => entry.code), ['sequence/message-spacing']);
  assert.deepEqual(result.skipped.map((entry) => entry.code), [
    'sequence/unknown-endpoint', 'engineering/deployment-owner-missing', 'sequence/note-overlap',
  ]);
});
