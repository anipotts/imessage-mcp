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
}

if (!parentPort) throw new Error("tool worker requires a parent port");
const port = parentPort;

let runtime: LocalToolRuntime | null = null;
try {
  const data = workerData as RuntimeWorkerData;
  runtime = new LocalToolRuntime(
    data.config,
    Buffer.from(data.masking_key, "base64"),
    data.decoder_lock,
    data.decoder_owner,
    data.warm_conversation_catalog,
  );
  port.postMessage({ type: "ready" });
} catch (error) {
  const normalized = asImessageMcpError(error);
  port.postMessage({
    type: "init_error",
    error: { reason: normalized.reason, message: normalized.message },
  });
  setImmediate(() => process.exit(1));
}

port.on("message", async (message: CallMessage | { type: "close" }) => {
  if (message.type === "close") {
    runtime?.close();
    port.close();
    return;
  }
  if (!runtime) return;
  let result;
  try {
    result = await runtime.call(message.tool, message.params);
  } catch (error) {
    result = errorResult(message.tool, error, runtime.config.privacy_ceiling, runtime.maskingKey);
  }
  port.postMessage({ type: "result", id: message.id, result });
});
