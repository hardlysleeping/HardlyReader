/**
 * A zip, written and read by hand.
 *
 * The sync archive is a zip because that is what a person can attach to an
 * email, drop in a folder and hand to another copy of the app — not because
 * this file wants a compression library in the binary. So this is the smallest
 * zip that a computer will agree is a zip: stored entries (no compression at
 * all), one central directory, one end record, and a CRC per file so a
 * truncated download is refused rather than half-imported.
 *
 * Reading is deliberately more generous than writing, because the file may
 * arrive from a machine that compressed it: a deflated entry is inflated with
 * the platform's own `DecompressionStream` (`deflate-raw`), which every runtime
 * this app runs in already has. Nothing else is supported, and an entry whose
 * method is neither stored nor deflated is refused by name rather than guessed
 * at — a zip is an interchange format and a wrong guess is a silent corruption.
 *
 * No dependencies, and none wanted: `zip` is a container, and the container is
 * ten functions wide.
 */

/** One file inside the archive. */
export interface ZipFile {
  /** The path inside the zip. Forward slashes; no leading slash. */
  name: string;
  data: Uint8Array;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

const STORED = 0;
const DEFLATED = 8;

/** Bit 11: the name is UTF-8, which is the only spelling this writer uses. */
const FLAG_UTF8 = 0x0800;

/** The 32-bit ceiling. A bigger entry would need ZIP64, which this does not write. */
const LIMIT_32 = 0xffffffff;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** The CRC-32 every zip entry carries, so a damaged file cannot pass as whole. */
export function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    value = CRC_TABLE[(value ^ data[index]!) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** A DOS timestamp, which is what a zip header holds. 1980 is its year zero. */
function dosStamp(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * The archive, as bytes.
 *
 * Every entry is stored, so the file is readable by anything that can read a
 * zip including a person with `unzip -o`. `now` is a parameter because the
 * header carries a timestamp and a suite should not have to wait a second for
 * two builds to agree.
 */
export function writeZip(files: readonly ZipFile[], now: Date = new Date()): Uint8Array {
  const stamp = dosStamp(now);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    if (file.data.length > LIMIT_32) {
      throw new Error(`${file.name} is too large for this archive format`);
    }

    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, LOCAL_SIGNATURE, true);
    view.setUint16(4, 20, true); // version needed: 2.0, which is what stored needs
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, STORED, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.data.length, true);
    view.setUint32(22, file.data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    local.set(name, 30);

    parts.push(local, file.data);

    const header = new Uint8Array(46 + name.length);
    const head = new DataView(header.buffer);
    head.setUint32(0, CENTRAL_SIGNATURE, true);
    head.setUint16(4, 20, true); // version made by
    head.setUint16(6, 20, true); // version needed
    head.setUint16(8, FLAG_UTF8, true);
    head.setUint16(10, STORED, true);
    head.setUint16(12, stamp.time, true);
    head.setUint16(14, stamp.date, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, file.data.length, true);
    head.setUint32(24, file.data.length, true);
    head.setUint16(28, name.length, true);
    // Extra, comment, disk number, internal and external attributes: all zero,
    // because none of them mean anything for a file this writer made.
    head.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);

    offset += local.length + file.data.length;
  }

  const directory = concat(central);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, END_SIGNATURE, true);
  tail.setUint16(4, 0, true); // this disk
  tail.setUint16(6, 0, true); // disk with the directory
  tail.setUint16(8, files.length, true);
  tail.setUint16(10, files.length, true);
  tail.setUint32(12, directory.length, true);
  tail.setUint32(16, offset, true);
  tail.setUint16(20, 0, true); // no comment

  return concat([...parts, directory, end]);
}

/** Where the end record starts, or -1. It is last, but a comment may follow it. */
function findEnd(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const earliest = Math.max(0, bytes.length - (22 + 0xffff));
  for (let at = bytes.length - 22; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === END_SIGNATURE) return at;
  }
  return -1;
}

/** What one entry says about itself, before its bytes are read. */
interface CentralEntry {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/**
 * Every file in the archive, by name.
 *
 * A zip that is not a zip, one this build cannot decompress, an entry whose CRC
 * does not match its bytes, or a ZIP64 archive are all refused with a sentence
 * a settings row can show — never a partial answer, because a partial archive is
 * a partial library.
 */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (bytes.length < 22) throw new Error("That file is not a zip archive");
  const end = findEnd(bytes);
  if (end < 0) throw new Error("That file is not a zip archive — no zip directory was found");
  const tail = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const count = tail.getUint16(end + 10, true);
  const directoryAt = tail.getUint32(end + 16, true);
  if (count === 0xffff || directoryAt === LIMIT_32) {
    throw new Error("That archive is a ZIP64 file, which this build does not read");
  }

  const entries: CentralEntry[] = [];
  let cursor = directoryAt;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length) throw new Error("That archive is truncated");
    const head = new DataView(bytes.buffer, bytes.byteOffset + cursor, bytes.length - cursor);
    if (head.getUint32(0, true) !== CENTRAL_SIGNATURE) {
      throw new Error("That archive's directory is damaged");
    }
    const nameLength = head.getUint16(28, true);
    const extraLength = head.getUint16(30, true);
    const commentLength = head.getUint16(32, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({
      name,
      method: head.getUint16(10, true),
      crc: head.getUint32(16, true),
      compressed: head.getUint32(20, true),
      size: head.getUint32(24, true),
      offset: head.getUint32(42, true),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const head = new DataView(bytes.buffer, bytes.byteOffset + entry.offset, bytes.length - entry.offset);
    if (head.getUint32(0, true) !== LOCAL_SIGNATURE) {
      throw new Error(`That archive's entry for ${entry.name} is damaged`);
    }
    const start =
      entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const raw = bytes.subarray(start, start + entry.compressed);

    let data: Uint8Array;
    if (entry.method === STORED) {
      data = raw;
    } else if (entry.method === DEFLATED) {
      data = await inflate(raw, entry.name);
    } else {
      throw new Error(
        `That archive holds ${entry.name} in a compression this build does not read (method ${entry.method})`,
      );
    }

    if (data.length !== entry.size) {
      throw new Error(`That archive's copy of ${entry.name} is the wrong length`);
    }
    if (crc32(data) !== entry.crc) {
      throw new Error(`That archive's copy of ${entry.name} is damaged — the checksum does not match`);
    }
    files.set(entry.name, data);
  }
  return files;
}

/** Deflate, with the platform's own decoder. Every runtime here has one. */
async function inflate(raw: Uint8Array, name: string): Promise<Uint8Array> {
  const stream = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (stream === undefined) {
    throw new Error(`That archive is compressed and this build cannot decompress ${name}`);
  }
  const source = new Blob([raw as BlobPart]);
  const inflated = source.stream().pipeThrough(new stream("deflate-raw"));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}
