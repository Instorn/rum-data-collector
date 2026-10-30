// package-cws.mjs - creates the Chrome Web Store upload package (.zip) from
// dist/extension/ (output of `npm run build`).
// dist/extension/ is read only and stays byte-for-byte identical; the ZIP is
// assembled in memory. Differences from dist/extension/:
//   - manifest.json without update_url and key (CWS manages updates itself);
//   - settings.json is not packed (store copy is configured by policy only).
// Output: dist/cws/<basename>-<version>.zip and a .files.txt report.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SRC_MANIFEST = join(ROOT, 'dev_extension', 'manifest.json');
const DIST_EXT = join(ROOT, 'dist', 'extension');
const CWS_DIR = join(ROOT, 'dist', 'cws');
const DIST_EXT_LABEL = 'dist/extension';

const PACKAGE_NAME = 'rum_data_collector';

const EXCLUDE = new Set(['settings.json']);
const FORBIDDEN_PERMISSIONS = ['tabs', 'activeTab'];
const ICON_SIZES = { 16: 16, 48: 48, 128: 128 };
// Fixed timestamp: the same dist/extension/ always gives the same ZIP bytes.
const ZIP_MTIME = new Date(2026, 0, 1, 0, 0, 0);

const EXIT_NO_DIST = 3;
const EXIT_STALE = 4;
const EXIT_SELF_CHECK = 5;

class ExitError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function toZipPath(full) {
  return relative(DIST_EXT, full).split(sep).join('/');
}

function pngSize(buf) {
  // PNG signature (8) + IHDR length/type (8) + width (4) + height (4)
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// Files the extension loads: manifest entries, popup.html script/link,
// and chrome.scripting.executeScript({ files: [...] }) in background.js.
function referencedFiles(manifest, files) {
  const req = new Set();
  const sw = manifest.background && manifest.background.service_worker;
  if (sw) req.add(sw);
  for (const cs of manifest.content_scripts || []) {
    for (const f of cs.js || []) req.add(f);
    for (const f of cs.css || []) req.add(f);
  }
  const popup = manifest.action && manifest.action.default_popup;
  if (popup) {
    req.add(popup);
    const html = files[popup] ? Buffer.from(files[popup]).toString('utf8') : '';
    for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) req.add(m[1]);
    for (const m of html.matchAll(/<link[^>]*\bhref="([^"]+)"/g)) req.add(m[1]);
  }
  for (const f of Object.values(manifest.icons || {})) req.add(f);
  const schema = manifest.storage && manifest.storage.managed_schema;
  if (schema) req.add(schema);
  if (sw && files[sw]) {
    const bg = Buffer.from(files[sw]).toString('utf8');
    for (const m of bg.matchAll(/files\s*:\s*\[([^\]]*)\]/g)) {
      for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) req.add(s[1]);
    }
  }
  return req;
}

function selfCheck(zipBytes, expected) {
  const errors = [];
  const warnings = [];
  const files = unzipSync(zipBytes);
  const names = Object.keys(files);

  if (!files['manifest.json']) {
    errors.push('manifest.json is not at the archive root');
    return { errors, warnings, count: names.length };
  }
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));

  if ('update_url' in manifest) errors.push('manifest.json contains update_url');
  if ('key' in manifest) errors.push('manifest.json contains key');
  const bad = FORBIDDEN_PERMISSIONS.filter(p => (manifest.permissions || []).includes(p));
  if (bad.length) errors.push(`forbidden permissions: ${bad.join(', ')}`);
  if (manifest.version !== expected.version) {
    errors.push(`version ${manifest.version} != ${DIST_EXT_LABEL} ${expected.version}`);
  }

  for (const n of names) {
    if (n.includes('\\')) errors.push(`backslash in archive path: ${n}`);
    if (EXCLUDE.has(n)) errors.push(`excluded file packed: ${n}`);
    if (n.endsWith('.pem')) errors.push(`private key packed: ${n}`);
    if (n.endsWith('.crx')) errors.push(`crx packed: ${n}`);
  }

  for (const f of [...referencedFiles(manifest, files)].sort()) {
    if (!files[f]) errors.push(`missing referenced file: ${f}`);
  }

  for (const [key, size] of Object.entries(ICON_SIZES)) {
    const icon = manifest.icons && manifest.icons[key];
    if (!icon || !files[icon]) {
      errors.push(`icon ${key} is not declared or missing`);
      continue;
    }
    const wh = pngSize(Buffer.from(files[icon]));
    if (!wh || wh[0] !== size || wh[1] !== size) {
      errors.push(`icon ${icon} is ${wh ? wh.join('x') : 'not a PNG'}, expected ${size}x${size}`);
    }
  }

  // Localization: every __MSG_key__ of the manifest exists in the default locale,
  // all locales have the same keys, store name <= 75 and description <= 132 chars in each locale.
  const msgRefs = [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map(m => m[1]);
  if (msgRefs.length && !manifest.default_locale) errors.push('manifest uses __MSG_*__ but has no default_locale');
  if (manifest.default_locale) {
    const locales = {};
    for (const n of names) {
      const m = n.match(/^_locales\/([^/]+)\/messages\.json$/);
      if (!m) continue;
      try { locales[m[1]] = JSON.parse(Buffer.from(files[n]).toString('utf8')); }
      catch (e) { errors.push(`invalid JSON: ${n}`); }
    }
    const def = locales[manifest.default_locale];
    if (!def) {
      errors.push(`_locales/${manifest.default_locale}/messages.json is missing`);
    } else {
      for (const k of msgRefs) if (!def[k]) errors.push(`__MSG_${k}__ is missing in _locales/${manifest.default_locale}`);
      const defKeys = Object.keys(def).sort().join(',');
      for (const [loc, msgs] of Object.entries(locales)) {
        if (Object.keys(msgs).sort().join(',') !== defKeys) errors.push(`_locales/${loc}: keys differ from ${manifest.default_locale}`);
        const msgOf = v => { const r = /^__MSG_(.+)__$/.exec(v || ''); return r ? (msgs[r[1]] && msgs[r[1]].message) || '' : v || ''; };
        if (msgOf(manifest.name).length > 75) errors.push(`_locales/${loc}: name longer than 75 chars`);
        if (msgOf(manifest.description).length > 132) errors.push(`_locales/${loc}: description longer than 132 chars`);
      }
    }
  }

  // Everything except manifest.json must be byte-identical to dist/extension/.
  for (const n of names) {
    if (n === 'manifest.json') continue;
    const onDisk = join(DIST_EXT, ...n.split('/'));
    if (!existsSync(onDisk) || sha256(readFileSync(onDisk)) !== sha256(files[n])) {
      errors.push(`differs from ${DIST_EXT_LABEL}: ${n}`);
    }
  }

  // Remote code: CWS forbids executing code that is not in the package.
  for (const n of names) {
    const text = Buffer.from(files[n]).toString('utf8');
    if (n.endsWith('.html') && /<script[^>]*\bsrc=["']https?:/i.test(text)) {
      errors.push(`external <script src> in ${n}`);
    }
    if (!n.endsWith('.js')) continue;
    if (/\beval\s*\(/.test(text)) errors.push(`eval( in ${n}`);
    if (/\bnew\s+Function\s*\(/.test(text)) errors.push(`new Function( in ${n}`);
    if (/\bnew\s+Worker\s*\(/.test(text) || /createObjectURL\s*\(/.test(text)) {
      warnings.push(`new Worker / createObjectURL in ${n} (fflate async API, not called by the extension)`);
    }
  }

  return { errors, warnings, count: names.length };
}

function main() {
  const distManifestPath = join(DIST_EXT, 'manifest.json');
  if (!existsSync(distManifestPath)) {
    throw new ExitError(`${DIST_EXT_LABEL}/manifest.json not found. Run build-extension.cmd (or npm run build) first.`, EXIT_NO_DIST);
  }
  const distManifest = readJson(distManifestPath);
  const version = distManifest.version;

  const srcVersion = readJson(SRC_MANIFEST).version;
  if (srcVersion !== version) {
    throw new ExitError(
      `${DIST_EXT_LABEL} is stale: version ${version}, dev_extension/manifest.json ${srcVersion}. ` +
      'Run build-extension.cmd (or npm run build) again.',
      EXIT_STALE,
    );
  }

  const storeManifest = { ...distManifest };
  delete storeManifest.update_url;
  delete storeManifest.key;

  const zipInput = {};
  const report = [];
  for (const full of listFiles(DIST_EXT).sort()) {
    const name = toZipPath(full);
    if (EXCLUDE.has(name)) {
      report.push(`excluded  ${name}`);
      continue;
    }
    const data = name === 'manifest.json'
      ? Buffer.from(`${JSON.stringify(storeManifest, null, 2)}\n`, 'utf8')
      : readFileSync(full);
    zipInput[name] = [new Uint8Array(data), { mtime: ZIP_MTIME }];
    report.push(`${name === 'manifest.json' ? 'modified' : 'same    '}  ${sha256(data)}  ${name}`);
  }

  const zipBytes = zipSync(zipInput, { level: 9 });
  const { errors, warnings, count } = selfCheck(zipBytes, { version });

  mkdirSync(CWS_DIR, { recursive: true });
  const base = `${PACKAGE_NAME}-${version}`;
  const zipOut = join(CWS_DIR, `${base}.zip`);
  const reportOut = join(CWS_DIR, `${base}.files.txt`);

  if (errors.length) {
    console.error('[cws] SELF-CHECK FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    throw new ExitError('self-check failed; ZIP is not written', EXIT_SELF_CHECK);
  }

  writeFileSync(zipOut, zipBytes);
  writeFileSync(reportOut, [
    `package   ${base}.zip`,
    `sha256    ${sha256(zipBytes)}`,
    `version   ${version}`,
    '',
    ...report,
    '',
  ].join('\n'));

  for (const w of warnings) console.log(`[cws] warning: ${w}`);
  console.log(`[cws] version=${version}`);
  console.log(`[cws] files=${count}`);
  console.log(`[cws] zip=${zipOut}`);
  console.log(`[cws] sha256=${sha256(zipBytes)}`);
  console.log(`[cws] report=${reportOut}`);
  console.log('[cws] self-check OK');
}

try {
  main();
} catch (err) {
  console.error('[cws] failed:', err && err.message ? err.message : err);
  process.exit(err && err.code ? err.code : 1);
}
