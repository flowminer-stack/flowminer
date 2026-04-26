#!/usr/bin/env node
/**
 * Design token enforcement — fails CI if a .tsx file uses raw Tailwind
 * color utilities instead of the project's semantic tokens.
 *
 * Allowed: bg-surface-1, text-fg-muted, border-line, bg-accent, badge-emerald, ...
 * Disallowed: bg-emerald-500, text-red-400, bg-amber-500/10, ...
 *
 * The enforcement is intentionally conservative — we only flag the common
 * Tailwind palette names (slate/gray/red/orange/amber/yellow/lime/green/
 * emerald/teal/cyan/sky/blue/indigo/violet/purple/fuchsia/pink/rose) behind
 * bg-/text-/border-/ring-/fill-/stroke- prefixes. Semantic shortcuts
 * (bg-surface-*, text-fg-*, border-line, accent-*) pass through.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname, 'src');

const PALETTE = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime',
  'green', 'emerald', 'teal', 'cyan', 'sky',
  'blue', 'indigo', 'violet', 'purple', 'fuchsia',
  'pink', 'rose',
];
const PREFIXES = ['bg', 'text', 'border', 'ring', 'fill', 'stroke', 'from', 'to', 'via', 'decoration', 'divide', 'outline', 'shadow'];

// Build a regex that matches e.g. `bg-emerald-500` or `text-red-400/10` inside a className string.
const PATTERN = new RegExp(
  `\\b(${PREFIXES.join('|')})-(${PALETTE.join('|')})-\\d{2,3}(/\\d+)?\\b`,
  'g',
);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const violations = [];

for (const file of files) {
  // Skip the token check itself and anything under components/common/ErrorState
  // (the error component is allowed to use literal red utilities for the
  // strongly-themed alert — there's no semantic "error" token yet).
  if (file.includes('/components/common/ErrorState.tsx')) continue;
  if (file.includes('/scripts/check-design-tokens.mjs')) continue;

  const content = readFileSync(file, 'utf8');
  // Only look inside class name strings: className="..." or className={`...`}
  const classRegex = /className\s*=\s*(?:"([^"]*)"|`([^`]*)`|\{clsx\(([^)]*)\)\})/g;
  let m;
  while ((m = classRegex.exec(content)) !== null) {
    const hay = m[1] || m[2] || m[3] || '';
    const matches = hay.match(PATTERN);
    if (matches) {
      const line = content.slice(0, m.index).split('\n').length;
      violations.push({ file: file.replace(ROOT + '/', ''), line, tokens: [...new Set(matches)] });
    }
  }
}

if (violations.length === 0) {
  console.log(`✔ Design tokens clean — scanned ${files.length} files.`);
  process.exit(0);
}

// Group by file for a compact report
const byFile = new Map();
for (const v of violations) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file).push(v);
}

console.error(`✖ Design token violations in ${byFile.size} file(s):`);
for (const [file, vs] of byFile) {
  console.error(`  ${file}`);
  for (const v of vs) {
    console.error(`    line ${v.line}: ${v.tokens.join(', ')}`);
  }
}
console.error(
  `\nUse semantic tokens (bg-surface-*, text-fg-*, border-line, accent) instead ` +
    `of raw palette colors. If you truly need a new color, add it to tailwind.config.js.`,
);

process.exit(1);
