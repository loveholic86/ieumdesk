import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every literal Korean string passed to t() must have an English entry. The reviewer found a
 * missing key only on a machine that had tests/i18n.test.ts, so this repo keeps its own guard.
 */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Only literal first arguments: a template or variable key cannot be checked statically. */
function literalKeys(source: string) {
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
    const key = match[1].replace(/\\'/g, "'");
    // A trailing-space fragment is part of a composed sentence ({t('등록된 ')}{n}), not a key.
    if (!/^[가-힣«《]/.test(key) || /\s$/.test(key)) continue;
    keys.add(key);
  }
  return keys;
}

test('every literal Korean t() key has an English translation', () => {
  const root = new URL('..', import.meta.url).pathname;
  const english = readFileSync(path.join(root, 'src/locales/en.ts'), 'utf8');
  // Keys are stored either quoted or as bare identifiers.
  const defined = (key: string) => {
    if (english.includes(`'${key}'`) || english.includes(`'${key}':`)) return true;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*${escaped}:`, 'm').test(english);
  };
  const missing: string[] = [];
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const source = readFileSync(file, 'utf8');
    for (const key of literalKeys(source))
      if (!defined(key)) missing.push(`${key} (${path.relative(root, file)})`);
  }
  assert.deepEqual(missing, []);
});
