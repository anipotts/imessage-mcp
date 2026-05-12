import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withRequestContext } from "../src/context.js";
import { createWebhookSubscription, resetWebhookStateForTests } from "../src/webhooks.js";

const originalEnv = {
  IMESSAGE_WEBHOOK_STATE_FILE: process.env.IMESSAGE_WEBHOOK_STATE_FILE,
  IMESSAGE_EVENT_LOG_FILE: process.env.IMESSAGE_EVENT_LOG_FILE,
  IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS: process.env.IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS,
  IMESSAGE_WEBHOOK_ALLOWED_HOSTS: process.env.IMESSAGE_WEBHOOK_ALLOWED_HOSTS,
};

let tmpPath: string | null = null;

function configureTempFiles(): void {
  if (!tmpPath) {
    tmpPath = mkdtempSync(path.join(tmpdir(), "imessage-mcp-webhooks-"));
  }
  process.env.IMESSAGE_WEBHOOK_STATE_FILE = path.join(tmpPath, "webhooks.json");
  process.env.IMESSAGE_EVENT_LOG_FILE = path.join(tmpPath, "events.jsonl");
}

afterEach(() => {
  resetWebhookStateForTests();

  if (originalEnv.IMESSAGE_WEBHOOK_STATE_FILE === undefined) delete process.env.IMESSAGE_WEBHOOK_STATE_FILE;
  else process.env.IMESSAGE_WEBHOOK_STATE_FILE = originalEnv.IMESSAGE_WEBHOOK_STATE_FILE;

  if (originalEnv.IMESSAGE_EVENT_LOG_FILE === undefined) delete process.env.IMESSAGE_EVENT_LOG_FILE;
  else process.env.IMESSAGE_EVENT_LOG_FILE = originalEnv.IMESSAGE_EVENT_LOG_FILE;

  if (originalEnv.IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS === undefined) delete process.env.IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS;
  else process.env.IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS = originalEnv.IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS;

  if (originalEnv.IMESSAGE_WEBHOOK_ALLOWED_HOSTS === undefined) delete process.env.IMESSAGE_WEBHOOK_ALLOWED_HOSTS;
  else process.env.IMESSAGE_WEBHOOK_ALLOWED_HOSTS = originalEnv.IMESSAGE_WEBHOOK_ALLOWED_HOSTS;

  if (tmpPath) {
    rmSync(tmpPath, { recursive: true, force: true });
    tmpPath = null;
  }
});

describe("webhook creation hardening", () => {
  it("rejects loopback/private targets by default", async () => {
    configureTempFiles();
    process.env.IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS = "false";

    await expect(withRequestContext(
      {
        principal: {
          auth_mode: "oauth2",
          subject: "alice",
          client_id: "client-a",
          scopes: ["webhooks.manage"],
          allowed_profiles: ["default"],
        },
        profile_id: "default",
        db_path: "/tmp/chat.db",
      },
      () => createWebhookSubscription({
        url: "http://127.0.0.1:8080/hook",
      }),
    )).rejects.toThrow(/private|loopback/i);
  });

  it("enforces allowed profile IDs at creation time", async () => {
    configureTempFiles();

    await expect(withRequestContext(
      {
        principal: {
          auth_mode: "oauth2",
          subject: "alice",
          client_id: "client-a",
          scopes: ["webhooks.manage"],
          allowed_profiles: ["default"],
        },
        profile_id: "default",
        db_path: "/tmp/chat.db",
      },
      () => createWebhookSubscription({
        url: "https://1.1.1.1/hook",
        profile_id: "work",
      }),
    )).rejects.toThrow(/not allowed/i);
  });

  it("rejects unsupported event types", async () => {
    configureTempFiles();
    process.env.IMESSAGE_WEBHOOK_ALLOW_PRIVATE_IPS = "true";

    await expect(withRequestContext(
      {
        principal: {
          auth_mode: "oauth2",
          subject: "alice",
          client_id: "client-a",
          scopes: ["webhooks.manage"],
          allowed_profiles: ["default"],
        },
        profile_id: "default",
        db_path: "/tmp/chat.db",
      },
      () => createWebhookSubscription({
        url: "https://1.1.1.1/hook",
        events: ["messages.deleted"],
      }),
    )).rejects.toThrow(/unsupported webhook event/i);
  });
});
