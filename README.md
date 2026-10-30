# RUM Monitor — Web App Performance

Source code of the Chrome extension **RUM Monitor — Web App Performance** (Manifest V3), version **1.17.5**.

- Chrome Web Store ID: `ogmlphnhjpgchhppnnpgnanaemnjkhhp`
- Privacy Policy: https://instorn.github.io/rum-data-collector/privacy-policy.html
- Contact: polentmail@gmail.com

## What the extension does

Real User Monitoring of web applications: it measures how the sites an administrator lists perform for real users — page load timing, Web Vitals (LCP, INP, CLS, TTFB), response time to clicks, duration of the page's AJAX/fetch requests, freezes and blank screens. Results are exported to CSV / JSON / ZIP files in the Downloads folder, manually from the popup or on a schedule.

Key facts for review:

- **Policy-only configuration.** The extension is configured through Chrome enterprise policy (`chrome.storage.managed`, schema in [`dev_extension/schema.json`](dev_extension/schema.json)). Without a policy it collects nothing.
- **Default deny.** Data is collected only on domains listed in the policy (`siteConfig_N`). On every other site the content script stops right after the domain check.
- **No network transfer.** The extension does not send collected data anywhere. Data stays in `chrome.storage.local` and leaves the browser only as export files saved by `chrome.downloads`.
- **No remote code.** No `eval`, no `new Function`, no external scripts. Two third-party libraries are bundled (see [Third-party code](#third-party-code)).
- **Not collected:** keystrokes, form values, passwords, cookies, page text, text of clicked elements. IDs in URLs are masked before storage.

### Permissions

| Permission | Why |
|---|---|
| `storage` | Read the policy (`chrome.storage.managed`); keep collected records and state in `chrome.storage.local`. |
| `downloads` | Save export files (CSV, JSON, ZIP) to the Downloads folder. |
| `alarms` | Scheduled auto-export at the times set in the policy. |
| host `<all_urls>`, content script on `<all_urls>` | The list of monitored sites is set by the administrator at run time and is not known at build time. On sites outside the list the content script does nothing. |

### Notes on the code

- Code comments are partly in Russian.
- `background.js` contains optional hooks `globalThis.RumSend?.…`. They belong to a separate server-upload module that is **not part of this build or of the store package**; without it the calls do nothing. The build fails if the module is present (`assertNoSendModule` in [`build.mjs`](build.mjs)). The `99-diagnostics.json` report shows `sendModule: "absent"`.
- `dev_extension/settings.json` is a demo configuration read only when the extension is loaded unpacked without a policy. It is **not** in the store package.

## Quick test (store version)

1. Install the extension from the Chrome Web Store.
2. Set the demo policy. Either run the script in PowerShell **as Administrator**:

   ```powershell
   cd policy
   powershell -ExecutionPolicy Bypass -File .\set-policy.ps1
   ```

   or create it by hand in `regedit`:
   - key `HKLM\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\ogmlphnhjpgchhppnnpgnanaemnjkhhp\policy`
   - String value `siteConfig_1` = `{"domain":"en.wikipedia.org","mode":"monitor"}`
3. Open `chrome://policy` and click **Reload policies**. The extension's values are listed under its ID.
4. Open https://en.wikipedia.org, click several links, then open the extension popup and export the reports.
5. Other sites are not monitored.

To remove the policy: `.\set-policy.ps1 -Remove`.

Example exports from this setup are in [`examples/`](examples/).

## Repository layout

```
dev_extension/          extension source; can be loaded unpacked as is
  manifest.json
  background.js         service worker; importScripts(...) lists the SW modules
  content.js            content script (with services/* and lib/web-vitals, see manifest)
  popup.html/.css/.js   popup
  schema.json           managed storage (policy) schema
  settings.json         demo config for unpacked loading only
  services/             modules: site matching, timing, vitals, export, migrations, i18n
  metrics/registry.js   metric definitions
  lib/                  vendored fflate and web-vitals + .SHA256 files
  _locales/en, ru       UI strings
build.mjs               build: dev_extension/ -> dist/extension/
package-cws.mjs         packs dist/extension/ into the store ZIP and self-checks it
build-extension.cmd     Windows: npm ci + build
build-cws.cmd           Windows: store ZIP
policy/                 set-policy.ps1 + demo policy.json
examples/               sample reports (demo data, en.wikipedia.org)
docs/                   privacy policy (published with GitHub Pages)
```

## Build and verify the store package

Requires Node.js 18 or later.

```cmd
build-extension.cmd
build-cws.cmd
```

or on any OS:

```sh
npm ci
npm run build
npm run package
```

Output:

- `dist/extension/` — the built extension (can be loaded unpacked);
- `dist/cws/rum_data_collector-1.17.5.zip` — the package uploaded to the Chrome Web Store;
- `dist/cws/rum_data_collector-1.17.5.files.txt` — SHA-256 of the ZIP and of every file in it.

The build is deterministic (fixed timestamps in the ZIP). The ZIP for 1.17.5 built from this repository has

```
sha256 81e2a8cef7527d6479e6cf495cfbb6aa87a24aab11bf894e69dee32ff6291851
```

What the build does:

1. `build.mjs` reads the service-worker module order from `importScripts(...)` in `background.js` and the content-script order from `manifest.json`, and concatenates them into `background.js` and `content.bundle.js`. Comments and empty lines are removed; the code is **not minified or obfuscated**.
2. `lib/fflate.umd.js` and `lib/web-vitals.iife.js` are replaced with the same versions from npm (bundled by esbuild as IIFE). Before that the SHA-256 of each vendored file is checked against its `.SHA256` file.
3. Static files (`popup.*`, `schema.json`, icons, `_locales/`, `metrics/registry.js`) are copied unchanged.
4. `package-cws.mjs` zips `dist/extension/` without `settings.json`, then checks the archive: no `update_url`/`key`, no `tabs`/`activeTab`, no `eval(`/`new Function(`/external `<script src>`, every referenced file present, every file except `manifest.json` byte-identical to `dist/extension/`. The warning about `new Worker` / `createObjectURL` refers to the async API of fflate, which the extension does not call.

### Load unpacked (development)

`chrome://extensions` → Developer mode → **Load unpacked** → select `dev_extension/` (no build needed) or `dist/extension/`.

An unpacked copy gets its own extension ID, so a policy written for the store ID does not apply to it. Without a policy it uses the demo `settings.json` (en.wikipedia.org). To test it with a policy, pass its ID: `.\set-policy.ps1 -ExtensionId <id from chrome://extensions>`.

## Configuring by policy (Chrome, Windows)

The extension reads its settings from the Chrome policy for extensions ([Chromium documentation](https://www.chromium.org/administrators/configuring-policy-for-extensions/)):

```
HKLM\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\<extension ID>\policy
```

Value types:

| In `schema.json` | In the registry | Example |
|---|---|---|
| `boolean` | `REG_DWORD` 0 / 1 | `rumEnabled` = 1 |
| `integer` | `REG_DWORD` | |
| `string` | `REG_SZ` | `customPCName` = `PC-0042` |
| `object`, `array`, and the `siteConfig_N` strings | `REG_SZ` with JSON | `siteConfig_1` = `{"domain":"en.wikipedia.org","mode":"monitor"}` |

Main keys (full list with descriptions — [`dev_extension/schema.json`](dev_extension/schema.json)):

| Key | Type | Meaning |
|---|---|---|
| `siteConfig_1` … `siteConfig_3` | string (JSON) | One monitored site: `{"domain":"crm.example.com","mode":"monitor"}`. `domain` supports `*.example.com`. `mode`: `monitor` (full), `both` (same as `monitor`), `minimal` (Web Vitals and page loads only), `disabled`. |
| `siteConfigs` | array | The same as a list: `[{"domain":"...","mode":"..."}]`. |
| `rumEnabled` | boolean | Global on/off switch. |
| `customPCName` | string | Workstation label shown in reports. Without it a random ID is used. |
| `organizationName`, `department`, `location` | string | Labels written to reports. |
| `commit1`, `commit2` | string | Free-text notes written to reports. |
| `autoExport` | object (JSON) | Scheduled export: `{"enabled":true,"schedules":[{"time":"18:00","cleanupAfterExport":false}]}`. `cleanupAfterExport` deletes records older than 1 hour after a successful export. |
| `executiveSummaryThresholds` | object (JSON) | Slow-operation thresholds for the 04 report, seconds: `{"typical_load_sec":{"warn":3,"crit":5},"slow_load_sec":{"warn":5,"crit":10}}`. |
| `disabledMetrics` | array | Metrics not to collect, e.g. `["inp","cls"]`. |

Keys marked "compact: не используется" in `schema.json` are kept for compatibility with older policies and are ignored. `serverUrl` is not used by this build.

### Script: `policy/set-policy.ps1`

Writes every value from `policy/policy.json` to the key above (types as in the table), after deleting the previous policy of this extension. Run PowerShell **as Administrator**:

| Command | Action |
|---|---|
| `.\set-policy.ps1` | write `policy.json` for the store ID |
| `.\set-policy.ps1 -File my.json` | write another file |
| `.\set-policy.ps1 -ExtensionId <id>` | use another extension ID |
| `.\set-policy.ps1 -Remove` | delete the policy |

If scripts are blocked: `powershell -ExecutionPolicy Bypass -File .\set-policy.ps1`. After any change: `chrome://policy` → **Reload policies**.

### Domain (Group Policy)

1. **Settings.** Group Policy Management → edit a GPO → *Computer Configuration → Preferences → Windows Settings → Registry* → New → Registry Item: Hive `HKEY_LOCAL_MACHINE`, Key path `SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\ogmlphnhjpgchhppnnpgnanaemnjkhhp\policy`, one item per value (`REG_SZ` or `REG_DWORD` as in the table).
2. **Forced install from the store (optional).** With the [Chrome ADMX templates](https://chromeenterprise.google/browser/download/): *Computer Configuration → Policies → Administrative Templates → Google → Google Chrome → Extensions → Configure the list of force-installed apps and extensions* → add
   `ogmlphnhjpgchhppnnpgnanaemnjkhhp;https://clients2.google.com/service/update2/crx`

## Third-party code

| Library | Version | Used for | Vendored file SHA-256 |
|---|---|---|---|
| [fflate](https://github.com/101arrowz/fflate) (MIT) | 0.8.2 | ZIP of the exported reports (service worker) | `c3b34f2e9f5e74d4d7d64e01cac7a0c01954c6c406414d42185c7b53d6875ddf` (`lib/fflate.umd.js`) |
| [web-vitals](https://github.com/GoogleChrome/web-vitals) (Apache-2.0) | 5.2.0 | LCP, INP, CLS, TTFB (content script) | `5c63ea0e3efcddf5efe31aec9eefd08842f7ba95df654ea98c36ac0a02741912` (`lib/web-vitals.iife.js`) |

Build tool: esbuild (dev dependency).

## License

All rights reserved. The source is published for review and reference.
