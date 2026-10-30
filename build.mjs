// build.mjs — детерминированная сборка RUM Data Collector (Chrome MV3 extension).
// Запуск: `npm run build` (одноразовая сборка) или `npm run dev` (--watch).
// Вывод — dist/extension/.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, watch as fsWatch, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SRC = join(ROOT, 'dev_extension');
const DIST = join(ROOT, 'dist');
const DIST_EXT = join(DIST, 'extension');
const FRAGMENT_SEPARATOR = '\n;\n';

// Каталоги dist/, которые сборка чистит перед записью (ZIP для магазина собирается заново).
const CLEAN_DIRS = ['extension', 'cws'];

// ─── Vendor → npm prelude mapping ───────────────────────────────────────
// Пути lib/* в порядке сборки распознаются как vendor placeholders и при
// бандле подменяются на npm-prelude (IIFE), а сами vendor-файлы в dist не
// попадают. dev_extension/ всё ещё содержит vendor-файлы — для прямой
// unpacked-загрузки в Chrome без сборки.

const VENDOR_PRELUDE_MAP = {
  'lib/fflate.umd.js': {
    entry: `import * as fflate from 'fflate';\nglobalThis.fflate = fflate;\n`,
    label: 'fflate',
  },
  'lib/web-vitals.iife.js': {
    entry: `import * as webVitals from 'web-vitals';\nglobalThis.webVitals = webVitals;\n`,
    label: 'web-vitals',
  },
};

const RUMSANITIZE_AFTER = 'services/analysis/sanitizeText.js';
const RUMSANITIZE_BRIDGE = `if (typeof RumSanitize === 'undefined') {\n  throw new Error('RumSanitize is not defined after services/analysis/sanitizeText.js');\n}\nglobalThis.RumSanitize = RumSanitize;\n`;

// Статика, копируемая в dist/extension/ один-в-один.
const STATIC_ROOT_FILES = [
  'popup.html',
  'popup.css',
  'popup.js',
  'schema.json',
  'settings.json',
  'icon16.png',
  'icon48.png',
  'icon128.png',
];

// Файлы из services/, копируемые отдельно (не бандлятся).
const STATIC_NESTED_FILES = [
  'metrics/registry.js',                       // popup.html подгружает напрямую
];

// Каталоги, копируемые целиком.
const STATIC_DIRS = [
  '_locales',                                  // переводы интерфейса; manifest ссылается на __MSG_*__
];

// Watch-набор: файлы и директории.
// Пути относительно SRC (dev_extension/), кроме WATCH_FILES_ROOT — те относительно ROOT.
// package.json НЕ отслеживается: версия берётся из dev_extension/manifest.json
// и build.mjs пишет её в package.json — обратное отслеживание создало бы цикл.
const WATCH_FILES_ROOT = [];
const WATCH_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'schema.json',
  'settings.json',
  'icon16.png',
  'icon48.png',
  'icon128.png',
];
const WATCH_DIRS = ['services', 'metrics', 'lib', '_locales'];

// ─── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  return { watch: argv.includes('--watch') };
}

// ─── Pre-flight ─────────────────────────────────────────────────────────

function preflightEsbuild() {
  if (!existsSync(join(ROOT, 'node_modules', 'esbuild'))) {
    console.error('node_modules/esbuild не найден. Выполните: npm ci --ignore-scripts --include=dev --include=optional');
    process.exit(1);
  }
}

// ─── Версия ─────────────────────────────────────────────────────────────
// Источник правды — dev_extension/manifest.json. package.json синхронизируется
// автоматически (чтобы npm видел актуальную версию).

function readManifestVersion(manifest) {
  validateChromeManifestVersion(manifest.version);
  return manifest.version;
}

function syncPackageJsonVersion(version) {
  const pkgPath = join(ROOT, 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  if (pkg.version === version) return false;
  const updated = raw.replace(
    /("version"\s*:\s*")([^"]+)(")/,
    `$1${version}$3`,
  );
  if (!/"version"\s*:\s*"/.test(raw) || updated === raw) {
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  } else {
    writeFileSync(pkgPath, updated);
  }
  return true;
}

// Chrome manifest.version: 1..4 целых, каждое 0..65535, без ведущих нулей у ненулевых,
// не вся строка из нулей, без prerelease/build metadata (-/+).
function validateChromeManifestVersion(v) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Invalid package.json version: expected non-empty string, got ${JSON.stringify(v)}`);
  }
  if (v.includes('-') || v.includes('+')) {
    throw new Error(`Invalid Chrome manifest.version "${v}": prerelease/build metadata not allowed. Use plain X.Y.Z.`);
  }
  const parts = v.split('.');
  if (parts.length < 1 || parts.length > 4) {
    throw new Error(`Invalid Chrome manifest.version "${v}": expected 1..4 dot-separated integers.`);
  }
  let allZero = true;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) {
      throw new Error(`Invalid Chrome manifest.version "${v}": part "${p}" is not a non-negative integer.`);
    }
    if (p.length > 1 && p.startsWith('0')) {
      throw new Error(`Invalid Chrome manifest.version "${v}": part "${p}" has a leading zero.`);
    }
    const n = Number(p);
    if (n < 0 || n > 65535) {
      throw new Error(`Invalid Chrome manifest.version "${v}": part "${p}" is out of 0..65535 range.`);
    }
    if (n !== 0) allZero = false;
  }
  if (allZero) {
    throw new Error(`Invalid Chrome manifest.version "${v}": all parts are zero.`);
  }
}

// ─── Парсер importScripts(...) ──────────────────────────────────────────

// Находит первый блок importScripts(...) в тексте, извлекает строковые
// литералы по порядку. Без eval/new Function. Не учитывает escapes (для
// текущего background.js не требуется — там только простые имена файлов).
// Валидирует токены: разрешены только строковые литералы и запятые-разделители;
// whitespace и //-комментарии игнорируются. Любой другой токен (идентификатор,
// число, пропущенная запятая) приводит к понятной malformed-ошибке.
function parseImportScripts(backgroundJsText) {
  const startToken = 'importScripts(';
  const startIdx = backgroundJsText.indexOf(startToken);
  if (startIdx === -1) {
    throw new Error('Build: importScripts(...) not found in background.js');
  }
  const bodyStart = startIdx + startToken.length;
  const out = [];
  // expect: что должен быть следующим значимым токеном.
  // 'string' — строковый литерал (начало или после запятой); 'comma' — запятая
  // или закрывающая скобка (после строкового литерала).
  let expect = 'string';
  let i = bodyStart;
  let bodyEnd = -1;
  while (i < backgroundJsText.length) {
    const ch = backgroundJsText[i];
    // whitespace — пропустить.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    // //-комментарий до конца строки.
    if (ch === '/' && backgroundJsText[i + 1] === '/') {
      const nl = backgroundJsText.indexOf('\n', i);
      i = nl === -1 ? backgroundJsText.length : nl + 1;
      continue;
    }
    // /* */-комментарий.
    if (ch === '/' && backgroundJsText[i + 1] === '*') {
      const close = backgroundJsText.indexOf('*/', i + 2);
      if (close === -1) {
        throw new Error('Build: importScripts(...) is malformed: unterminated /* */ comment');
      }
      i = close + 2;
      continue;
    }
    // Закрывающая скобка — конец блока.
    if (ch === ')') {
      bodyEnd = i;
      break;
    }
    // Запятая — должна стоять после строкового литерала.
    if (ch === ',') {
      if (expect !== 'comma') {
        throw new Error(`Build: importScripts(...) is malformed: unexpected "," at position ${i - bodyStart} (expected string literal)`);
      }
      expect = 'string';
      i++;
      continue;
    }
    // Строковый литерал.
    if (ch === '"' || ch === "'") {
      if (expect !== 'string') {
        throw new Error(`Build: importScripts(...) is malformed: missing "," between string literals at position ${i - bodyStart}`);
      }
      const quote = ch;
      const end = backgroundJsText.indexOf(quote, i + 1);
      if (end === -1) {
        throw new Error('Build: importScripts(...) is malformed: unterminated string literal');
      }
      out.push(backgroundJsText.slice(i + 1, end));
      i = end + 1;
      expect = 'comma';
      continue;
    }
    // Любой другой символ — неожиданный токен.
    // Соберём короткое имя токена для диагностики.
    let tokenEnd = i + 1;
    while (tokenEnd < backgroundJsText.length && /[A-Za-z0-9_$]/.test(backgroundJsText[tokenEnd])) tokenEnd++;
    const tokenLen = Math.max(1, tokenEnd - i);
    const token = backgroundJsText.slice(i, i + Math.min(tokenLen, 32));
    throw new Error(`Build: importScripts(...) is malformed: unexpected token "${token}" at position ${i - bodyStart}`);
  }
  if (bodyEnd === -1) {
    throw new Error('Build: importScripts(...) is malformed: closing ) not found');
  }
  // Проверяем, что сразу после ')' стоит ';' (с возможными whitespace).
  let semi = bodyEnd + 1;
  while (semi < backgroundJsText.length && /\s/.test(backgroundJsText[semi])) semi++;
  if (backgroundJsText[semi] !== ';') {
    throw new Error('Build: importScripts(...) is malformed: trailing ; expected');
  }
  if (out.length === 0) {
    throw new Error('Build: importScripts(...) is malformed: no string arguments');
  }
  return { order: out, blockStart: startIdx, blockEnd: semi + 1 };
}

// Удаляет первый блок importScripts(...); из текста background.js.
function stripImportScriptsBlock(backgroundJsText) {
  const { blockStart, blockEnd } = parseImportScripts(backgroundJsText);
  // Удаляем сам блок; если после блока есть пустая строка-разделитель, оставляем как есть.
  return backgroundJsText.slice(0, blockStart) + backgroundJsText.slice(blockEnd);
}

// Удаляет //-комментарии, /* */-комментарии и строковые литералы (одиночные/двойные
// кавычки и template literals — без поддержки вложенных ${} expressions). Нужен
// для проверки, остался ли в bundle исполняемый код, который не должен туда
// попасть (например, живой importScripts(...) в SW). Упоминания этих токенов
// внутри комментариев и строковых литералов считаются безопасными.
function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Post-build assertion: в финальном dist/extension/background.js не должно
// остаться исполняемого вызова importScripts(...) — он должен быть вырезан
// stripImportScriptsBlock(). Упоминания в комментариях и строковых литералах
// игнорируются. Падает с понятной ошибкой, если что-то пролезло.
function assertNoLiveImportScripts(distBackgroundJsText) {
  const cleaned = stripCommentsAndStrings(distBackgroundJsText);
  if (/\bimportScripts\s*\(/.test(cleaned)) {
    throw new Error('Build: dist/extension/background.js contains a live importScripts(...) call; stripImportScriptsBlock failed.');
  }
}

// Post-build assertion: в bundle нет модуля отправки данных на сервер (присваивания
// globalThis.RumSend). Вызовы globalThis.RumSend?.… в background.js без него ничего не делают.
function assertNoSendModule(distBackgroundJsText) {
  const cleaned = stripCommentsAndStrings(distBackgroundJsText);
  if (/\bglobalThis\.RumSend\s*=(?!=)/.test(cleaned)) {
    throw new Error('Build: bundle must not contain the send module (globalThis.RumSend is defined)');
  }
}

// ─── Парсер content_scripts ─────────────────────────────────────────────

// Возвращает { order, index } — порядок js-фрагментов и индекс fat-записи
// content_scripts[] (js.length > 1), которую нужно переписать в dist.
function readContentScriptsOrder(manifest) {
  const arr = Array.isArray(manifest && manifest.content_scripts) ? manifest.content_scripts : null;
  if (!arr) {
    throw new Error('Build: manifest.content_scripts is not an array');
  }
  let foundIndex = -1;
  for (let i = 0; i < arr.length; i++) {
    const js = arr[i] && arr[i].js;
    if (Array.isArray(js) && js.length > 1) {
      if (foundIndex !== -1) {
        throw new Error('Build: manifest.content_scripts has more than one fat js[] entry; selector js.length > 1 is ambiguous');
      }
      foundIndex = i;
    }
  }
  if (foundIndex === -1) {
    throw new Error('Build: manifest.content_scripts has no fat js[] entry (js.length > 1)');
  }
  return { order: arr[foundIndex].js.slice(), index: foundIndex };
}

// ─── SHA256 vendor verification ─────────────────────────────────────────

// Читает соседний .SHA256 (формат метаданных vendor — ищем строку `sha256: <HEX>`
// или одиночный 64-hex hash в начале файла), сверяет фактический SHA-256 vendor-файла,
// падает с понятной ошибкой при mismatch.
function verifyVendorSha256(relPath) {
  const filePath = join(SRC, relPath);
  const shaPath = `${filePath}.SHA256`;
  if (!existsSync(filePath)) {
    throw new Error(`Build: vendor file missing: ${relPath}`);
  }
  if (!existsSync(shaPath)) {
    throw new Error(`Build: vendor SHA256 sidecar missing for ${relPath} (expected ${relPath}.SHA256)`);
  }
  const sidecar = readFileSync(shaPath, 'utf8');
  // Поддерживаем два формата:
  // 1) метаданные vendor (YAML-ish): где-то есть строка `sha256: <HEX>`;
  // 2) `<HEX>  <filename>` или просто `<HEX>` в начале файла.
  let expected = null;
  const labeled = sidecar.match(/(?:^|\n)\s*sha256\s*:\s*([0-9a-fA-F]{64})\b/);
  if (labeled) {
    expected = labeled[1].toLowerCase();
  } else {
    const head = sidecar.match(/^\s*([0-9a-fA-F]{64})\b/);
    if (head) expected = head[1].toLowerCase();
  }
  if (!expected) {
    throw new Error(`Build: vendor SHA256 sidecar ${relPath}.SHA256 has no 64-hex hash (expected line "sha256: <HEX>" or leading 64-hex)`);
  }
  const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`Build: vendor file ${relPath} SHA256 mismatch (expected ${expected}, actual ${actual})`);
  }
}

// ─── dist/ ──────────────────────────────────────────────────────────────

function cleanDist() {
  for (const dir of CLEAN_DIRS) {
    rmSync(join(DIST, dir), { recursive: true, force: true });
  }
  mkdirSync(DIST_EXT, { recursive: true });
}

// ─── esbuild ────────────────────────────────────────────────────────────

async function loadEsbuild() {
  return await import('esbuild');
}

async function stopEsbuild(esbuild) {
  if (esbuild && typeof esbuild.stop === 'function') {
    await esbuild.stop();
  }
}

// Собирает npm-prelude (IIFE) из inline-кода, не пишет файл, возвращает текст.
async function buildVendorPrelude(esbuild, entryCode, label) {
  const result = await esbuild.build({
    stdin: {
      contents: entryCode,
      resolveDir: ROOT,
      sourcefile: `${label}-prelude.js`,
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    minify: false,
    sourcemap: false,
    legalComments: 'inline',
    write: false,
  });
  if (!result.outputFiles || result.outputFiles.length !== 1) {
    throw new Error(`esbuild prelude "${label}": unexpected outputFiles length`);
  }
  return result.outputFiles[0].text;
}

// ─── Удаление комментариев из dist JS ───────────────────────────────────
// Логика портирована из mangling_v3.js: уважает строки '...', "...", `...`
// и regex /.../, удаляет // и /* */ комментарии, убирает ставшие пустыми строки.

function stripCommentsAndEmptyLines(src) {
  let out = '';
  let i = 0;
  const n = src.length;

  const prevSignificant = () => {
    for (let j = out.length - 1; j >= 0; j--) {
      const c = out[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      return { ch: c, idx: j };
    }
    return { ch: '', idx: -1 };
  };
  const isRegexContext = () => {
    const { ch, idx } = prevSignificant();
    if (ch === '') return true;
    if (/[=(,;:{}[!&|?+\-*/~^%<>]/.test(ch)) return true;
    const tail = out.slice(0, idx + 1);
    return /\b(return|typeof|instanceof|in|of|new|delete|void|throw|yield|await)$/.test(tail);
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = src[i];
        out += c;
        i++;
        if (c === '\\' && i < n) { out += src[i]; i++; continue; }
        if (c === quote) break;
        if (quote !== '`' && (c === '\n' || c === '\r')) break;
      }
      continue;
    }
    if (ch === '/' && isRegexContext()) {
      out += ch;
      i++;
      let inClass = false;
      while (i < n) {
        const c = src[i];
        out += c;
        i++;
        if (c === '\\' && i < n) { out += src[i]; i++; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        if (c === '\n' || c === '\r') break;
      }
      while (i < n && /[a-z]/i.test(src[i])) { out += src[i]; i++; }
      continue;
    }

    out += ch;
    i++;
  }

  return out
    .split('\n')
    .filter(line => line.trim() !== '')
    .join('\n');
}

// ─── Сборка bundle из порядка фрагментов ────────────────────────────────

function readSource(relPath) {
  return readFileSync(join(SRC, relPath), 'utf8');
}

// Превращает порядок фрагментов (с возможными lib/* placeholders) в массив
// { name, code }, подменяя lib/* на pre-built IIFE prelude и вставляя
// RumSanitize-bridge после services/analysis/sanitizeText.js. Финальный
// файл (entry) для SW при необходимости проходит трансформер, чтобы вырезать
// живой importScripts(...).
async function assembleFragments({ esbuild, order, transformEntry }) {
  const preludeCache = new Map();
  const out = [];
  let sanitizeSeen = false;

  for (let i = 0; i < order.length; i++) {
    const rel = order[i];
    const isLast = i === order.length - 1;

    if (rel.startsWith('lib/')) {
      const mapping = VENDOR_PRELUDE_MAP[rel];
      if (!mapping) {
        throw new Error(`Build: ${rel} has no npm prelude mapping; add it to VENDOR_PRELUDE_MAP or remove from build order`);
      }
      verifyVendorSha256(rel);
      let preludeCode = preludeCache.get(rel);
      if (!preludeCode) {
        preludeCode = await buildVendorPrelude(esbuild, mapping.entry, mapping.label);
        preludeCache.set(rel, preludeCode);
      }
      out.push({ name: `<${mapping.label}-prelude>`, code: preludeCode, isVendor: true });
      continue;
    }

    if (!existsSync(join(SRC, rel))) {
      throw new Error(`Build order references missing file: ${rel}`);
    }
    let code = readSource(rel);
    if (isLast && typeof transformEntry === 'function') {
      code = transformEntry(code, rel);
    }
    out.push({ name: rel, code });

    if (rel === RUMSANITIZE_AFTER) {
      out.push({ name: '<RumSanitize-bridge>', code: RUMSANITIZE_BRIDGE });
      sanitizeSeen = true;
    }
  }

  if (!sanitizeSeen) {
    throw new Error(`Build: ${RUMSANITIZE_AFTER} missing from order; RumSanitize bridge cannot be installed`);
  }

  return out;
}

function concatFragments(fragments) {
  return fragments.map(f => f.code).join(FRAGMENT_SEPARATOR);
}

// ─── Pre-flight планирование сборки ─────────────────────────────────────

// Парсит источники порядка и проверяет существование всех non-lib/*
// файлов и SHA256 vendor-файлов ДО cleanDist(). Возвращает план для
// последующих buildBackgroundBundle / buildContentBundle. Любой провал
// этой функции означает, что dist/extension/ нельзя начинать собирать —
// чтобы не оставлять частично записанный артефакт.
function planBuild(manifest) {
  const bgText = readSource('background.js');
  const { order: swOrder } = parseImportScripts(bgText);

  for (const rel of swOrder) {
    if (rel.startsWith('lib/')) {
      if (!VENDOR_PRELUDE_MAP[rel]) {
        throw new Error(`Build: ${rel} (in importScripts) has no npm prelude mapping; add it to VENDOR_PRELUDE_MAP or remove from background.js`);
      }
      verifyVendorSha256(rel);
      continue;
    }
    if (!existsSync(join(SRC, rel))) {
      throw new Error(`Build: importScripts(...) references missing file: ${rel}`);
    }
  }

  const { order: ctOrder, index: ctIndex } = readContentScriptsOrder(manifest);
  for (const rel of ctOrder) {
    if (rel.startsWith('lib/')) {
      if (!VENDOR_PRELUDE_MAP[rel]) {
        throw new Error(`Build: ${rel} (in content_scripts[].js) has no npm prelude mapping; add it to VENDOR_PRELUDE_MAP or remove from manifest`);
      }
      verifyVendorSha256(rel);
      continue;
    }
    if (!existsSync(join(SRC, rel))) {
      throw new Error(`Build: content_scripts[].js references missing file: ${rel}`);
    }
  }

  // Bridge должен быть устанавливаемым в обоих бандлах.
  if (!swOrder.includes(RUMSANITIZE_AFTER)) {
    throw new Error(`Build: ${RUMSANITIZE_AFTER} missing from importScripts(...) order; RumSanitize bridge cannot be installed`);
  }
  if (!ctOrder.includes(RUMSANITIZE_AFTER)) {
    throw new Error(`Build: ${RUMSANITIZE_AFTER} missing from content_scripts[].js order; RumSanitize bridge cannot be installed`);
  }

  return { swOrder, ctOrder, ctIndex };
}

// ─── SW bundle ──────────────────────────────────────────────────────────

async function buildBackgroundBundle(esbuild, swOrder) {
  // Финальный entry SW — сам background.js (живой importScripts вырезается).
  const fragments = await assembleFragments({
    esbuild,
    order: [...swOrder, 'background.js'],
    transformEntry: (code, rel) => {
      if (rel === 'background.js') return stripImportScriptsBlock(code);
      return code;
    },
  });
  const raw = concatFragments(fragments);
  assertNoLiveImportScripts(raw);
  assertNoSendModule(raw);
  const stripped = fragments.map(f => f.isVendor ? f.code : stripCommentsAndEmptyLines(f.code));
  const out = stripped.join(FRAGMENT_SEPARATOR);
  writeFileSync(join(DIST_EXT, 'background.js'), out);
  return { name: 'background.js', size: out.length, fragments: fragments.length };
}

// ─── Content bundle ─────────────────────────────────────────────────────

async function buildContentBundle(esbuild, ctOrder) {
  const fragments = await assembleFragments({ esbuild, order: ctOrder });
  const raw = concatFragments(fragments);
  const stripped = fragments.map(f => f.isVendor ? f.code : stripCommentsAndEmptyLines(f.code));
  const out = stripped.join(FRAGMENT_SEPARATOR);
  writeFileSync(join(DIST_EXT, 'content.bundle.js'), out);
  return { name: 'content.bundle.js', size: out.length, fragments: fragments.length };
}

// ─── Статика и manifest ─────────────────────────────────────────────────

function copyOne(rel) {
  const src = join(SRC, rel);
  const dst = join(DIST_EXT, rel);
  if (!existsSync(src)) {
    throw new Error(`Static file missing: ${rel}`);
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
}

function copyStatic() {
  for (const rel of STATIC_ROOT_FILES) copyOne(rel);
  for (const rel of STATIC_NESTED_FILES) copyOne(rel);
  for (const rel of STATIC_DIRS) {
    const src = join(SRC, rel);
    if (!existsSync(src)) throw new Error(`Static dir missing: ${rel}`);
    cpSync(src, join(DIST_EXT, rel), { recursive: true });
  }
}

// Пишет dist/extension/manifest.json: подставляет version из dev_extension/manifest.json
// и заменяет fat-запись content_scripts[i].js на ['content.bundle.js'].
function writeManifest(version, manifest) {
  const out = JSON.parse(JSON.stringify(manifest));
  out.version = version;
  const { index } = readContentScriptsOrder(out);
  out.content_scripts[index].js = ['content.bundle.js'];
  writeFileSync(join(DIST_EXT, 'manifest.json'), JSON.stringify(out, null, 2) + '\n');
}

// ─── Оркестратор сборки ────────────────────────────────────────────────

async function runBuild(opts) {
  const t0 = Date.now();
  preflightEsbuild();
  const esbuild = await loadEsbuild();
  try {
    const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
    const version = readManifestVersion(manifest);
    const synced = syncPackageJsonVersion(version);
    // Pre-flight: парсинг порядка, проверка existsSync для всех фрагментов
    // и SHA256 для всех vendor — до cleanDist(), чтобы не оставлять частично
    // записанный dist/extension/ при ошибках в любом из двух источников.
    const plan = planBuild(manifest);
    cleanDist();

    const tBg0 = Date.now();
    const bg = await buildBackgroundBundle(esbuild, plan.swOrder);
    const tBg = Date.now() - tBg0;

    const tCt0 = Date.now();
    const ct = await buildContentBundle(esbuild, plan.ctOrder);
    const tCt = Date.now() - tCt0;

    const tSt0 = Date.now();
    copyStatic();
    writeManifest(version, manifest);
    const tSt = Date.now() - tSt0;

    const total = Date.now() - t0;
    console.log(`[build] version=${version} (source: dev_extension/manifest.json${synced ? '; package.json synced' : ''})`);
    console.log(`[build] output -> dist/extension`);
    console.log(`[build] background.js: ${bg.size} bytes, ${bg.fragments} fragments, ${tBg} ms`);
    console.log(`[build] content.bundle.js: ${ct.size} bytes, ${ct.fragments} fragments, ${tCt} ms`);
    console.log(`[build] static + manifest: ${tSt} ms`);
    console.log(`[build] total: ${total} ms`);
  } finally {
    await stopEsbuild(esbuild);
  }
}

// ─── Watch ──────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

async function runWatch(opts) {
  await runBuild(opts);

  let building = false;
  let pending = false;

  const triggerRebuild = async () => {
    if (building) { pending = true; return; }
    building = true;
    try {
      console.log('[watch] rebuild start');
      await runBuild(opts);
      console.log('[watch] rebuild done');
    } catch (err) {
      console.error('[watch] rebuild failed:', err && err.message ? err.message : err);
    } finally {
      building = false;
      if (pending) {
        pending = false;
        triggerRebuild();
      }
    }
  };

  const debounced = debounce(triggerRebuild, 200);

  const onSelfChange = () => {
    console.warn('[watch] build.mjs changed — restart `npm run dev` to apply.');
  };

  for (const rel of WATCH_FILES) {
    const abs = join(SRC, rel);
    if (!existsSync(abs)) continue;
    fsWatch(abs, { persistent: true }, () => debounced());
  }
  for (const rel of WATCH_FILES_ROOT) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    fsWatch(abs, { persistent: true }, () => debounced());
  }
  try { fsWatch(join(ROOT, 'build.mjs'), { persistent: true }, onSelfChange); } catch { /* ignore */ }

  const watchDirs = WATCH_DIRS.map(dir => join(SRC, dir));
  for (const abs of watchDirs) {
    if (!existsSync(abs)) continue;
    try {
      fsWatch(abs, { persistent: true, recursive: true }, () => debounced());
    } catch {
      walkDirsSync(abs, (sub) => {
        try { fsWatch(sub, { persistent: true }, () => debounced()); } catch { /* ignore */ }
      });
    }
  }

  console.log('[watch] watching for changes; Ctrl+C to stop.');
}

function walkDirsSync(start, onDir) {
  onDir(start);
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    if (entry.isDirectory()) walkDirsSync(join(start, entry.name), onDir);
  }
}

// ─── main ──────────────────────────────────────────────────────────────

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('[build] failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
  if (args.watch) {
    try {
      await runWatch(args);
    } catch (err) {
      console.error('[watch] initial build failed:', err && err.stack ? err.stack : err);
      process.exit(1);
    }
  } else {
    try {
      await runBuild(args);
    } catch (err) {
      console.error('[build] failed:', err && err.stack ? err.stack : err);
      process.exit(1);
    }
  }
}

main();
