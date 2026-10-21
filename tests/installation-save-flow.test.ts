import test from 'node:test';
import assert from 'node:assert/strict';
import { runInstallationSavePlan } from '../src/installation-save-flow.ts';
import type { InstallationDetails } from '../src/installation-types.ts';
import type { InstallationSectionOperation } from '../src/installation-client.ts';

const initial: InstallationDetails = { id: 'fixture', imported: true, revision: 3, sections: [] };

test('save plan executes mutations serially with the latest revision and acknowledges only responses received', async () => {
  const operations: InstallationSectionOperation[] = [
    { kind: 'row-delete', id: 'row-1' },
    { kind: 'note-delete', id: 'note-1' },
  ];
  const requests: number[] = [];
  const committed: InstallationSectionOperation[] = [];
  const result = await runInstallationSavePlan(
    operations,
    initial,
    async (_operation, latest) => {
      requests.push(latest.revision);
      return { ...latest, revision: latest.revision + 1 };
    },
    (operation) => committed.push(operation),
    () => false,
  );
  assert.deepEqual(requests, [3, 4]);
  assert.deepEqual(committed, operations);
  assert.equal(result.saved, 2);
  assert.equal(result.latest.revision, 5);
  assert.equal(result.failure, undefined);
});

test('save plan stops on uncertain results without retrying or acknowledging that operation', async () => {
  const operations: InstallationSectionOperation[] = [
    { kind: 'note-create', localId: 'note-local', content: 'new note' },
    { kind: 'row-delete', id: 'row-1' },
  ];
  const error = new Error('connection lost');
  const committed: InstallationSectionOperation[] = [];
  let attempts = 0;
  const result = await runInstallationSavePlan(
    operations,
    initial,
    async (_operation, latest) => {
      attempts += 1;
      if (attempts === 1) return { ...latest, revision: 4 };
      throw error;
    },
    (operation) => committed.push(operation),
    (failure) => failure === error,
  );
  assert.equal(attempts, 2);
  assert.deepEqual(committed, [operations[0]]);
  assert.equal(result.saved, 1);
  assert.equal(result.latest.revision, 4);
  assert.deepEqual(result.failure, { operation: operations[1], error, uncertain: true });
});
