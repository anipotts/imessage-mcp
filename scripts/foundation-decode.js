ObjC.import("Foundation");

const MAX_BLOBS = 500;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function run() {
  try {
    const inputData = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    const inputString = $.NSString.alloc.initWithDataEncoding(
      inputData,
      $.NSUTF8StringEncoding,
    );
    const request = JSON.parse(String(ObjC.unwrap(inputString)));
    if (!Array.isArray(request.blobs) || request.blobs.length > MAX_BLOBS) {
      return JSON.stringify({ status: "invalid_input" });
    }

    let totalBytes = 0;
    const results = [];
    for (const encoded of request.blobs) {
      if (typeof encoded !== "string") {
        results.push({ status: "malformed" });
        continue;
      }

      const data = $.NSData.alloc.initWithBase64EncodedStringOptions(encoded, 0);
      if (!data) {
        results.push({ status: "malformed" });
        continue;
      }
      totalBytes += Number(data.length);
      if (totalBytes > MAX_TOTAL_BYTES) {
        return JSON.stringify({ status: "invalid_input" });
      }

      try {
        const value = $.NSUnarchiver.unarchiveObjectWithData(data);
        const text = value && value.string ? ObjC.unwrap(value.string) : null;
        results.push(
          typeof text === "string"
            ? { status: "decoded", text }
            : { status: "unsupported" },
        );
      } catch (_error) {
        results.push({ status: "malformed" });
      }
    }

    return JSON.stringify({ status: "ok", results });
  } catch (_error) {
    return JSON.stringify({ status: "invalid_input" });
  }
}
