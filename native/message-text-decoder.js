ObjC.import("Foundation");

const MAX_ITEMS = 500;
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_INPUT_CHARS = 12 * 1024 * 1024;
const LEGACY_MAGIC = "streamtyped";
const LEGACY_ROOT_PREFIX_HEX = [
  "040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a656374008592848484084e53537472696e67019484012b",
  "040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b",
];

function byteStringFromHex(hex) {
  let value = "";
  for (let index = 0; index < hex.length; index += 2) {
    value += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
  }
  return value;
}

const LEGACY_ROOT_PREFIXES = LEGACY_ROOT_PREFIX_HEX.map(byteStringFromHex);

function writeOutput(value) {
  const data = $(JSON.stringify(value) + "\n").dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

function objectText(object) {
  if (!object) return null;
  try {
    if (object.isKindOfClass($.NSAttributedString)) return String(ObjC.unwrap(object.string));
    if (object.isKindOfClass($.NSString)) return String(ObjC.unwrap(object));
  } catch (_error) {}
  return null;
}

function bytesFromData(data) {
  const string = $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding);
  return string ? String(ObjC.unwrap(string)) : null;
}

function byteAt(bytes, index) {
  return bytes.charCodeAt(index) & 0xff;
}

function readLegacyLength(bytes, offset) {
  if (offset >= bytes.length) return null;
  const marker = byteAt(bytes, offset);
  if (marker <= 0x7f) return { length: marker, next: offset + 1 };
  if (marker === 0x81 && offset + 2 < bytes.length) {
    return { length: byteAt(bytes, offset + 1) | (byteAt(bytes, offset + 2) << 8), next: offset + 3 };
  }
  if (marker === 0x82 && offset + 4 < bytes.length) {
    const length = byteAt(bytes, offset + 1) |
      (byteAt(bytes, offset + 2) << 8) |
      (byteAt(bytes, offset + 3) << 16) |
      (byteAt(bytes, offset + 4) << 24);
    return length >= 0 ? { length, next: offset + 5 } : null;
  }
  return null;
}

function decodeLegacy(data) {
  const bytes = bytesFromData(data);
  if (!bytes || bytes.length < 24) return null;
  if (
    byteAt(bytes, 0) !== 0x04 ||
    byteAt(bytes, 1) !== LEGACY_MAGIC.length ||
    bytes.slice(2, 2 + LEGACY_MAGIC.length) !== LEGACY_MAGIC
  ) return null;

  const rootPrefix = LEGACY_ROOT_PREFIXES.find((prefix) => bytes.slice(0, prefix.length) === prefix);
  if (!rootPrefix) return null;
  const contentOffset = rootPrefix.length;
  const encoded = readLegacyLength(bytes, contentOffset);
  if (!encoded || encoded.length < 0 || encoded.length > MAX_BLOB_BYTES) return null;
  if (encoded.next + encoded.length >= bytes.length) return null;
  let cursor = encoded.next + encoded.length;
  if (
    byteAt(bytes, cursor) !== 0x86 ||
    byteAt(bytes, cursor + 1) !== 0x84 ||
    byteAt(bytes, cursor + 2) !== 0x02 ||
    byteAt(bytes, cursor + 3) !== 0x69 ||
    byteAt(bytes, cursor + 4) !== 0x49 ||
    byteAt(bytes, cursor + 5) !== 0x01
  ) return null;
  const characterLength = readLegacyLength(bytes, cursor + 6);
  if (!characterLength) return null;
  cursor = characterLength.next;
  if (
    cursor >= bytes.length - 2 ||
    byteAt(bytes, cursor) !== 0x92 ||
    byteAt(bytes, bytes.length - 1) !== 0x86
  ) return null;
  const textData = data.subdataWithRange($.NSMakeRange(encoded.next, encoded.length));
  const text = $.NSString.alloc.initWithDataEncoding(textData, $.NSUTF8StringEncoding);
  if (!text) return null;
  const value = String(ObjC.unwrap(text));
  // This value is the first attributed run length, not necessarily the full
  // string length. Rich Messages archives can contain multiple shorter runs.
  if (characterLength.length < 0 || characterLength.length > value.length) return null;
  if (value.length > 0 && characterLength.length === 0) return null;
  return value;
}

function secureClasses() {
  const classes = $.NSMutableSet.set;
  for (const value of [
    $.NSAttributedString,
    $.NSMutableAttributedString,
    $.NSString,
    $.NSMutableString,
    $.NSDictionary,
    $.NSMutableDictionary,
    $.NSArray,
    $.NSMutableArray,
    $.NSNumber,
    $.NSData,
    $.NSMutableData,
    $.NSDate,
    $.NSValue,
    $.NSNull,
    $.NSURL,
    $.NSUUID,
  ]) {
    classes.addObject(value);
  }
  return classes;
}

function decodeKeyed(data) {
  try {
    const error = Ref();
    const keyed = $.NSKeyedUnarchiver.unarchivedObjectOfClassesFromDataError(
      secureClasses(),
      data,
      error,
    );
    return objectText(keyed);
  } catch (_error) {
    return null;
  }
}

function decodeData(data) {
  const legacy = decodeLegacy(data);
  if (legacy !== null) return { status: "decoded", text: legacy };
  const keyed = decodeKeyed(data);
  if (keyed !== null) return { status: "decoded", text: keyed };
  return { status: "malformed" };
}

function decodeEditMetadata(data) {
  try {
    const format = Ref();
    const error = Ref();
    const root = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(
      data,
      $.NSPropertyListImmutable,
      format,
      error,
    );
    if (!root || !root.isKindOfClass($.NSDictionary)) return { status: "malformed" };
    const editCollections = root.objectForKey($("ec"));
    if (!editCollections) return { status: "decoded", count: 0, timestamps: [] };
    if (!editCollections.isKindOfClass($.NSDictionary)) return { status: "malformed" };
    const histories = editCollections.allValues;
    const timestamps = [];
    for (let historyIndex = 0; historyIndex < Number(histories.count); historyIndex += 1) {
      const history = histories.objectAtIndex(historyIndex);
      if (!history || !history.isKindOfClass($.NSArray)) return { status: "malformed" };
      for (let eventIndex = 1; eventIndex < Number(history.count); eventIndex += 1) {
        const event = history.objectAtIndex(eventIndex);
        if (!event || !event.isKindOfClass($.NSDictionary)) return { status: "malformed" };
        const rawDate = event.objectForKey($("d"));
        const date = Number(ObjC.unwrap(rawDate));
        if (!Number.isFinite(date) || date <= 0) return { status: "malformed" };
        timestamps.push(date);
      }
    }
    const unique = [...new Set(timestamps)].sort((left, right) => left - right);
    return { status: "decoded", count: unique.length, timestamps: unique };
  } catch (_error) {
    return { status: "malformed" };
  }
}

function editMetadataFixture() {
  const history = $.NSMutableArray.array;
  for (const date of [700000000, 700000010]) {
    const event = $.NSMutableDictionary.dictionary;
    event.setObjectForKey($(date), $("d"));
    history.addObject(event);
  }
  const edits = $.NSMutableDictionary.dictionary;
  edits.setObjectForKey(history, $("0"));
  const root = $.NSMutableDictionary.dictionary;
  root.setObjectForKey(edits, $("ec"));
  const error = Ref();
  return $.NSPropertyListSerialization.dataWithPropertyListFormatOptionsError(
    root,
    $.NSPropertyListBinaryFormat_v1_0,
    0,
    error,
  );
}

function selfTest() {
  try {
    const expected = "foundation self-test ✨\nline two";
    const object = $.NSMutableAttributedString.alloc.init;
    object.mutableString.appendString($(expected));
    const legacy = $.NSArchiver.archivedDataWithRootObject(object);
    const keyed = $.NSKeyedArchiver.archivedDataWithRootObject(object);
    const legacyDecoded = decodeData(legacy);
    const keyedDecoded = decodeData(keyed);
    const malformedDecoded = decodeData($.NSData.data);
    const editDecoded = decodeEditMetadata(editMetadataFixture());
    return legacyDecoded.status === "decoded" && legacyDecoded.text === expected &&
      keyedDecoded.status === "decoded" && keyedDecoded.text === expected &&
      malformedDecoded.status === "malformed" &&
      editDecoded.status === "decoded" && editDecoded.count === 1 && editDecoded.timestamps[0] === 700000010;
  } catch (_error) {
    return false;
  }
}

function processInput(input, healthy) {
  const requestId = input && Number.isSafeInteger(input.request_id) ? input.request_id : 0;
  try {
    if (!healthy) return { request_id: requestId, self_test: "failed", results: [], edit_results: [] };
    if (!input || requestId <= 0 || !Array.isArray(input.blobs) || !Array.isArray(input.summaries) ||
        input.blobs.length > MAX_ITEMS || input.summaries.length > MAX_ITEMS) {
      return { request_id: requestId, self_test: "passed", error: "invalid_input", results: [], edit_results: [] };
    }
    const results = input.blobs.map((encoded) => {
      if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_BLOB_BYTES * 4 / 3) + 8) {
        return { status: "unsupported" };
      }
      try {
        const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(encoded), 0);
        if (!data || Number(data.length) > MAX_BLOB_BYTES) return { status: "unsupported" };
        return decodeData(data);
      } catch (_error) {
        return { status: "malformed" };
      }
    });
    const editResults = input.summaries.map((encoded) => {
      if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_BLOB_BYTES * 4 / 3) + 8) {
        return { status: "unsupported" };
      }
      try {
        const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(encoded), 0);
        if (!data || Number(data.length) > MAX_BLOB_BYTES) return { status: "unsupported" };
        return decodeEditMetadata(data);
      } catch (_error) {
        return { status: "malformed" };
      }
    });
    return { request_id: requestId, self_test: "passed", results, edit_results: editResults };
  } catch (_error) {
    return { request_id: requestId, self_test: "failed", results: [], edit_results: [] };
  }
}

function run() {
  const healthy = selfTest();
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  let pending = "";
  let oversized = false;
  while (true) {
    const data = input.availableData;
    if (!data || Number(data.length) === 0) break;
    const string = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    if (!string) {
      writeOutput({ request_id: 0, self_test: "failed", results: [], edit_results: [] });
      return;
    }
    pending += String(ObjC.unwrap(string));
    if (pending.length > MAX_INPUT_CHARS) {
      oversized = true;
      pending = "";
    }
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (oversized) {
        writeOutput({ request_id: 0, self_test: healthy ? "passed" : "failed", error: "invalid_input", results: [], edit_results: [] });
        oversized = false;
      } else if (line.length > 0) {
        try {
          writeOutput(processInput(JSON.parse(line), healthy));
        } catch (_error) {
          writeOutput({ request_id: 0, self_test: healthy ? "passed" : "failed", error: "invalid_input", results: [], edit_results: [] });
        }
      }
      newline = pending.indexOf("\n");
    }
  }
  if (pending.length > 0 || oversized) {
    writeOutput({ request_id: 0, self_test: healthy ? "passed" : "failed", error: "invalid_input", results: [], edit_results: [] });
  }
}
