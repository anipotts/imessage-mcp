import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config.js";

interface TestWorker {
  calls: Array<{ id: number; tool: string }>;
  emit(event: string, message: unknown): boolean;
}
const workers = vi.hoisted(() => ({ instances: [] as TestWorker[] }));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      stdout = { resume() {} };
      stderr = { resume() {} };
      calls: Array<{ id: number; tool: string }> = [];
      constructor() {
        super();
        workers.instances.push(this);
        Promise.resolve().then(() => this.emit("message", { type: "ready" }));
      }
      postMessage(message: { type: string; id: number; tool: string }) {
        if (message.type === "call") this.calls.push(message);
      }
      async terminate() { return 0; }
    },
  };
});

import { ToolRuntime } from "../src/tools.js";

const config: RuntimeConfig = {
  database_path: "/synthetic/chat.db", source_mode: "copy", contacts_mode: "none",
  privacy_ceiling: "aggregate", transport: "stdio", port: 3000,
  attachment_paths_enabled: false, reference_key: null, database_id: null,
};
const result = { content: [], structuredContent: { data: { total_matches: 1 } } };

afterEach(() => { vi.useRealTimers(); workers.instances.length = 0; });

describe("search worker deadlines", () => {
  it("keeps repeated rebuild notices within the original 90-second hard deadline", async () => {
    vi.useFakeTimers();
    const runtime = new ToolRuntime(config);
    try {
      await runtime.initialize();
      const worker = workers.instances[0];
      const pending = runtime.call("search_messages", {});
      await vi.waitFor(() => expect(worker.calls).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(80_000);
      worker.emit("message", { type: "search_index_building", id: worker.calls[0].id });
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await pending).toMatchObject({ isError: true });
    } finally {
      await runtime.close();
    }
  });

  it.each([true, false])("gives a reported rebuild the cold budget: %s", async (rebuilding) => {
    vi.useFakeTimers();
    const runtime = new ToolRuntime(config);
    try {
      await runtime.initialize();
      const worker = workers.instances[0];
      const first = runtime.call("search_messages", {});
      await vi.waitFor(() => expect(worker.calls).toHaveLength(1));
      worker.emit("message", { type: "result", id: worker.calls[0].id, result });
      expect(await first).toEqual(result);

      let settled = false;
      const refreshed = runtime.call("search_messages", {}).then((value) => { settled = true; return value; });
      await vi.waitFor(() => expect(worker.calls).toHaveLength(2));
      if (rebuilding) worker.emit("message", { type: "search_index_building", id: worker.calls[1].id });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(settled).toBe(!rebuilding);
      if (rebuilding) {
        await vi.advanceTimersByTimeAsync(30_000);
        worker.emit("message", { type: "result", id: worker.calls[1].id, result });
        expect(await refreshed).toEqual(result);
      } else {
        expect(await refreshed).toMatchObject({ isError: true });
      }
    } finally { await runtime.close(); }
  });
});
