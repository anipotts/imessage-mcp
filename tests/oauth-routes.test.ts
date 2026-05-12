import { describe, it, expect, afterEach } from "vitest";
import { maybeHandleOAuthRequest } from "../src/auth.js";

const originalMode = process.env.IMESSAGE_AUTH_MODE;
const originalIssuer = process.env.IMESSAGE_OAUTH_ISSUER;
const originalBearerTokens = process.env.IMESSAGE_BEARER_TOKENS;
const originalApiToken = process.env.IMESSAGE_API_TOKEN;

afterEach(() => {
  if (originalMode === undefined) delete process.env.IMESSAGE_AUTH_MODE;
  else process.env.IMESSAGE_AUTH_MODE = originalMode;

  if (originalIssuer === undefined) delete process.env.IMESSAGE_OAUTH_ISSUER;
  else process.env.IMESSAGE_OAUTH_ISSUER = originalIssuer;

  if (originalBearerTokens === undefined) delete process.env.IMESSAGE_BEARER_TOKENS;
  else process.env.IMESSAGE_BEARER_TOKENS = originalBearerTokens;

  if (originalApiToken === undefined) delete process.env.IMESSAGE_API_TOKEN;
  else process.env.IMESSAGE_API_TOKEN = originalApiToken;
});

function mockReq(method: string, headers: Record<string, string> = {}) {
  return {
    method,
    headers,
    on: () => {},
    destroy: () => {},
  } as any;
}

function mockRes() {
  const state: { status?: number; headers?: Record<string, string>; body?: string } = {};
  return {
    state,
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status;
      state.headers = headers;
    },
    end(body?: string) {
      state.body = body;
    },
  } as any;
}

describe("maybeHandleOAuthRequest()", () => {
  it("serves OAuth metadata in oauth2 mode", async () => {
    process.env.IMESSAGE_AUTH_MODE = "oauth2";
    process.env.IMESSAGE_OAUTH_ISSUER = "http://example.test";

    const req = mockReq("GET", { host: "example.test" });
    const res = mockRes();
    const handled = await maybeHandleOAuthRequest(
      req,
      res,
      new URL("http://example.test/.well-known/oauth-authorization-server"),
      "example.test",
    );

    expect(handled).toBe(true);
    expect(res.state.status).toBe(200);
    const payload = JSON.parse(res.state.body || "{}");
    expect(payload.issuer).toBe("http://example.test");
    expect(payload.token_endpoint).toContain("/oauth/token");
  });

  it("does not intercept in bearer mode", async () => {
    process.env.IMESSAGE_AUTH_MODE = "bearer";

    const req = mockReq("GET", { host: "example.test" });
    const res = mockRes();
    const handled = await maybeHandleOAuthRequest(
      req,
      res,
      new URL("http://example.test/.well-known/oauth-authorization-server"),
      "example.test",
    );

    expect(handled).toBe(false);
  });

  it("rejects unauthenticated register endpoint access", async () => {
    process.env.IMESSAGE_AUTH_MODE = "oauth2";
    process.env.IMESSAGE_OAUTH_ISSUER = "http://example.test";
    delete process.env.IMESSAGE_BEARER_TOKENS;
    delete process.env.IMESSAGE_API_TOKEN;

    const req = mockReq("POST", { host: "example.test" });
    const res = mockRes();
    const handled = await maybeHandleOAuthRequest(
      req,
      res,
      new URL("http://example.test/oauth/register"),
      "example.test",
    );

    expect(handled).toBe(true);
    expect(res.state.status).toBe(401);
  });

  it("rejects unauthenticated authorize endpoint access", async () => {
    process.env.IMESSAGE_AUTH_MODE = "oauth2";
    process.env.IMESSAGE_OAUTH_ISSUER = "http://example.test";
    delete process.env.IMESSAGE_BEARER_TOKENS;
    delete process.env.IMESSAGE_API_TOKEN;

    const req = mockReq("GET", { host: "example.test" });
    const res = mockRes();
    const handled = await maybeHandleOAuthRequest(
      req,
      res,
      new URL("http://example.test/oauth/authorize?response_type=code"),
      "example.test",
    );

    expect(handled).toBe(true);
    expect(res.state.status).toBe(401);
  });
});
