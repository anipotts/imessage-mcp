import { describe, it, expect, afterEach } from "vitest";
import { authenticateBootstrapAdmin, authenticateRequest } from "../src/auth.js";

const originalEnv = {
  IMESSAGE_AUTH_MODE: process.env.IMESSAGE_AUTH_MODE,
  IMESSAGE_API_TOKEN: process.env.IMESSAGE_API_TOKEN,
  IMESSAGE_BEARER_TOKENS: process.env.IMESSAGE_BEARER_TOKENS,
  IMESSAGE_BEARER_SCOPES: process.env.IMESSAGE_BEARER_SCOPES,
  IMESSAGE_REQUIRE_AUTH: process.env.IMESSAGE_REQUIRE_AUTH,
};

afterEach(() => {
  if (originalEnv.IMESSAGE_AUTH_MODE === undefined) delete process.env.IMESSAGE_AUTH_MODE;
  else process.env.IMESSAGE_AUTH_MODE = originalEnv.IMESSAGE_AUTH_MODE;

  if (originalEnv.IMESSAGE_API_TOKEN === undefined) delete process.env.IMESSAGE_API_TOKEN;
  else process.env.IMESSAGE_API_TOKEN = originalEnv.IMESSAGE_API_TOKEN;

  if (originalEnv.IMESSAGE_BEARER_TOKENS === undefined) delete process.env.IMESSAGE_BEARER_TOKENS;
  else process.env.IMESSAGE_BEARER_TOKENS = originalEnv.IMESSAGE_BEARER_TOKENS;

  if (originalEnv.IMESSAGE_BEARER_SCOPES === undefined) delete process.env.IMESSAGE_BEARER_SCOPES;
  else process.env.IMESSAGE_BEARER_SCOPES = originalEnv.IMESSAGE_BEARER_SCOPES;

  if (originalEnv.IMESSAGE_REQUIRE_AUTH === undefined) delete process.env.IMESSAGE_REQUIRE_AUTH;
  else process.env.IMESSAGE_REQUIRE_AUTH = originalEnv.IMESSAGE_REQUIRE_AUTH;
});

describe("authenticateRequest() bearer mode", () => {
  it("requires auth by default when no bearer credential is configured", async () => {
    process.env.IMESSAGE_AUTH_MODE = "bearer";
    delete process.env.IMESSAGE_API_TOKEN;
    delete process.env.IMESSAGE_BEARER_TOKENS;
    delete process.env.IMESSAGE_REQUIRE_AUTH;

    const result = await authenticateRequest({});
    expect(result.ok).toBe(false);
  });

  it("supports explicit compatibility mode with IMESSAGE_REQUIRE_AUTH=false", async () => {
    process.env.IMESSAGE_AUTH_MODE = "bearer";
    delete process.env.IMESSAGE_API_TOKEN;
    delete process.env.IMESSAGE_BEARER_TOKENS;
    process.env.IMESSAGE_REQUIRE_AUTH = "false";

    const result = await authenticateRequest({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.subject).toBe("anonymous");
    expect(result.principal.scopes).toContain("*");
  });

  it("validates configured static bearer token", async () => {
    process.env.IMESSAGE_AUTH_MODE = "bearer";
    process.env.IMESSAGE_API_TOKEN = "top-secret-token";
    delete process.env.IMESSAGE_BEARER_TOKENS;

    const denied = await authenticateRequest({});
    expect(denied.ok).toBe(false);

    const allowed = await authenticateRequest({
      authorization: "Bearer top-secret-token",
    });
    expect(allowed.ok).toBe(true);
  });
});

describe("authenticateBootstrapAdmin()", () => {
  it("requires a static bearer token", () => {
    delete process.env.IMESSAGE_BEARER_TOKENS;
    delete process.env.IMESSAGE_API_TOKEN;
    const result = authenticateBootstrapAdmin({});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("requires bootstrap admin scopes", () => {
    process.env.IMESSAGE_BEARER_TOKENS = JSON.stringify([
      {
        token: "scoped-token",
        subject: "owner",
        client_id: "owner-client",
        scopes: ["messages.read"],
        profiles: ["default"],
      },
    ]);

    const result = authenticateBootstrapAdmin({
      authorization: "Bearer scoped-token",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });
});
