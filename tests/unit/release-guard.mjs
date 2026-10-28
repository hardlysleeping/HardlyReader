// The release guard: scripts/release.sh must refuse a release that is not four
// bundles, and must not touch GitHub while refusing. Every run here is --dry-run
// against fixture files, with a `gh` on PATH that records any call it gets — so a
// release suite can never publish anything by accident.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, truncateSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/release.sh");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

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

// Any call to gh is a failure: these runs are all --dry-run.
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

const allFour = [
  "--appimage", files.appimage,
  "--flatpak", files.flatpak,
  "--apk", files.apk,
  "--ipa", files.ipa,
];

// 1. All four present: the guard passes and prints the upload it would do.
const complete = release(allFour);
check("four valid bundles pass the guard", complete.code === 0, `exit ${complete.code}: ${complete.output.slice(-400)}`);
for (const name of [
  `hardlyreader-${version}-linux-x86_64.AppImage`,
  `hardlyreader-${version}-x86_64.flatpak`,
  `hardlyreader-${version}-android.apk`,
  `hardlyreader-${version}-ios.ipa`,
]) {
  check(`the upload names ${name}`, complete.output.includes(`release-v${version}/${name}`));
}
check("the upload comes before the publish", complete.output.indexOf("gh release upload") < complete.output.indexOf("--draft=false"));
check("the release is created as a draft", /gh release create v[\d.]+ .*--draft/.test(complete.output));

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
check("no release was staged by a dry run", !existsSync(join(root, "dist", `release-v${version}`)));

rmSync(fixtures, { recursive: true, force: true });

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
