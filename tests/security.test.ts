import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeReference, encodeReference } from "../src/references.js";
import { successResult } from "../src/result.js";
import { loadDatabaseId } from "../src/secrets.js";
import { loadApiToken } from "../src/transport.js";

const originalToken = process.env.IMESSAGE_API_TOKEN;
const originalFile = process.env.IMESSAGE_API_TOKEN_FILE;
const originalDatabaseId = process.env.IMESSAGE_DATABASE_ID;
const originalDatabaseIdFile = process.env.IMESSAGE_DATABASE_ID_FILE;

afterEach(() => {
  if (originalToken === undefined) delete process.env.IMESSAGE_API_TOKEN;
  else process.env.IMESSAGE_API_TOKEN = originalToken;
  if (originalFile === undefined) delete process.env.IMESSAGE_API_TOKEN_FILE;
  else process.env.IMESSAGE_API_TOKEN_FILE = originalFile;
  if (originalDatabaseId === undefined) delete process.env.IMESSAGE_DATABASE_ID;
  else process.env.IMESSAGE_DATABASE_ID = originalDatabaseId;
  if (originalDatabaseIdFile === undefined) delete process.env.IMESSAGE_DATABASE_ID_FILE;
  else process.env.IMESSAGE_DATABASE_ID_FILE = originalDatabaseIdFile;
});

describe("database lineage identity boundary", () => {
  it("requires a distinct, bounded operator-controlled identity source", () => {
    delete process.env.IMESSAGE_DATABASE_ID;
    delete process.env.IMESSAGE_DATABASE_ID_FILE;
    expect(() => loadDatabaseId()).toThrow(/requires/u);
    process.env.IMESSAGE_DATABASE_ID = "short";
    expect(() => loadDatabaseId()).toThrow(/32/u);
    process.env.IMESSAGE_DATABASE_ID_FILE = "/tmp/also-set";
    expect(() => loadDatabaseId()).toThrow(/only one/u);
  });
});

describe("HTTP token boundary", () => {
  it("rejects missing, short, and conflicting token sources", () => {
    delete process.env.IMESSAGE_API_TOKEN;
    delete process.env.IMESSAGE_API_TOKEN_FILE;
    expect(() => loadApiToken()).toThrow(/requires/u);
    process.env.IMESSAGE_API_TOKEN = "short";
    expect(() => loadApiToken()).toThrow(/32/u);
    process.env.IMESSAGE_API_TOKEN_FILE = "/tmp/also-set";
    expect(() => loadApiToken()).toThrow(/only one/u);
  });

  it("rejects an oversized direct token before transport startup", () => {
    delete process.env.IMESSAGE_API_TOKEN_FILE;
    process.env.IMESSAGE_API_TOKEN = "x".repeat(4097);
    expect(() => loadApiToken()).toThrow(/4096/u);
  });

  it("requires an operator-owned 0600 regular token file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "imessage-token-test-"));
    const file = path.join(directory, "token");
    try {
      writeFileSync(file, "a".repeat(32));
      chmodSync(file, 0o644);
      delete process.env.IMESSAGE_API_TOKEN;
      process.env.IMESSAGE_API_TOKEN_FILE = file;
      expect(() => loadApiToken()).toThrow(/0600/u);
      chmodSync(file, 0o600);
      expect(loadApiToken()).toHaveLength(32);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects symlinked and oversized token files", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "imessage-token-boundary-"));
    const target = path.join(directory, "target");
    const link = path.join(directory, "link");
    try {
      writeFileSync(target, "a".repeat(32));
      chmodSync(target, 0o600);
      symlinkSync(target, link);
      delete process.env.IMESSAGE_API_TOKEN;
      process.env.IMESSAGE_API_TOKEN_FILE = link;
      expect(() => loadApiToken()).toThrow(/opened safely/u);
      writeFileSync(target, "a".repeat(4097));
      process.env.IMESSAGE_API_TOKEN_FILE = target;
      expect(() => loadApiToken()).toThrow(/regular file/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("opaque references", () => {
  it("survives restarts and rejects tampering or unrelated database lineages", () => {
    const key = Buffer.alloc(32, 0x5a);
    const otherKey = Buffer.alloc(32, 0x6b);
    const reference = encodeReference(key, "lineage-a", "conversation", { chat_ids: [1, 2] });
    expect(decodeReference(key, "lineage-a", "conversation", reference).value).toEqual({ chat_ids: [1, 2] });
    expect(() => decodeReference(key, "lineage-b", "conversation", reference)).toThrow(/lineage/u);
    expect(() => decodeReference(otherKey, "lineage-a", "conversation", reference)).toThrow(/lineage/u);
    const tamperIndex = 40;
    const tampered = reference.slice(0, tamperIndex) +
      (reference[tamperIndex] === "A" ? "B" : "A") + reference.slice(tamperIndex + 1);
    expect(() => decodeReference(key, "lineage-a", "conversation", tampered)).toThrow(/lineage/u);
    expect(() => decodeReference(key, "lineage-a", "conversation", "not-a-reference"))
      .toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));
    expect(() => decodeReference(key, "lineage-a", "message", reference))
      .toThrowError(expect.objectContaining({ reason: "INVALID_INPUT" }));
  });
});

describe("bounded results", () => {
  it("rejects an MCP result before either transport can exceed four MiB", () => {
    expect(() => successResult({
      tool: "server_status",
      privacy: "full",
      maskingKey: Buffer.alloc(32, 1),
      effectiveScope: { privacy_mode: "full" },
      data: { oversized: "x".repeat(4 * 1024 * 1024) },
    })).toThrowError(expect.objectContaining({ reason: "QUERY_BUDGET_EXCEEDED" }));
  });
});

describe("native and release hardening", () => {
  it("keeps the native decoder's body bound equal to the TypeScript bound", async () => {
    const { readFileSync } = await import("node:fs");
    const { MAX_ATTRIBUTED_BODY_BYTES } = await import("../src/limits.js");
    const native = readFileSync(new URL("../native/message-text-decoder.js", import.meta.url), "utf8");
    const match = /const MAX_BLOB_BYTES = (\d+) \* 1024 \* 1024;/u.exec(native);
    expect(match).not.toBeNull();
    expect(Number(match![1]) * 1024 * 1024).toBe(MAX_ATTRIBUTED_BODY_BYTES);
  });

  it("never invokes legacy NSUnarchiver", () => {
    const helper = readFileSync(new URL("../native/message-text-decoder.js", import.meta.url), "utf8");
    expect(helper).not.toContain("NSUnarchiver");
    expect(helper).toContain("NSKeyedUnarchiver.unarchivedObjectOfClassesFromDataError");
  });

  it("pins every workflow action to an immutable commit", () => {
    for (const file of ["ci.yml", "security.yml", "release.yml"]) {
      const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
      const uses = [...workflow.matchAll(/^\s*- uses:\s+[^\s@]+@([^\s#]+)/gmu)].map((match) => match[1]);
      expect(uses.length).toBeGreaterThan(0);
      expect(uses.every((revision) => /^[a-f0-9]{40}$/u.test(revision))).toBe(true);
    }
  });

  it("pins the desktop bundle packer to one version and one digest", () => {
    const script = readFileSync(new URL("../scripts/build-mcpb.mjs", import.meta.url), "utf8");
    expect(script).not.toContain("npx");
    expect(script).toMatch(/const PACKER_VERSION = "\d+\.\d+\.\d+";/u);
    expect(script).toMatch(/const PACKER_SHA256 = "[a-f0-9]{64}";/u);
    expect(script).toContain("does not match the pinned");
  });

  it("publishes only from a verified version tag, with split downstream authority", () => {
    const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(release).toContain("\n  push:\n    tags:\n      - \"v[0-9]*\"\n");
    expect(release).not.toContain("workflow_dispatch");
    expect(release).not.toContain("gh attestation verify");
    expect(release).not.toContain("security-evidence");
    expect(release).not.toContain("SECURITY_SCAN_ALLOWED_SIGNER");
    expect(release).not.toContain("resume-");
    expect(release).toContain("needs: [verify, secret-scan, codeql]");
    expect(release).toContain("upload: never");
    expect(release).toContain("--ignore-scripts --access public --provenance");

    const verify = release.slice(release.indexOf("  verify:"), release.indexOf("  secret-scan:"));
    expect(verify).toContain("fetch-depth: 0");
    expect(verify).toContain("persist-credentials: false");
    expect(verify).toContain('test "v${VERSION}" = "${GITHUB_REF_NAME}"');
    expect(verify).toContain('git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main');
    expect(verify.indexOf("npm run verify")).toBeLessThan(verify.indexOf("npm run test:performance"));
    expect(verify.indexOf("npm run test:performance")).toBeLessThan(verify.indexOf("npm pack"));
    expect(verify).toContain("build:mcpb");
    expect(verify).toContain("name: release-${{ steps.version.outputs.version }}");

    const npmJob = release.slice(release.indexOf("  publish-npm:"), release.indexOf("  verify-public-npm:"));
    expect(npmJob).toContain("environment: npm-release");
    expect(npmJob).toContain("id-token: write");
    expect(npmJob).not.toContain("contents: write");
    expect(npmJob).toContain("name: release-${{ needs.verify.outputs.version }}");
    expect(npmJob).toContain('TARBALL="./release-artifact/${{ needs.verify.outputs.tarball }}"');
    expect(npmJob).toContain('test -f "$TARBALL"');
    expect(npmJob).toContain("--tag next");
    expect(npmJob).toContain("--tag latest");

    const publicNpm = release.slice(release.indexOf("  verify-public-npm:"), release.indexOf("  publish-registry:"));
    expect(publicNpm).toContain("--omit=dev");
    expect(publicNpm).toContain("cmp ");

    const registry = release.slice(release.indexOf("  publish-registry:"), release.indexOf("  publish-github-release:"));
    expect(registry).toContain("environment: mcp-registry-release");
    expect(registry).toContain("contents: read");
    expect(registry).toContain("id-token: write");
    expect(registry).not.toContain("contents: write");
    expect(registry).toContain("persist-credentials: false");

    const github = release.slice(release.indexOf("  publish-github-release:"));
    expect(github).toContain("environment: github-release");
    expect(github).toContain("contents: write");
    expect(github).not.toContain("id-token: write");
    expect(github).not.toContain("mcp-publisher");
    expect(github).toContain("draft: true");
    expect(github).toContain("generate_release_notes: true");
    expect(github).toContain("files: release-artifact/*");
    expect(github).toContain('gh release edit "v${VERSION}"');
    expect(github).toContain("!release.immutable");
    expect(github).toContain("gh release verify-asset");
  });
});
