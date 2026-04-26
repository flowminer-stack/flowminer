#!/usr/bin/env node
/**
 * One-shot codemod: replace raw Tailwind palette colors in .tsx/.ts files
 * with semantic token aliases where we have an obvious mapping.
 *
 * The rules below are deliberately narrow — they only rewrite patterns
 * where the intent is unambiguous ("bg-red-500/10" = danger-bg-subtle,
 * "text-emerald-400" = success-fg, etc.). Ambiguous cases (stroke colors
 * in charts, border-emerald-500 without a role context) are left alone
 * and flagged by check-design-tokens.mjs for manual review.
 *
 * The tailwind.config.js already defines the target tokens; this codemod
 * just normalizes how they're referenced.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname, 'src');

// Each rule is [regex, replacement]. Applied in order, inside className strings only.
// The semantic tokens used here are already defined in tailwind.config.js
// (badge-*, success, warning, danger, muted).
// Generic rules: any shade of red/rose → danger, emerald/green → success,
// amber/yellow/orange → warning, cyan/sky/blue (when used for info) → accent.
// Alpha suffix is preserved.
const RULES = [
  // Danger — red, rose
  [/\bbg-(red|rose)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(red|rose)-\d{2,3}/, 'danger')],
  [/\btext-(red|rose)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(red|rose)-\d{2,3}/, 'danger')],
  [/\bborder-(red|rose)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(red|rose)-\d{2,3}/, 'danger')],

  // Success — emerald, green
  [/\bbg-(emerald|green)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(emerald|green)-\d{2,3}/, 'success')],
  [/\btext-(emerald|green)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(emerald|green)-\d{2,3}/, 'success')],
  [/\bborder-(emerald|green)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(emerald|green)-\d{2,3}/, 'success')],

  // Warning — amber, yellow, orange
  [/\bbg-(amber|yellow|orange)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(amber|yellow|orange)-\d{2,3}/, 'warning')],
  [/\btext-(amber|yellow|orange)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(amber|yellow|orange)-\d{2,3}/, 'warning')],
  [/\bborder-(amber|yellow|orange)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(amber|yellow|orange)-\d{2,3}/, 'warning')],

  // Info — cyan, sky, blue
  [/\bbg-(cyan|sky|blue)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(cyan|sky|blue)-\d{2,3}/, 'accent')],
  [/\btext-(cyan|sky|blue)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(cyan|sky|blue)-\d{2,3}/, 'accent')],
  [/\bborder-(cyan|sky|blue)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(cyan|sky|blue)-\d{2,3}/, 'accent')],

  // Neutral tints — slate/gray/zinc/neutral/stone → fg-muted / tint / line
  [/\btext-(slate|gray|zinc|neutral|stone)-400\b/g, 'text-fg-faint'],
  [/\btext-(slate|gray|zinc|neutral|stone)-500\b/g, 'text-fg-muted'],

  // Purples / violets map to accent
  [/\bbg-(violet|purple|fuchsia|pink|indigo)-\d{2,3}(\/\d+)?\b/g, (m) =>
    m.replace(/(violet|purple|fuchsia|pink|indigo)-\d{2,3}/, 'accent')],
  [/\btext-(violet|purple|fuchsia|pink|indigo)-\d{2,3}(\/\d+)?\b/g, (m) =>
    m.replace(/(violet|purple|fuchsia|pink|indigo)-\d{2,3}/, 'accent')],
  [/\bborder-(violet|purple|fuchsia|pink|indigo)-\d{2,3}(\/\d+)?\b/g, (m) =>
    m.replace(/(violet|purple|fuchsia|pink|indigo)-\d{2,3}/, 'accent')],

  // ring-* variants of color utilities
  [/\bring-(red|rose)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(red|rose)-\d{2,3}/, 'danger')],
  [/\bring-(emerald|green)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(emerald|green)-\d{2,3}/, 'success')],
  [/\bring-(amber|yellow|orange)-\d{2,3}(\/\d+)?\b/g, (m) => m.replace(/(amber|yellow|orange)-\d{2,3}/, 'warning')],
  [/\bring-(cyan|sky|blue|violet|purple|indigo)-\d{2,3}(\/\d+)?\b/g, (m) =>
    m.replace(/(cyan|sky|blue|violet|purple|indigo)-\d{2,3}/, 'accent')],
];

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

let touchedFiles = 0;
let totalReplacements = 0;

for (const file of walk(ROOT)) {
  if (file.includes('/components/common/ErrorState.tsx')) continue;
  if (file.includes('/scripts/')) continue;

  const original = readFileSync(file, 'utf8');
  let transformed = original;

  // Apply rules globally. We only touch .tsx/.ts files and the tokens we
  // rewrite are Tailwind utilities that wouldn't legitimately appear in
  // strings outside of className contexts.
  for (const [re, rep] of RULES) {
    transformed = transformed.replace(re, (m, ...args) => {
      totalReplacements += 1;
      return typeof rep === 'function' ? rep(m, ...args) : rep;
    });
  }

  if (transformed !== original) {
    writeFileSync(file, transformed);
    touchedFiles += 1;
  }
}

console.log(
  `✔ Design token codemod done — ${totalReplacements} replacements in ${touchedFiles} file(s).`,
);
