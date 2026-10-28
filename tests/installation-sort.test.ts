import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareSystemCode,
  installationSystemCodeYear,
  sortInstallations,
} from '../src/installation-sort.ts';

test('a plausible install year is read out of the system code', () => {
  assert.equal(installationSystemCodeYear('YETA-CLOUD-2026'), 2026);
  assert.equal(installationSystemCodeYear('2025-ACME'), 2025);
  assert.equal(installationSystemCodeYear('SYS_1990'), 1990);
  assert.equal(installationSystemCodeYear('sys-2099'), 2099);
  assert.equal(installationSystemCodeYear('SYS-20260001'), 2026);
  assert.equal(installationSystemCodeYear('SYS-012026'), 2026);
});

test('codes without a plausible year yield nothing', () => {
  assert.equal(installationSystemCodeYear('DEMO-SYS-12'), undefined);
  assert.equal(installationSystemCodeYear('OLD-SETUP-1989'), undefined);
  assert.equal(installationSystemCodeYear('SYS-2100'), undefined);
  assert.equal(installationSystemCodeYear('YETA'), undefined);
  assert.equal(installationSystemCodeYear(''), undefined);
  assert.equal(installationSystemCodeYear(undefined), undefined);
  // A 3-digit run is not a year, and digits split by a letter are never stitched together.
  assert.equal(installationSystemCodeYear('SYS-202'), undefined);
  assert.equal(installationSystemCodeYear('SYS-20-26'), undefined);
});

test('the newest year wins when a code carries several', () => {
  assert.equal(installationSystemCodeYear('ACME-2022-2026'), 2026);
  assert.equal(installationSystemCodeYear('ACME-2026-2022'), 2026);
  assert.equal(installationSystemCodeYear('1995-2001-2003'), 2003);
});

const row = (systemCode: string, updatedAt = '2026-01-01T00:00:00.000Z') => ({ systemCode, updatedAt });

test('dated rows come first, newest year first, and undated rows follow', () => {
  const sorted = sortInstallations([
    row('DEMO-SYS-3'),
    row('ACME-2024'),
    row('DEMO-SYS-1'),
    row('ACME-2026'),
    row('ACME-2025'),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.systemCode),
    ['ACME-2026', 'ACME-2025', 'ACME-2024', 'DEMO-SYS-1', 'DEMO-SYS-3'],
  );
});

test('undated rows keep the previous most recently updated first order', () => {
  const sorted = sortInstallations([
    { systemCode: 'DEMO-SYS-1', updatedAt: '2026-01-01T00:00:00.000Z' },
    { systemCode: 'DEMO-SYS-2', updatedAt: '2026-05-01T00:00:00.000Z' },
    { systemCode: 'DEMO-SYS-3', createdAt: '2026-03-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(
    sorted.map((item) => item.systemCode),
    ['DEMO-SYS-2', 'DEMO-SYS-3', 'DEMO-SYS-1'],
  );
});

test('rows sharing a year are ordered by system code, never by load order', () => {
  const codes = ['ACME-2026-B', 'ACME-2026-A', 'ACME-2025'];
  const forward = sortInstallations(codes.map((code) => row(code)));
  const backward = sortInstallations([...codes].reverse().map((code) => row(code)));
  assert.deepEqual(
    forward.map((item) => item.systemCode),
    ['ACME-2026-A', 'ACME-2026-B', 'ACME-2025'],
  );
  assert.deepEqual(
    backward.map((item) => item.systemCode),
    forward.map((item) => item.systemCode),
  );
});

test('a numeric run inside a code compares by value, not character by character', () => {
  assert.ok(compareSystemCode('SYS-2', 'SYS-10') < 0);
  assert.ok(compareSystemCode('SYS-10', 'SYS-2') > 0);
  assert.equal(compareSystemCode('SYS-2', 'SYS-2'), 0);
  assert.ok(compareSystemCode('ACME', 'ACME-A') < 0);
});

test('year boundaries sort newest first and never depend on the input order', () => {
  const sorted = sortInstallations([row('SYS-2099'), row('SYS-1990'), row('SYS-2026')]);
  assert.deepEqual(
    sorted.map((item) => item.systemCode),
    ['SYS-2099', 'SYS-2026', 'SYS-1990'],
  );
});

test('the input array is left untouched', () => {
  const rows = [row('ACME-2024'), row('ACME-2026')];
  const sorted = sortInstallations(rows);
  assert.deepEqual(
    rows.map((item) => item.systemCode),
    ['ACME-2024', 'ACME-2026'],
  );
  assert.notEqual(sorted, rows);
});
