// Decodes what Messages stores in chat.db without Foundation: message bodies
// archived by NSArchiver (typedstream) or NSKeyedArchiver (binary plist), and
// the edit history in message_summary_info (binary plist). Everything is
// bounded, nothing is instantiated, and unknown shapes are reported, never
// guessed. tests/archive.test.ts checks every path against Foundation.

import { MAX_ATTRIBUTED_BODY_BYTES } from "./limits.js";

export type DecodeResult =
  | { status: "decoded"; text: string }
  | { status: "malformed" }
  | { status: "unsupported" };

export type EditMetadataResult =
  | { status: "decoded"; count: number; timestamps: number[] }
  | { status: "malformed" }
  | { status: "unsupported" };

const MAX_DECODED_TEXT_BYTES = 3 * 1024 * 1024;
const MAX_PLIST_OBJECTS = 200_000;
const MAX_PLIST_DEPTH = 64;
const APPLE_EPOCH_MS = 978_307_200_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

// ---- typedstream (NSArchiver) ------------------------------------------------

// The two root prefixes Messages writes: an NSAttributedString or an
// NSMutableAttributedString whose string is an NSString or NSMutableString.
const TYPEDSTREAM_ROOTS = [
  "040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a656374008592848484084e53537472696e67019484012b",
  "040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b",
].map((hex) => Buffer.from(hex, "hex"));

function typedstreamLength(bytes: Buffer, offset: number): { length: number; next: number } | null {
  if (offset >= bytes.length) return null;
  const marker = bytes[offset];
  if (marker <= 0x7f) return { length: marker, next: offset + 1 };
  if (marker === 0x81 && offset + 2 < bytes.length) {
    return { length: bytes[offset + 1] | (bytes[offset + 2] << 8), next: offset + 3 };
  }
  if (marker === 0x82 && offset + 4 < bytes.length) {
    const length = bytes[offset + 1] | (bytes[offset + 2] << 8) | (bytes[offset + 3] << 16) | (bytes[offset + 4] << 24);
    return length >= 0 ? { length, next: offset + 5 } : null;
  }
  return null;
}

function decodeTypedstream(bytes: Buffer): string | null {
  if (bytes.length < 24) return null;
  const root = TYPEDSTREAM_ROOTS.find((prefix) => bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix));
  if (!root) return null;
  const encoded = typedstreamLength(bytes, root.length);
  if (!encoded || encoded.length < 0 || encoded.length > MAX_ATTRIBUTED_BODY_BYTES) return null;
  // An empty attributed string has no attribute runs: its zero-length text is
  // followed directly by the two closing bytes.
  if (encoded.length === 0 && encoded.next === bytes.length - 2 && bytes[encoded.next] === 0x86 && bytes[encoded.next + 1] === 0x86) {
    return "";
  }
  if (encoded.next + encoded.length >= bytes.length) return null;
  let cursor = encoded.next + encoded.length;
  if (
    bytes[cursor] !== 0x86 || bytes[cursor + 1] !== 0x84 || bytes[cursor + 2] !== 0x02 ||
    bytes[cursor + 3] !== 0x69 || bytes[cursor + 4] !== 0x49 || bytes[cursor + 5] !== 0x01
  ) return null;
  const runLength = typedstreamLength(bytes, cursor + 6);
  if (!runLength) return null;
  cursor = runLength.next;
  if (cursor >= bytes.length - 2 || bytes[cursor] !== 0x92 || bytes[bytes.length - 1] !== 0x86) return null;
  let text: string;
  try {
    text = utf8.decode(bytes.subarray(encoded.next, encoded.next + encoded.length));
  } catch {
    return null;
  }
  // The run length is the first attribute run, not necessarily the whole string.
  if (runLength.length < 0 || runLength.length > text.length) return null;
  if (text.length > 0 && runLength.length === 0) return null;
  return text;
}

// ---- binary plist --------------------------------------------------------------

export type PlistValue =
  | null | boolean | number | bigint | string | Buffer | PlistDate | PlistUid | PlistValue[] | Map<string, PlistValue>;
export class PlistDate { constructor(readonly appleSeconds: number) {} }
export class PlistUid { constructor(readonly index: number) {} }

class PlistError extends Error {}

function readUnsigned(bytes: Buffer, offset: number, size: number): number {
  if (size < 1 || size > 8 || offset + size > bytes.length) throw new PlistError("out of bounds");
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + bytes[offset + index];
  if (!Number.isSafeInteger(value)) throw new PlistError("integer too large");
  return value;
}

export function parseBinaryPlist(bytes: Buffer): PlistValue {
  if (bytes.length < 40 || bytes.subarray(0, 8).toString("latin1") !== "bplist00") throw new PlistError("not a binary plist");
  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6];
  const refSize = bytes[trailer + 7];
  const count = readUnsigned(bytes, trailer + 8, 8);
  const top = readUnsigned(bytes, trailer + 16, 8);
  const table = readUnsigned(bytes, trailer + 24, 8);
  if (count < 1 || count > MAX_PLIST_OBJECTS || top >= count || offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) {
    throw new PlistError("invalid trailer");
  }
  if (table < 8 || table + count * offsetSize > trailer) throw new PlistError("invalid offset table");
  const offsets = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    const offset = readUnsigned(bytes, table + index * offsetSize, offsetSize);
    if (offset < 8 || offset >= table) throw new PlistError("invalid object offset");
    offsets[index] = offset;
  }

  const resolving = new Set<number>();
  const cache = new Map<number, PlistValue>();

  const lengthAt = (marker: number, offset: number): { length: number; next: number } => {
    const low = marker & 0x0f;
    if (low !== 0x0f) return { length: low, next: offset + 1 };
    const intMarker = bytes[offset + 1];
    if (intMarker === undefined || (intMarker & 0xf0) !== 0x10) throw new PlistError("invalid length");
    const size = 1 << (intMarker & 0x0f);
    return { length: readUnsigned(bytes, offset + 2, size), next: offset + 2 + size };
  };

  const object = (ref: number, depth: number): PlistValue => {
    if (ref >= count) throw new PlistError("invalid reference");
    const cached = cache.get(ref);
    if (cached !== undefined) return cached;
    if (depth > MAX_PLIST_DEPTH || resolving.has(ref)) throw new PlistError("nesting too deep or cyclic");
    resolving.add(ref);
    const offset = offsets[ref];
    const marker = bytes[offset];
    const kind = marker >> 4;
    let value: PlistValue;
    switch (kind) {
      case 0x0:
        if (marker === 0x00) value = null;
        else if (marker === 0x08) value = false;
        else if (marker === 0x09) value = true;
        else throw new PlistError("unsupported singleton");
        break;
      case 0x1: {
        const size = 1 << (marker & 0x0f);
        if (offset + 1 + size > table) throw new PlistError("out of bounds");
        if (size === 8) value = Number(bytes.readBigInt64BE(offset + 1));
        else if (size <= 4) value = readUnsigned(bytes, offset + 1, size);
        else throw new PlistError("unsupported integer size");
        break;
      }
      case 0x2: {
        const size = 1 << (marker & 0x0f);
        if (offset + 1 + size > table) throw new PlistError("out of bounds");
        if (size === 4) value = bytes.readFloatBE(offset + 1);
        else if (size === 8) value = bytes.readDoubleBE(offset + 1);
        else throw new PlistError("unsupported real size");
        break;
      }
      case 0x3:
        if (marker !== 0x33 || offset + 9 > table) throw new PlistError("invalid date");
        value = new PlistDate(bytes.readDoubleBE(offset + 1));
        break;
      case 0x4: {
        const { length, next } = lengthAt(marker, offset);
        if (next + length > table) throw new PlistError("out of bounds");
        value = bytes.subarray(next, next + length);
        break;
      }
      case 0x5: {
        const { length, next } = lengthAt(marker, offset);
        if (next + length > table) throw new PlistError("out of bounds");
        value = bytes.subarray(next, next + length).toString("latin1");
        break;
      }
      case 0x6: {
        const { length, next } = lengthAt(marker, offset);
        if (next + length * 2 > table) throw new PlistError("out of bounds");
        const units = Buffer.from(bytes.subarray(next, next + length * 2));
        units.swap16();
        value = units.toString("utf16le");
        break;
      }
      case 0x8: {
        const size = (marker & 0x0f) + 1;
        value = new PlistUid(readUnsigned(bytes, offset + 1, size));
        break;
      }
      case 0xa:
      case 0xc: {
        const { length, next } = lengthAt(marker, offset);
        if (length > count || next + length * refSize > table) throw new PlistError("out of bounds");
        const items: PlistValue[] = [];
        for (let index = 0; index < length; index += 1) {
          items.push(object(readUnsigned(bytes, next + index * refSize, refSize), depth + 1));
        }
        value = items;
        break;
      }
      case 0xd: {
        const { length, next } = lengthAt(marker, offset);
        if (length > count || next + length * 2 * refSize > table) throw new PlistError("out of bounds");
        const map = new Map<string, PlistValue>();
        for (let index = 0; index < length; index += 1) {
          const key = object(readUnsigned(bytes, next + index * refSize, refSize), depth + 1);
          if (typeof key !== "string") throw new PlistError("non-string dictionary key");
          map.set(key, object(readUnsigned(bytes, next + (length + index) * refSize, refSize), depth + 1));
        }
        value = map;
        break;
      }
      default:
        throw new PlistError("unsupported object type");
    }
    resolving.delete(ref);
    cache.set(ref, value);
    return value;
  };

  return object(top, 0);
}

// ---- keyed archives (NSKeyedArchiver) ----------------------------------------------

// The classes Foundation's secure decode allows for a Messages body. An
// archive naming any other class is refused, as NSKeyedUnarchiver refuses it.
const KEYED_ALLOWED = new Set([
  "NSAttributedString", "NSMutableAttributedString", "NSString", "NSMutableString", "NSDictionary",
  "NSMutableDictionary", "NSArray", "NSMutableArray", "NSNumber", "NSData", "NSMutableData", "NSDate",
  "NSValue", "NSNull", "NSURL", "NSUUID", "NSObject",
]);

function decodeKeyed(bytes: Buffer): string | null {
  let root: PlistValue;
  try {
    root = parseBinaryPlist(bytes);
  } catch {
    return null;
  }
  if (!(root instanceof Map) || root.get("$archiver") !== "NSKeyedArchiver") return null;
  const objects = root.get("$objects");
  const top = root.get("$top");
  if (!Array.isArray(objects) || !(top instanceof Map)) return null;
  for (const item of objects) {
    if (item instanceof Map && typeof item.get("$classname") === "string") {
      const classes = item.get("$classes");
      const names = Array.isArray(classes) ? classes : [item.get("$classname")];
      if (!names.every((name) => typeof name === "string" && KEYED_ALLOWED.has(name))) return null;
    }
  }
  const deref = (value: PlistValue | undefined): PlistValue | undefined =>
    value instanceof PlistUid ? objects[value.index] : value;
  const className = (value: PlistValue | undefined): string | null => {
    if (!(value instanceof Map)) return null;
    const cls = deref(value.get("$class"));
    return cls instanceof Map && typeof cls.get("$classname") === "string" ? cls.get("$classname") as string : null;
  };
  const stringOf = (value: PlistValue | undefined): string | null => {
    const resolved = deref(value);
    if (typeof resolved === "string") return resolved === "$null" ? null : resolved;
    const name = className(resolved);
    if ((name === "NSString" || name === "NSMutableString") && resolved instanceof Map) {
      const inner = deref(resolved.get("NS.string"));
      return typeof inner === "string" ? inner : null;
    }
    return null;
  };
  const object = deref(top.get("root"));
  const name = className(object);
  if ((name === "NSAttributedString" || name === "NSMutableAttributedString") && object instanceof Map) {
    return stringOf(object.get("NSString"));
  }
  return stringOf(object);
}

export function decodeBody(blob: Buffer): DecodeResult {
  if (blob.length > MAX_ATTRIBUTED_BODY_BYTES) return { status: "unsupported" };
  const text = decodeTypedstream(blob) ?? decodeKeyed(blob);
  if (text === null) return { status: "malformed" };
  if (Buffer.byteLength(text, "utf8") > MAX_DECODED_TEXT_BYTES) return { status: "unsupported" };
  return { status: "decoded", text };
}

// ---- edit history (message_summary_info) ------------------------------------------

// Foundation's NSNumber coercion of an event date, for parity with the
// Foundation reference: numbers as is, dates as milliseconds since 1970,
// strings and booleans through Number().
function eventDate(value: PlistValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof PlistDate) return value.appleSeconds * 1000 + APPLE_EPOCH_MS;
  if (typeof value === "string" || typeof value === "boolean") return Number(value);
  return Number.NaN;
}

export function decodeEditHistory(blob: Buffer): EditMetadataResult {
  if (blob.length > MAX_ATTRIBUTED_BODY_BYTES) return { status: "unsupported" };
  let root: PlistValue;
  try {
    root = parseBinaryPlist(blob);
  } catch {
    return { status: "malformed" };
  }
  if (!(root instanceof Map)) return { status: "malformed" };
  const collections = root.get("ec");
  if (collections === undefined) return { status: "decoded", count: 0, timestamps: [] };
  if (!(collections instanceof Map)) return { status: "malformed" };
  const timestamps: number[] = [];
  for (const history of collections.values()) {
    if (!Array.isArray(history)) return { status: "malformed" };
    for (let index = 1; index < history.length; index += 1) {
      const event = history[index];
      if (!(event instanceof Map)) return { status: "malformed" };
      const date = eventDate(event.get("d"));
      if (!Number.isFinite(date) || date <= 0) return { status: "malformed" };
      timestamps.push(date);
    }
  }
  const unique = [...new Set(timestamps)].sort((left, right) => left - right);
  return { status: "decoded", count: unique.length, timestamps: unique };
}
