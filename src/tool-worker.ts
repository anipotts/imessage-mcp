import { parentPort, workerData } from "node:worker_threads";
import type { RuntimeConfig } from "./config.js";
import { asImessageMcpError } from "./errors.js";
import { errorResult } from "./result.js";
import { LocalToolRuntime } from "./tool-local.js";

interface RuntimeWorkerData {
  config: RuntimeConfig;
  masking_key: string;
  decoder_lock: SharedArrayBuffer;
  decoder_owner: number;
  warm_conversation_catalog: boolean;
}

interface CallMessage {
  type: "call";
  id: number;
  tool: string;
  params: Record<string, unknown>;
  search_building?: boolean;
}

if (!parentPort) throw new Error("tool worker requires a parent port");
const port = parentPort;

let runtime: LocalToolRuntime | null = null;
let activeRequestId: number | null = null;
try {
  const data = workerData as RuntimeWorkerData;
  runtime = new LocalToolRuntime(
    data.config,
    Buffer.from(data.masking_key, "base64"),
    data.decoder_lock,
    data.decoder_owner,
    data.warm_conversation_catalog,
    () => {
      if (activeRequestId !== null) port.postMessage({ type: "search_index_building", id: activeRequestId });
    },
  );
  await runtime.prepare();
  port.postMessage({ type: "ready" });
} catch (error) {
  const normalized = asImessageMcpError(error);
  port.postMessage({
    type: "init_error",
    error: { reason: normalized.reason, message: normalized.message },
  });
  setImmediate(() => process.exit(1));
}

// One request at a time per worker: a request holds this worker's database
// connection, so the background index build and tool calls take turns.
let queue: Promise<void> = Promise.resolve();
const serially = (work: () => Promise<void>) => {
  queue = queue.then(work, work);
};

port.on("message", (message: CallMessage | { type: "close" } | { type: "warm_search" }) => {
  if (message.type === "close") {
    runtime?.close();
    port.close();
    return;
  }
  if (!runtime) return;
  const active = runtime;
  if (message.type === "warm_search") {
    serially(async () => {
      const ok = await active.warmSearch().then(() => true, () => false);
      port.postMessage({ type: "search_warmed", ok });
    });
    return;
  }
  serially(async () => {
    let result;
    activeRequestId = message.id;
    try {
      result = await active.call(message.tool, message.params, { searchBuilding: message.search_building === true });
    } catch (error) {
      result = errorResult(message.tool, error, active.config.privacy_ceiling, active.maskingKey);
    } finally {
      activeRequestId = null;
    }
    port.postMessage({ type: "result", id: message.id, result });
  });
});
