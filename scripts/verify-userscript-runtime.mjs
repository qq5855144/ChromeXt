import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const separator = '// Kotlin separator\n\n';

function readAsset(name) {
  return fs.readFileSync(path.join(root, 'app/src/main/assets', name), 'utf8');
}

function declarationKey(chunk) {
  const first = chunk.split(/\r?\n/, 1)[0];
  const separatorToken = first.startsWith('function') ? '(' : ' =';
  return first.split(separatorToken)[0].trim().split(/\s+/).at(-1);
}

const baseChunks = readAsset('GM.js').split(separator).filter(Boolean);
const compatChunks = readAsset('GM_compat.js').split(separator).filter(Boolean);
const base = new Map(baseChunks.map((chunk) => [declarationKey(chunk), chunk]));
const compat = new Map(compatChunks.map((chunk) => [declarationKey(chunk), chunk]));
const merged = new Map([...base, ...compat]);

for (const key of ['globalThis', 'GM_cookie', 'GM.bootstrap']) {
  if (!merged.has(key)) throw new Error(`Missing runtime snippet: ${key}`);
}
for (const key of ['globalThis', 'GM_cookie']) {
  if (!compat.has(key)) throw new Error(`Compatibility override missing: ${key}`);
}

const globalCompat = compat.get('globalThis');
for (const grant of ['window.focus', 'window.onurlchange']) {
  if (!globalCompat.includes(grant)) throw new Error(`Missing ${grant} compatibility support`);
}

const cookieCompat = compat.get('GM_cookie');
for (const invariant of [
  'Network.getCookies',
  '{ urls: [url.href] }',
  'document.cookie',
  'HttpOnly and cross-origin cookies are unavailable',
  'Chrome DevTools cookie backend is unavailable',
]) {
  if (!cookieCompat.includes(invariant)) {
    throw new Error(`GM_cookie invariant missing: ${invariant}`);
  }
}

console.log(
  `Verified ${baseChunks.length} base snippets + ${compatChunks.length} compatibility overrides.`
);
