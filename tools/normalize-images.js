#!/usr/bin/env node
// tools/normalize-images.js
// Usage:
//  node tools/normalize-images.js        # dry-run (report only)
//  node tools/normalize-images.js --apply  # apply fixes to local files
// This script scans JSON files under `data/` and `backups/` for product objects
// and normalizes image fields: `image`, `images` (array), and nested `colors`/`variants`.

const fs = require('fs');
const path = require('path');

const SIZE_CAP = 900 * 1024; // 900 KB
const PLACEHOLDER = 'IMAGE/NIKE1.png';

function isBase64CharSafe(s) {
  return /^[A-Za-z0-9+/=\n\r\s]+$/.test(s);
}

function normalizeDataUri(src) {
  if (!src || typeof src !== 'string') return null;
  let s = String(src).trim();
  // If not a data: URI, return as-is (we only validate inline data URIs)
  if (!s.startsWith('data:')) return s;
  // Collapse whitespace/newlines in base64
  s = s.replace(/\s+/g, '');
  // Ensure ';base64,' exists
  const idx = s.indexOf(';base64,');
  if (idx === -1) return null;
  const meta = s.slice(5, idx); // after 'data:'
  const b64 = s.slice(idx + ';base64,'.length);
  if (!b64) return null;
  if (!isBase64CharSafe(b64)) return null;
  // Size check
  try {
    // approximate decoded size: (b64.length * 3) / 4
    const approx = Math.floor((b64.length * 3) / 4);
    if (approx > SIZE_CAP) {
      // too large
      return null;
    }
  } catch (e) {
    return null;
  }
  // Return cleaned data URI
  return `data:${meta};base64,${b64}`;
}

function normalizeImageField(value) {
  if (Array.isArray(value)) {
    const out = value.map(v => normalizeImageField(v)).filter(Boolean);
    return out;
  }
  if (typeof value === 'string') {
    const ok = normalizeDataUri(value);
    if (ok === null) {
      // invalid inline dataUri — return null to indicate removal
      return null;
    }
    return ok;
  }
  // leave other types unchanged
  return value;
}

function walkAndNormalize(obj, changes, ctxPath) {
  if (!obj || typeof obj !== 'object') return obj;
  // Handle common image container fields
  const fieldsToNormalize = ['image', 'img', 'images'];
  for (const f of fieldsToNormalize) {
    if (Object.prototype.hasOwnProperty.call(obj, f)) {
      const before = obj[f];
      const after = normalizeImageField(before);
      // If after is null, remove the field
      if (after === null) {
        delete obj[f];
        changes.push({ path: ctxPath.concat(f).join('.'), before, after: null });
      } else if (JSON.stringify(after) !== JSON.stringify(before)) {
        obj[f] = after;
        changes.push({ path: ctxPath.concat(f).join('.'), before, after });
      }
    }
  }
  // Special handling for colors/variants arrays
  const nestedArrays = ['colors', 'variants'];
  for (const na of nestedArrays) {
    if (Array.isArray(obj[na])) {
      obj[na].forEach((entry, idx) => {
        walkAndNormalize(entry, changes, ctxPath.concat([na, String(idx)]));
      });
    }
  }
  // Generic recursion for other nested objects/arrays
  Object.keys(obj).forEach(k => {
    const v = obj[k];
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        v.forEach((it, i) => {
          if (it && typeof it === 'object') walkAndNormalize(it, changes, ctxPath.concat([k, String(i)]));
        });
      } else {
        walkAndNormalize(v, changes, ctxPath.concat(k));
      }
    }
  });
}

function scanFile(filePath, apply) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    let data;
    try { data = JSON.parse(raw); } catch (e) { console.warn('Skipping non-json file', filePath); return null; }
    const changes = [];
    if (Array.isArray(data)) {
      data.forEach((item, idx) => walkAndNormalize(item, changes, [path.basename(filePath), String(idx)]));
    } else if (data && typeof data === 'object') {
      walkAndNormalize(data, changes, [path.basename(filePath)]);
    }
    if (changes.length > 0) {
      console.log(`\nFile: ${filePath} → ${changes.length} change(s)`);
      changes.forEach(c => {
        console.log(` - ${c.path}: ${c.before && c.before.length && typeof c.before === 'string' && c.before.length > 120 ? (c.before.slice(0,120)+'...[len:'+c.before.length+']') : JSON.stringify(c.before)} -> ${c.after === null ? '<removed>' : (typeof c.after === 'string' && c.after.length>120 ? (c.after.slice(0,120)+'...[len:'+c.after.length+']') : JSON.stringify(c.after))}`);
      });
      if (apply) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        console.log(' → Applied changes to', filePath);
      }
    }
    return changes;
  } catch (e) {
    console.error('scanFile error', filePath, e);
    return null;
  }
}

function findJsonFiles(rootDirs) {
  const found = [];
  for (const d of rootDirs) {
    try {
      const abs = path.resolve(d);
      if (!fs.existsSync(abs)) continue;
      const entries = fs.readdirSync(abs);
      entries.forEach(name => {
        const p = path.join(abs, name);
        try {
          const stat = fs.statSync(p);
          if (stat.isFile() && p.toLowerCase().endsWith('.json')) found.push(p);
          else if (stat.isDirectory()) {
            // recurse one level (backups can be nested)
            fs.readdirSync(p).forEach(sub => {
              const sp = path.join(p, sub);
              try { if (fs.statSync(sp).isFile() && sp.toLowerCase().endsWith('.json')) found.push(sp); } catch(e){}
            });
          }
        } catch(e){}
      });
    } catch (e) { /* ignore */ }
  }
  return found;
}

function usageAndExit() {
  console.log('Usage: node tools/normalize-images.js [--apply]');
  process.exit(0);
}

(function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply') || args.includes('-a');
  if (args.includes('--help') || args.includes('-h')) usageAndExit();
  const roots = ['data', 'backups', 'backups/backup-main-20260125_165702'];
  const files = findJsonFiles(roots);
  if (!files.length) {
    console.log('No JSON files found under:', roots.join(', '));
    return;
  }
  console.log('Found', files.length, 'JSON file(s). Dry-run only', apply ? '(apply mode enabled)' : '(dry-run)');
  let total = 0;
  let changedFiles = 0;
  for (const f of files) {
    const changes = scanFile(f, apply);
    if (changes && changes.length) { total += changes.length; changedFiles++; }
  }
  console.log('\nSummary: changed files:', changedFiles, 'total changes:', total);
  if (!apply) console.log('Run with --apply to write changes to the JSON files');
})();
