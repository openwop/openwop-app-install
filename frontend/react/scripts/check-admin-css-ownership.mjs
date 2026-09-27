#!/usr/bin/env node
/** ADR 0510 Phase 4 — admin chrome has one stylesheet owner. */
import { readFileSync } from 'node:fs';

const entry = readFileSync('src/styles/index.css', 'utf8');
const legacy = readFileSync('src/styles/global.css', 'utf8');
const admin = readFileSync('src/styles/chrome/admin.css', 'utf8');
const importLine = "@import './chrome/admin.css';";
const roots = ['.admin-shell', '.admin-rail', '.admin-nav', '.admin-content', '.admin-home', '.admin-directory', '.app-nav-group--admin'];

const problems = [];
if (!entry.includes(importLine)) problems.push(`styles/index.css must import ${importLine}`);
if (entry.indexOf(importLine) < entry.indexOf("@import './global.css';")) problems.push('admin.css must follow the shrinking legacy monolith');
for (const root of roots) {
  if (!admin.includes(root)) problems.push(`admin.css is missing ownership root ${root}`);
  if (legacy.includes(root)) problems.push(`global.css still owns ${root}`);
}
if (problems.length) {
  console.error('✗ check-admin-css-ownership:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`✓ check-admin-css-ownership: ${roots.length} admin selector families have one owner.`);
