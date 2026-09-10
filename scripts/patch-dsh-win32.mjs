#!/usr/bin/env node
/**
 * Stop dsh's Windows subprocess launcher from flashing a console window.
 *
 * `@deepseek-ai/dsh-win32-process` launches commands through raw Win32
 * (`CreateProcessW` / `CreateProcessAsUserW`) rather than Node's `child_process`,
 * so Node's `windowsHide` never applies. It passes only
 * `CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT` (4 / 1028) and a STARTUPINFO
 * whose `dwFlags` is `STARTF_USESTDHANDLES` alone, so Windows allocates a
 * console for every console child — the visible "Windows PowerShell" window.
 *
 * Adding `CREATE_NO_WINDOW` (0x08000000) suppresses that without affecting the
 * inherited stdio handles the suspended-Job design relies on.
 *
 * This runs from `postinstall`, so a fresh `npm install` reproduces the fix.
 * Upstream fix to prefer: pass CREATE_NO_WINDOW in the library itself.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const TARGET_PACKAGE = "@deepseek-ai/dsh-win32-process";
const CREATE_NO_WINDOW = 0x08000000;

const EDIT = [
  // spawnCurrentTokenJobProcess -> CreateProcessW
  {
    from: "1, 1028, environment",
    to: `1, ${1028 | CREATE_NO_WINDOW}, environment`,
  },
  // spawnPipedProcess and spawnInheritedJobProcess both funnel through here ->
  // CreateProcessAsUserW: OR the hide flag into every caller's creation flags.
  {
    from: "return api.createProcessAsUserW(options.token, null, commandLine, null, null, 1, creationFlags, null, options.cwd, startupInfo, processInfo);",
    to: "return api.createProcessAsUserW(options.token, null, commandLine, null, null, 1, creationFlags | CREATE_NO_WINDOW, null, options.cwd, startupInfo, processInfo);",
  },
];

function fail(message) {
  console.error(`[patch-dsh-win32] ${message}`);
  process.exitCode = 1;
}

let entry;
try {
  // Resolve the package root, not a subpath: the package is ESM with an
  // `exports` map, so `require.resolve("@scope/name/lib/index.js")` fails even
  // though the file exists.
  const pkgJson = require.resolve(`${TARGET_PACKAGE}/package.json`);
  entry = path.join(path.dirname(pkgJson), "lib", "index.js");
  if (!fs.existsSync(entry)) {
    fail(`resolved ${TARGET_PACKAGE} but ${entry} is missing`);
    process.exit(1);
  }
} catch (error) {
  if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
    // Only present once dsh's tree is installed; nothing to do otherwise.
    console.log(`[patch-dsh-win32] ${TARGET_PACKAGE} not installed; skipping`);
    process.exit(0);
  }
  fail(`could not locate ${TARGET_PACKAGE}: ${String(error)}`);
  process.exit(1);
}

const original = fs.readFileSync(entry, "utf8");
let patched = original;
const applied = [];

for (const { from, to } of EDIT) {
  if (!patched.includes(from)) {
    if (patched.includes(to)) continue; // already patched
    fail(
      `pattern not found: ${JSON.stringify(from.slice(0, 70))}. ` +
        `Upstream ${TARGET_PACKAGE} changed; update scripts/patch-dsh-win32.mjs.`
    );
    continue;
  }
  patched = patched.replace(from, to);
  applied.push(from.slice(0, 46));
}

if (patched === original) {
  console.log("[patch-dsh-win32] already patched; nothing to do");
  process.exit(process.exitCode ?? 0);
}

// The constant has to exist for the replacements above to be valid JS.
if (!patched.includes("const CREATE_NO_WINDOW")) {
  const marker = "/** Win32 code reporting a caller-provided buffer is too small. */";
  const declaration = `/** Suppress the console window for a console child (CREATE_NO_WINDOW). */\nconst CREATE_NO_WINDOW = ${CREATE_NO_WINDOW};\n`;
  if (!patched.includes(marker)) {
    fail("could not find an anchor for the CREATE_NO_WINDOW declaration");
  } else {
    patched = patched.replace(marker, declaration + marker);
  }
}

if (process.exitCode) process.exit(process.exitCode);

fs.writeFileSync(entry, patched, "utf8");
console.log(`[patch-dsh-win32] patched ${path.relative(process.cwd(), entry)} (${applied.length} call site(s))`);
