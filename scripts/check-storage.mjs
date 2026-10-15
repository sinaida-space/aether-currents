// Checks that legal/storage.json, the code, and the public texts list the same localStorage keys.
// Run: node scripts/check-storage.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'legal/storage.json'), 'utf8'));
const expected = new Set(manifest.keys.map(k => k.key));

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

const inCode = new Set();
for (const file of walk(join(root, 'js'))) {
  for (const m of readFileSync(file, 'utf8').matchAll(/['"`](ac\.[A-Za-z]+)['"`]/g)) inCode.add(m[1]);
}

const inTexts = new Map();
for (const file of manifest.texts) {
  const html = readFileSync(join(root, file), 'utf8');
  inTexts.set(file, new Set([...html.matchAll(/<code>(ac\.[A-Za-z]+)<\/code>/g)].map(m => m[1])));
}

const problems = [];
const diff = (a, b) => [...a].filter(x => !b.has(x));
for (const k of diff(inCode, expected)) problems.push(`code writes ${k}, not in storage.json`);
for (const k of diff(expected, inCode)) problems.push(`storage.json lists ${k}, not found in js/`);
for (const [file, keys] of inTexts) {
  for (const k of diff(expected, keys)) problems.push(`${file} does not list ${k}`);
  for (const k of diff(keys, expected)) problems.push(`${file} lists ${k}, not in storage.json`);
}

if (problems.length) {
  console.error(problems.map(p => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${expected.size} keys match code and ${manifest.texts.length} texts`);
