import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ImessageMcpError } from "./errors.js";

export type DecodeResult =
  | { status: "decoded"; text: string }
  | { status: "malformed" }
  | { status: "unsupported" };

export type EditMetadataResult =
  | { status: "decoded"; count: number; timestamps: number[] }
  | { status: "malformed" }
  | { status: "unsupported" };

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../native/message-text-decoder.js");
const MAX_BATCH_ITEMS = 500;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_TEXT_BYTES = 3 * 1024 * 1024;

type WaitResult = "ok" | "not-equal" | "timed-out";
type WaitAsync = (
  array: Int32Array,
  index: number,
  value: number,
  timeout?: number,
) => { async: true; value: Promise<WaitResult> } | { async: false; value: WaitResult };

interface NativeOutput {
  request_id: number;
  self_test: "passed" | "failed";
  error?: string;
  results: DecodeResult[];
  edit_results: EditMetadataResult[];
}

function isDecodeResult(value: unknown): value is DecodeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.status === "decoded") {
    return typeof result.text === "string" && Buffer.byteLength(result.text, "utf8") <= MAX_DECODED_TEXT_BYTES;
  }
  return result.status === "malformed" || result.status === "unsupported";
}

function isEditMetadataResult(value: unknown): value is EditMetadataResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.status === "malformed" || result.status === "unsupported") return true;
  return result.status === "decoded" &&
    Number.isSafeInteger(result.count) && Number(result.count) >= 0 &&
    Array.isArray(result.timestamps) &&
    result.timestamps.every((timestamp) => typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0);
}

function parseNativeOutput(value: unknown): NativeOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("decoder returned invalid output");
  const output = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(output.request_id) || Number(output.request_id) <= 0 ||
    (output.self_test !== "passed" && output.self_test !== "failed") ||
    !Array.isArray(output.results) || !output.results.every(isDecodeResult) ||
    !Array.isArray(output.edit_results) || !output.edit_results.every(isEditMetadataResult) ||
    (output.error !== undefined && typeof output.error !== "string")
  ) {
    throw new Error("decoder returned invalid output");
  }
  return output as unknown as NativeOutput;
}

interface PendingNativeRequest {
  id: number;
  resolve: (value: NativeOutput) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class NativeDecoderSession {
  private readonly child: ChildProcess;
  private readonly exit: Promise<void>;
  private resolveExit: (() => void) | null = null;
  private pending: PendingNativeRequest | null = null;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private closing = false;
  private exited = false;
  private exitReported = false;
  private readonly pid: number;

  constructor(
    private readonly onSpawn?: (pid: number) => void,
    private readonly onExit?: (pid: number) => void,
  ) {
    this.child = spawn("/usr/bin/osascript", ["-l", "JavaScript", SCRIPT], {
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      env: {
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin",
        TMPDIR: "/tmp",
      },
    });
    this.pid = this.child.pid ?? 0;
    if (this.pid > 0) this.onSpawn?.(this.pid);
    this.exit = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stdout?.on("error", (error) => this.fail(error));
    this.child.stdin?.on("error", (error) => {
      if (!this.closing) this.fail(error);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code) => {
      this.exited = true;
      this.reportExit();
      if (this.pending) this.rejectPending(new Error(code === 0 ? "decoder process exited" : "decoder process failed"));
      this.resolveExit?.();
      this.resolveExit = null;
    });
  }

  private reportExit(): void {
    if (this.exitReported) return;
    this.exitReported = true;
    if (this.pid > 0) this.onExit?.(this.pid);
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private fail(error: Error): void {
    this.rejectPending(error);
    if (!this.exited) this.child.kill("SIGKILL");
  }

  private consume(chunk: Buffer): void {
    if (this.exited) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_OUTPUT_BYTES) {
      this.fail(new Error("decoder output exceeded limit"));
      return;
    }
    let newline = this.buffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      newline = this.buffer.indexOf(0x0a);
      if (line.length === 0) continue;
      const pending = this.pending;
      if (!pending) {
        this.fail(new Error("decoder returned an unsolicited response"));
        return;
      }
      try {
        const output = parseNativeOutput(JSON.parse(line.toString("utf8")) as unknown);
        if (output.request_id !== pending.id) throw new Error("decoder response id did not match request");
        this.pending = null;
        clearTimeout(pending.timer);
        pending.resolve(output);
      } catch {
        this.fail(new Error("decoder returned invalid output"));
        return;
      }
    }
  }

  request(blobs: Buffer[], summaries: Buffer[], timeoutMs: number): Promise<NativeOutput> {
    if (this.exited || this.closing || !this.child.stdin) {
      return Promise.reject(new Error("decoder process is unavailable"));
    }
    if (this.pending) return Promise.reject(new Error("decoder request overlap is not allowed"));
    const id = ++this.sequence;
    const input = Buffer.from(`${JSON.stringify({
      request_id: id,
      blobs: blobs.map((blob) => blob.toString("base64")),
      summaries: summaries.map((blob) => blob.toString("base64")),
    })}\n`);
    if (input.length > 12 * 1024 * 1024) {
      return Promise.reject(new Error("decoder input exceeded limit"));
    }
    return new Promise<NativeOutput>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(new Error("decoder timeout"));
        this.child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref();
      this.pending = { id, resolve, reject, timer };
      this.child.stdin?.write(input, (error) => {
        if (error && this.pending?.id === id) this.fail(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.exit;
    this.closing = true;
    if (!this.exited) this.child.stdin?.end();
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill("SIGKILL");
    }, 2_000);
    timer.unref();
    await this.exit;
    clearTimeout(timer);
  }
}

export class MessageTextDecoder {
  private queue: Promise<unknown> = Promise.resolve();
  private health: "untested" | "healthy" | "failed" = "untested";
  private nativeSession: NativeDecoderSession | null = null;
  private sessionHolds = 0;

  constructor(
    private readonly sharedLock?: SharedArrayBuffer,
    private readonly lockOwner = 1,
  ) {}

  private async acquireGlobalLock(): Promise<void> {
    if (!this.sharedLock) return;
    const lock = new Int32Array(this.sharedLock);
    while (Atomics.compareExchange(lock, 0, 0, this.lockOwner) !== 0) {
      const observed = Atomics.load(lock, 0);
      const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;
      if (waitAsync) {
        const waiting = waitAsync(lock, 0, observed, 1_000);
        if (waiting.async) await waiting.value;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  private releaseGlobalLock(): void {
    if (!this.sharedLock) return;
    const lock = new Int32Array(this.sharedLock);
    if (Atomics.compareExchange(lock, 0, this.lockOwner, 0) === this.lockOwner) {
      Atomics.notify(lock, 0);
    }
  }

  private recordActiveDecoder(delta: 1 | -1): void {
    if (!this.sharedLock || this.sharedLock.byteLength < Int32Array.BYTES_PER_ELEMENT * 3) return;
    const lock = new Int32Array(this.sharedLock);
    const active = Atomics.add(lock, 1, delta) + delta;
    if (delta > 0) {
      let maximum = Atomics.load(lock, 2);
      while (active > maximum) {
        const observed = Atomics.compareExchange(lock, 2, maximum, active);
        if (observed === maximum) break;
        maximum = observed;
      }
    }
  }

  private async runLocked(blobs: Buffer[], summaries: Buffer[], timeoutMs: number): Promise<NativeOutput> {
    if (!this.nativeSession) {
      await this.acquireGlobalLock();
      this.recordActiveDecoder(1);
      const lock = this.sharedLock ? new Int32Array(this.sharedLock) : null;
      const onSpawn = lock && lock.length > 3
        ? (pid: number) => Atomics.store(lock, 3, pid)
        : undefined;
      const onExit = lock && lock.length > 3
        ? (pid: number) => Atomics.compareExchange(lock, 3, pid, 0)
        : undefined;
      try {
        this.nativeSession = new NativeDecoderSession(onSpawn, onExit);
      } catch (error) {
        this.recordActiveDecoder(-1);
        this.releaseGlobalLock();
        throw error;
      }
    }
    try {
      return await this.nativeSession.request(blobs, summaries, timeoutMs);
    } catch (error) {
      await this.closeNativeSession();
      throw error;
    } finally {
      if (this.sessionHolds === 0) await this.closeNativeSession();
    }
  }

  private async closeNativeSession(): Promise<void> {
    const session = this.nativeSession;
    if (!session) return;
    this.nativeSession = null;
    try {
      await session.close();
    } finally {
      this.recordActiveDecoder(-1);
      this.releaseGlobalLock();
    }
  }

  async withSession<T>(operation: () => Promise<T>): Promise<T> {
    this.sessionHolds += 1;
    try {
      return await operation();
    } finally {
      this.sessionHolds -= 1;
      if (this.sessionHolds === 0) {
        await this.queue.catch(() => undefined);
        await this.closeNativeSession();
      }
    }
  }

  healthState(): "untested" | "healthy" | "failed" {
    return this.health;
  }

  async selfTest(): Promise<boolean> {
    if (this.health === "healthy") return true;
    if (this.health === "failed") return false;
    const [result] = await this.decode([Buffer.alloc(0)]);
    return this.healthState() === "healthy" && result?.status === "malformed";
  }

  async decode(blobs: Buffer[]): Promise<DecodeResult[]> {
    const operation = this.queue.then(() => this.decodeSerial(blobs), () => this.decodeSerial(blobs));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async decodeEditMetadata(blobs: Buffer[]): Promise<EditMetadataResult[]> {
    const operation = this.queue.then(
      () => this.decodeEditMetadataSerial(blobs),
      () => this.decodeEditMetadataSerial(blobs),
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async decodeSerial(blobs: Buffer[]): Promise<DecodeResult[]> {
    if (!existsSync(SCRIPT) || process.platform !== "darwin") {
      this.health = "failed";
      throw new ImessageMcpError("DECODE_FAILED", "native Foundation decoder is unavailable");
    }
    const all: DecodeResult[] = [];
    let index = 0;
    while (index < blobs.length) {
      const batch: Buffer[] = [];
      let bytes = 0;
      while (index < blobs.length && batch.length < MAX_BATCH_ITEMS) {
        const blob = blobs[index];
        if (blob.length > MAX_BLOB_BYTES) {
          all.push({ status: "unsupported" });
          index += 1;
          continue;
        }
        if (batch.length > 0 && bytes + blob.length > MAX_BATCH_BYTES) break;
        batch.push(blob);
        bytes += blob.length;
        index += 1;
      }
      if (batch.length === 0) continue;
      let native: NativeOutput;
      try {
        native = await this.runLocked(batch, [], 15_000);
      } catch {
        this.health = "failed";
        throw new ImessageMcpError("DECODE_FAILED", "native Foundation text decoding failed");
      }
      if (native.self_test !== "passed" || native.results.length !== batch.length) {
        this.health = "failed";
        throw new ImessageMcpError("DECODE_FAILED", "native Foundation decoder self-test failed");
      }
      this.health = "healthy";
      all.push(...native.results);
    }
    return all;
  }


  private async decodeEditMetadataSerial(blobs: Buffer[]): Promise<EditMetadataResult[]> {
    if (!existsSync(SCRIPT) || process.platform !== "darwin") {
      this.health = "failed";
      throw new ImessageMcpError("DECODE_FAILED", "native Foundation decoder is unavailable");
    }
    const all: EditMetadataResult[] = [];
    let index = 0;
    while (index < blobs.length) {
      const batch: Buffer[] = [];
      let bytes = 0;
      while (index < blobs.length && batch.length < MAX_BATCH_ITEMS) {
        const blob = blobs[index];
        if (blob.length > MAX_BLOB_BYTES) {
          all.push({ status: "unsupported" });
          index += 1;
          continue;
        }
        if (batch.length > 0 && bytes + blob.length > MAX_BATCH_BYTES) break;
        batch.push(blob);
        bytes += blob.length;
        index += 1;
      }
      if (batch.length === 0) continue;
      let native: NativeOutput;
      try {
        native = await this.runLocked([], batch, 15_000);
      } catch {
        this.health = "failed";
        throw new ImessageMcpError("DECODE_FAILED", "native Foundation edit metadata decoding failed");
      }
      if (native.self_test !== "passed" || native.edit_results.length !== batch.length) {
        this.health = "failed";
        throw new ImessageMcpError("DECODE_FAILED", "native Foundation decoder self-test failed");
      }
      this.health = "healthy";
      all.push(...native.edit_results);
    }
    return all;
  }
}

export function populatedMessageText(text: unknown): string | null {
  if (typeof text !== "string" || text.length === 0 || text === "\ufffc") return null;
  return text;
}
