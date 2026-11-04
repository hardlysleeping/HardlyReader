// Render the shared Accounts body: phone Settings and desktop use the same control.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, compileModule } from "svelte/compiler";
import { render } from "svelte/server";
import ts from "typescript";
import { buildReaderModule, GEN_DIR } from "./build-reader.mjs";
import { localProfile, syncProfile } from "../../src/api/profile.ts";

let checks = 0;
function check(name, ok) {
  checks++;
  if (!ok) throw new Error(name);
}
mkdirSync(GEN_DIR, { recursive: true });
const readerUrl = pathToFileURL(join(GEN_DIR, "control-reader.mjs")).href;
writeFileSync(join(GEN_DIR, "control-reader.mjs"), buildReaderModule());
const { reader } = await import(readerUrl);
const chromeFile = new URL("../../src/state/chrome.svelte.ts", import.meta.url);
const transpiled = ts.transpileModule(readFileSync(chromeFile, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const chromeCode = compileModule(transpiled, { generate: "client", filename: chromeFile.pathname }).js.code
  .replace(/from "(\.[^"]+)"/g, (_, spec) => `from ${JSON.stringify(new URL(`${spec}.ts`, chromeFile).href)}`);
const chromeUrl = pathToFileURL(join(GEN_DIR, "control-chrome.mjs")).href;
writeFileSync(join(GEN_DIR, "control-chrome.mjs"), chromeCode);
const { chrome } = await import(chromeUrl);
const fixtureUrl = "data:text/javascript," + encodeURIComponent('export const accounts = {rows: [], active: null, busy: null};');
const componentFile = new URL("../../src/components/AccountsBody.svelte", import.meta.url);
const source = readFileSync(componentFile, "utf8");
const compiled = compile(source, { generate: "server", filename: componentFile.pathname }).js.code
  .replace(/from ['"]([^'"]+)['"]/g, (whole, spec) => {
    const target = spec === "../state/reader.svelte" ? readerUrl
      : spec === "../state/chrome.svelte" ? chromeUrl
      : spec === "../state/accounts.svelte" ? fixtureUrl
      : spec.startsWith(".") ? new URL(`${spec}.ts`, componentFile).href : null;
    return target ? `from ${JSON.stringify(target)}` : whole;
  });
const componentUrl = pathToFileURL(join(GEN_DIR, "multi-control.mjs")).href;
writeFileSync(join(GEN_DIR, "multi-control.mjs"), compiled);
const { default: AccountsBody } = await import(componentUrl);
const markup = () => render(AccountsBody).body;
const first = syncProfile({ serverUrl: "https://first.example", email: "one", token: "test" }, { kind: "greader" });
const second = syncProfile({ serverUrl: "https://second.example", email: "two", token: "test" }, { kind: "greader" });
reader.adoptAccounts([first, localProfile({ kind: "local" })]);
check("one server beside empty local has no combined control", !markup().includes('aria-label="Combine reading list and starred"'));
reader.adoptAccounts([second]);
check("two real servers draw the control even before subscriptions load", markup().includes('aria-label="Combine reading list and starred"'));
check("approved default is visibly pressed", markup().includes('aria-pressed="true"'));
chrome.setMultiAccount(false);
check("off is visibly unpressed", markup().includes('aria-pressed="false"'));
check("off describes the focused account", markup().includes("only the account in use"));
check("shared control has no desktop-only gate", !source.includes('layout.device'));
check("touch target is at least 44 pixels without safe-area guesses", /min-height: 44px/.test(source) && !source.includes('safe-area'));
console.log(`${checks}/${checks} checks passed`);
