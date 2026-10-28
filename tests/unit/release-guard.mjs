// The release guard: scripts/release.sh must refuse a release that is not four
// bundles, and must not touch GitHub while refusing. Every dry run here uses a
// `gh` on PATH that records any call it gets and exits 99, so a release suite
// can never publish anything by accident.
//
// The live runs below (no --dry-run) use a second `gh` that keeps a release
// store in a JSON file and answers the calls the script makes — a draft exists,
// an upload lands incomplete, a publish fails — so the retry path can be driven
// without a token and without a real repository. It records every call too.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, truncateSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/release.sh");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const tag = `v${version}`;

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// A stored (uncompressed) zip, so an APK or IPA fixture has real structure
// without needing a zip binary or a compressor.
function writeZip(path, entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const sum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...local, directory, end]));
}

// ELF header plus the AppImage type-2 marker at byte 8, then zeros to a size a
// real AppImage would have. The bytes that matter are the ones the script reads.
function writeAppImage(path, size) {
  writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x41, 0x49, 0x02]));
  truncateSync(path, size);
}

const MB = 1024 * 1024;
mkdirSync(join(root, "dist"), { recursive: true });
const fixtures = mkdtempSync(join(root, "dist", "release-guard-"));

function buildFixtures() {
  mkdirSync(fixtures, { recursive: true });
  const files = {
    appimage: join(fixtures, `hardlyreader-${version}-linux-x86_64.AppImage`),
    flatpak: join(fixtures, `hardlyreader-${version}-x86_64.flatpak`),
    apk: join(fixtures, `hardlyreader-${version}-android.apk`),
    ipa: join(fixtures, `hardlyreader-${version}-ios.ipa`),
  };
  writeAppImage(files.appimage, 41 * MB);

  writeFileSync(files.flatpak, Buffer.from("flatpak\x00\x01\x00ref", "binary"));
  truncateSync(files.flatpak, Math.round(1.2 * MB));

  writeZip(files.apk, [
    ["AndroidManifest.xml", Buffer.from("<manifest package=\"ing.hardlysleep.hardlyreader\"/>")],
    ["classes.dex", Buffer.from("dex\n035\0")],
    ["assets/payload.bin", Buffer.alloc(9 * MB)],
  ]);

  writeZip(files.ipa, [
    ["Payload/HardlyReader.app/Info.plist", Buffer.from("<plist/>")],
    ["Payload/HardlyReader.app/HardlyReader", Buffer.alloc(Math.round(1.1 * MB))],
  ]);
  return files;
}

const files = buildFixtures();

const assets = {
  appimage: `hardlyreader-${version}-linux-x86_64.AppImage`,
  flatpak: `hardlyreader-${version}-x86_64.flatpak`,
  apk: `hardlyreader-${version}-android.apk`,
  ipa: `hardlyreader-${version}-ios.ipa`,
};

// Any call to gh is a failure during a dry run: the tripwire exits 99 and
// records the call, so a dry run that reached GitHub could not pass silently.
const bin = join(fixtures, "bin");
mkdirSync(bin, { recursive: true });
const ghCalls = join(fixtures, "gh-calls");
writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> '${ghCalls}'\nexit 99\n`);
spawnSync("chmod", ["+x", join(bin, "gh")]);

function release(args) {
  const result = spawnSync("bash", [script, version, "--dry-run", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return {
    code: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// The fake gh for the live runs. It holds the release store in one JSON file —
// draft ids, per-asset state and size, what is published — and answers exactly
// the calls the script makes, so an "upload that lands incomplete" or a
// "publish that fails" is a property of the fake, not of a real repository.
const live = join(fixtures, "live");
mkdirSync(live, { recursive: true });
const liveBin = join(fixtures, "live-bin");
mkdirSync(liveBin, { recursive: true });
const store = join(live, "releases.json");
const liveLog = join(live, "gh-calls");
const fakeGh = join(live, "gh.mjs");

writeFileSync(
  fakeGh,
  `import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const dir = process.env.GH_FAKE_STATE;
const storePath = join(dir, "releases.json");
const state = existsSync(storePath)
  ? JSON.parse(readFileSync(storePath, "utf8"))
  : { nextId: 4001, drafts: {}, published: {}, tags: [] };
const save = () => writeFileSync(storePath, JSON.stringify(state, null, 2));
const die = (message) => {
  process.stderr.write(message + "\\n");
  process.exit(1);
};

const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const rows = (store) =>
  Object.entries(store)
    .map(([name, asset]) => \`\${name}\\t\${asset.state}\\t\${asset.size}\`)
    .join("\\n");

const [command, ...rest] = argv;

if (command === "auth") process.exit(process.env.GH_FAKE_AUTH === "fail" ? 1 : 0);

if (command === "api") {
  const endpoint = rest[0];
  const jq = value("--jq") ?? "";
  const tagOf = (re) => endpoint.match(re)?.[1];

  const tagPath = tagOf(/^repos\\/[^/]+\\/[^/]+\\/git\\/ref\\/tags\\/(.+)$/);
  if (tagPath) {
    if (state.tags.includes(tagPath) || state.published[tagPath]) process.exit(0);
    die("gh: Not Found (HTTP 404)");
  }

  if (/\\/releases\\?per_page=\\d+$/.test(endpoint)) {
    const wanted = /tag_name == "([^"]+)"/.exec(jq)?.[1];
    const ids = Object.entries(state.drafts)
      .filter(([name]) => !wanted || name === wanted)
      .map(([, draft]) => String(draft.id));
    process.stdout.write(ids.join("\\n") + (ids.length ? "\\n" : ""));
    process.exit(0);
  }

  const byId = endpoint.match(/\\/releases\\/(\\d+)$/);
  if (byId) {
    const hit = Object.entries(state.drafts).find(([, draft]) => String(draft.id) === byId[1]);
    if (!hit) die("gh: Not Found (HTTP 404)");
    process.stdout.write(
      jq.includes(".assets[]")
        ? rows(hit[1].assets) + "\\n"
        : JSON.stringify({ id: hit[1].id, tag_name: hit[0], draft: true }),
    );
    process.exit(0);
  }

  const byTag = endpoint.match(/\\/releases\\/tags\\/(.+)$/);
  if (byTag) {
    const published = state.published[byTag[1]];
    if (!published) die("gh: Not Found (HTTP 404)");
    process.stdout.write(
      jq.includes(".assets[]") ? rows(published.assets) + "\\n" : JSON.stringify(published),
    );
    process.exit(0);
  }

  die("gh: unexpected api call: " + endpoint);
}

if (command === "release") {
  const [sub, subject] = rest;

  if (sub === "create") {
    if (state.drafts[subject] || state.published[subject]) {
      die(\`release \${subject} already exists\`);
    }
    if (process.env.GH_FAKE_CREATE === "fail") die("HTTP 502: could not create the release");
    state.drafts[subject] = { id: state.nextId, assets: {} };
    state.nextId += 1;
    save();
    process.exit(0);
  }

  if (sub === "upload") {
    const draft = state.drafts[subject];
    if (!draft) die(\`release not found: \${subject}\`);
    if (process.env.GH_FAKE_UPLOAD === "fail") die("HTTP 502 while uploading");
    const repo = value("--repo");
    const files = rest.slice(2).filter((arg) => !arg.startsWith("-") && arg !== repo);
    const stalled = process.env.GH_FAKE_UPLOAD_INCOMPLETE ?? "";
    for (const file of files) {
      if (!existsSync(file)) die("no such file: " + file);
      const name = basename(file);
      draft.assets[name] =
        name === stalled ? { state: "new", size: 0 } : { state: "uploaded", size: statSync(file).size };
    }
    save();
    process.exit(0);
  }

  if (sub === "edit") {
    const draft = state.drafts[subject];
    if (!draft) {
      die(state.published[subject] ? \`release \${subject} is already published\` : \`release not found: \${subject}\`);
    }
    if (argv.includes("--draft=false")) {
      if (process.env.GH_FAKE_EDIT === "fail") die("HTTP 502 while publishing");
      state.published[subject] = { tag_name: subject, draft: false, assets: draft.assets };
      delete state.drafts[subject];
      state.tags.push(subject);
      save();
    }
    process.exit(0);
  }

  die("gh: unexpected release call: " + sub);
}

die("gh: unexpected command: " + command);
`,
);

writeFileSync(
  join(liveBin, "gh"),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_FAKE_LOG"\nexec '${process.execPath}' '${fakeGh}' "$@"\n`,
);
spawnSync("chmod", ["+x", join(liveBin, "gh")]);

// Each live case starts from a fresh store and a fresh call log, so a run's
// calls are its own and the previous case's draft cannot decide this one.
function resetStore(scenario = {}) {
  writeFileSync(store, JSON.stringify({ nextId: 4001, drafts: {}, published: {}, tags: [], ...scenario }));
}

function liveRelease(opts = {}) {
  rmSync(liveLog, { force: true });
  const result = spawnSync("bash", [script, version, ...(opts.args ?? allFour)], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${liveBin}:${process.env.PATH}`,
      GH_FAKE_LOG: liveLog,
      GH_FAKE_STATE: live,
      ...(opts.env ?? {}),
    },
  });
  const calls = existsSync(liveLog)
    ? readFileSync(liveLog, "utf8").split("\n").filter(Boolean)
    : [];
  return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, calls };
}

const readStore = () => JSON.parse(readFileSync(store, "utf8"));
// A broken script can leave the store without a release at all, which must read
// as a failed check rather than as a thrown TypeError that hides every other one.
const draftAssets = () => Object.keys(readStore().drafts[tag]?.assets ?? {});
const publishedAssets = () => Object.keys(readStore().published[tag]?.assets ?? {});
const staged = join(root, "dist", `release-${tag}`);
// A crashed run leaves its staging directory behind; a rerun must not mistake it
// for this run's own work.
rmSync(staged, { recursive: true, force: true });
const uploadCall = (run) => run.calls.find((call) => call.startsWith("release upload"));
const callIndex = (run, pattern) => run.calls.findIndex((call) => pattern.test(call));

const allFour = [
  "--appimage", files.appimage,
  "--flatpak", files.flatpak,
  "--apk", files.apk,
  "--ipa", files.ipa,
];

// 1. All four present: the guard passes and prints the upload it would do.
const complete = release(allFour);
check("four valid bundles pass the guard", complete.code === 0, `exit ${complete.code}: ${complete.output.slice(-400)}`);
for (const name of Object.values(assets)) {
  check(`the upload names ${name}`, complete.output.includes(`release-${tag}/${name}`));
}
check("the upload comes before the publish", complete.output.indexOf("gh release upload") < complete.output.indexOf("--draft=false"));
check("the release is created as a draft", /gh release create v[\d.]+ .*--draft/.test(complete.output));
check("the dry run says a draft is reused", complete.output.includes(`draft for ${tag} that already exists is reused`));

// 2. One bundle missing: refused, named, and nothing on GitHub.
const noApk = release(allFour.filter((arg) => arg !== files.apk && arg !== "--apk"));
check("a missing APK is refused", noApk.code !== 0, `exit ${noApk.code}`);
check("the refusal names the APK", /APK: nothing to check|APK: missing/.test(noApk.output), noApk.output.slice(0, 300));
check("the refusal creates no release", !/^\s+gh release create/m.test(noApk.output));
check("the refusal uploads nothing", !/^\s+gh release upload/m.test(noApk.output));

// The same, but with a path given that does not exist.
const ghostApk = release([...allFour.slice(0, 4), "--apk", join(fixtures, "not-built.apk"), "--ipa", files.ipa]);
check("an APK path that does not exist is refused", ghostApk.code !== 0 && /APK: missing/.test(ghostApk.output), ghostApk.output.slice(0, 300));

// 3. Right size, wrong kind of file: 41MB of zeros is not an AppImage.
const fakeAppImage = join(fixtures, `hardlyreader-${version}-linux-x86_64-fake.AppImage`);
writeFileSync(fakeAppImage, Buffer.alloc(41 * MB));
const wrongKind = release(allFour.map((arg) => (arg === files.appimage ? fakeAppImage : arg)));
check("a non-ELF AppImage is refused", wrongKind.code !== 0 && /not an ELF/.test(wrongKind.output), wrongKind.output.slice(0, 300));

// An ELF that never got packaged is still not an AppImage: the type-2 marker is
// what the check reads, and the bare binary is the classic wrong upload.
const bareBinary = join(fixtures, "hardlyreader-bare.AppImage");
writeFileSync(bareBinary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00]));
truncateSync(bareBinary, 41 * MB);
const bare = release(allFour.map((arg) => (arg === files.appimage ? bareBinary : arg)));
check("an ELF without the AppImage marker is refused", bare.code !== 0 && /not an AppImage/.test(bare.output), bare.output.slice(0, 300));

// 4. Right kind, far too small: a stub cannot stand in for a bundle.
const stubIpa = join(fixtures, "stub.ipa");
writeZip(stubIpa, [["Payload/HardlyReader.app/Info.plist", Buffer.from("<plist/>")]]);
const stub = release(allFour.map((arg) => (arg === files.ipa ? stubIpa : arg)));
check("a stub IPA is refused for its size", stub.code !== 0 && /floor/.test(stub.output), stub.output.slice(0, 300));

// 5. A zip that is an APK by name only.
const notApk = join(fixtures, "not.apk");
writeZip(notApk, [["readme.txt", Buffer.from("no android here")], ["blob.bin", Buffer.alloc(9 * MB)]]);
const wrongApk = release(allFour.map((arg) => (arg === files.apk ? notApk : arg)));
check("a zip without AndroidManifest.xml is refused", wrongApk.code !== 0 && /AndroidManifest\.xml/.test(wrongApk.output), wrongApk.output.slice(0, 300));

// 6. The IPA cannot be built on Linux, so leaving it out must say so rather
// than look for a default.
const noIpa = release(allFour.filter((arg) => arg !== files.ipa && arg !== "--ipa"));
check("an absent IPA is refused with the reason", noIpa.code !== 0 && /codemagic\.yaml/.test(noIpa.output), noIpa.output.slice(0, 300));

// 7. A version that package.json does not carry is a mix-up, not a release.
const wrongVersion = spawnSync("bash", [script, "9.9.9", "--dry-run", ...allFour], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
});
check(
  "a version package.json disagrees with is refused",
  wrongVersion.status !== 0 && /package\.json says/.test(`${wrongVersion.stdout}${wrongVersion.stderr}`),
);

// 8. And the whole point: a dry run never ran gh, never staged, never published.
check("no gh command was run", !existsSync(ghCalls));
check("no release was staged by a dry run", !existsSync(staged));

// ---------------------------------------------------------------------------
// The live runs. Same script, no --dry-run, a gh that answers and records.

// 9. A draft already exists for the tag: it is reused, not created again — the
// retry after a run that stopped halfway. Foundations planted on the draft
// (an older copy of one bundle) must be replaced, not duplicated.
resetStore({
  nextId: 4002,
  drafts: { [tag]: { id: 4001, assets: { [assets.appimage]: { state: "uploaded", size: 12 } } } },
});
const reuse = liveRelease();
check("a draft that already exists is reused", reuse.code === 0, `exit ${reuse.code}: ${reuse.output.slice(-400)}`);
check("the reuse path creates no release", !reuse.calls.some((call) => call.startsWith("release create")), reuse.calls.join(" | ").slice(0, 400));
check("the reuse path says the draft is reused", new RegExp(`draft #4001 for ${tag} already exists`).test(reuse.output), reuse.output.slice(0, 400));
check("the reuse path uploads with --clobber", /release upload .*--clobber/.test(uploadCall(reuse) ?? ""));
for (const name of Object.values(assets)) {
  check(`the reuse upload carries ${name}`, (uploadCall(reuse) ?? "").includes(name));
}
check("the draft is read back by its numeric id", reuse.calls.some((call) => /\/releases\/4001(\s|$)/.test(call)));
check(
  "the read-back of the draft comes after the upload",
  callIndex(reuse, /^release upload/) < callIndex(reuse, /\/releases\/4001(\s|$)/),
  reuse.calls.join(" | ").slice(0, 500),
);
check(
  "publishing comes after the read-back of the draft",
  callIndex(reuse, /\/releases\/4001(\s|$)/) < callIndex(reuse, /--draft=false/),
  reuse.calls.join(" | ").slice(0, 500),
);
check("the released tag is read back after publishing", callIndex(reuse, /--draft=false/) < callIndex(reuse, new RegExp(`/releases/tags/${tag}(\\s|$)`)));
check("all four assets were replaced on the draft", publishedAssets().length === 4);
check("the release is published, not left as a draft", !readStore().drafts[tag] && Boolean(readStore().published[tag]));
check("the published release is not a draft", readStore().published[tag]?.draft === false);

// 10. A bundle goes bad: named, and nothing is created, uploaded or published.
resetStore();
const badFlatpak = join(fixtures, "wrong.flatpak");
writeFileSync(badFlatpak, Buffer.alloc(Math.round(1.2 * MB)));
const badBundle = liveRelease({ args: allFour.map((arg) => (arg === files.flatpak ? badFlatpak : arg)) });
check("a bad bundle stops the live run", badBundle.code !== 0 && /Flatpak: not a flatpak bundle/.test(badBundle.output), badBundle.output.slice(0, 300));
check("a bad bundle leaves gh untouched", badBundle.calls.length === 0, badBundle.calls.join(" | "));
check("a bad bundle creates nothing on GitHub", Object.keys(readStore().drafts).length === 0 && Object.keys(readStore().published).length === 0);

// 11. The files are fine but one asset lands incomplete: the read-back catches
// it and nothing is published. The draft stays, so a retry can finish it.
resetStore();
const halfUpload = liveRelease({ env: { GH_FAKE_UPLOAD_INCOMPLETE: assets.ipa } });
check("an incomplete upload is refused", halfUpload.code !== 0, `exit ${halfUpload.code}: ${halfUpload.output.slice(-400)}`);
check("the refusal names the asset and its state", new RegExp(`${assets.ipa} is new, not uploaded`).test(halfUpload.output), halfUpload.output.slice(-400));
check("nothing is published from an incomplete draft", callIndex(halfUpload, /--draft=false/) === -1);
check("the draft survives the failed read-back", Boolean(readStore().drafts[tag]) && !readStore().published[tag]);

// 12. The upload itself fails: no publish, and the draft is still there.
resetStore();
const failedUpload = liveRelease({ env: { GH_FAKE_UPLOAD: "fail" } });
check("a failed upload stops the run", failedUpload.code !== 0 && /the upload failed/.test(failedUpload.output), failedUpload.output.slice(-300));
check("a failed upload publishes nothing", callIndex(failedUpload, /--draft=false/) === -1);
check("a failed upload leaves the draft for a retry", Boolean(readStore().drafts[tag]));

// 13. The publish fails: the draft is kept, and the next run finishes it —
// reusing the same draft instead of dying on "release already exists".
resetStore();
const failedPublish = liveRelease({ env: { GH_FAKE_EDIT: "fail" } });
check("a publish that fails exits non-zero", failedPublish.code !== 0, `exit ${failedPublish.code}: ${failedPublish.output.slice(-300)}`);
check("the failure says the draft is still a draft", /still a draft — run this again/.test(failedPublish.output), failedPublish.output.slice(-300));
check("the publish was attempted", callIndex(failedPublish, /--draft=false/) !== -1);
check("the failed publish leaves the draft in place", Boolean(readStore().drafts[tag]) && !readStore().published[tag]);
check("the failed publish left four assets on the draft", draftAssets().length === 4);

const retry = liveRelease();
check("the retry publishes", retry.code === 0, `exit ${retry.code}: ${retry.output.slice(-400)}`);
check("the retry creates no second release", !retry.calls.some((call) => call.startsWith("release create")), retry.calls.join(" | ").slice(0, 300));
check("the retry re-uploads over the draft", /release upload .*--clobber/.test(uploadCall(retry) ?? ""));
check("the retry publishes the release it reused", Boolean(readStore().published[tag]) && !readStore().drafts[tag]);
check("the retried release holds four assets", publishedAssets().length === 4);
check("the retry reports four downloadable bundles", new RegExp(`${tag}: all four bundles are uploaded and downloadable`).test(retry.output));

// 14. Nothing above published by accident: the store only ever moved a draft it
// was handed, and no other tag was created.
check("only the tag under test was released", readStore().tags.length === 1 && readStore().tags[0] === tag);

rmSync(fixtures, { recursive: true, force: true });
rmSync(staged, { recursive: true, force: true });

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
