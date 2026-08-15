import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { decodeReference, encodeReference } from "../src/references.js";
import { successResult } from "../src/result.js";
import { loadApiToken } from "../src/transport.js";

const originalToken = process.env.IMESSAGE_API_TOKEN;
const originalFile = process.env.IMESSAGE_API_TOKEN_FILE;

afterEach(() => {
  if (originalToken === undefined) delete process.env.IMESSAGE_API_TOKEN;
  else process.env.IMESSAGE_API_TOKEN = originalToken;
  if (originalFile === undefined) delete process.env.IMESSAGE_API_TOKEN_FILE;
  else process.env.IMESSAGE_API_TOKEN_FILE = originalFile;
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
  it("never invokes legacy NSUnarchiver", () => {
    const helper = readFileSync(new URL("../native/message-text-decoder.js", import.meta.url), "utf8");
    expect(helper).not.toContain("NSUnarchiver");
    expect(helper).toContain("NSKeyedUnarchiver.unarchivedObjectOfClassesFromDataError");
  });

  it("pins every workflow action to an immutable commit", () => {
    for (const file of ["attest-canary.yml", "attest-security-evidence.yml", "ci.yml", "security.yml", "release.yml"]) {
      const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
      const uses = [...workflow.matchAll(/^\s*- uses:\s+[^\s@]+@([^\s#]+)/gmu)].map((match) => match[1]);
      expect(uses.length).toBeGreaterThan(0);
      expect(uses.every((revision) => /^[a-f0-9]{40}$/u.test(revision))).toBe(true);
    }
  });

  it("keeps publication downstream of protected, exact-revision evidence with split authority", () => {
    const attestation = readFileSync(new URL("../.github/workflows/attest-security-evidence.yml", import.meta.url), "utf8");
    expect(attestation).toContain("SECURITY_SCAN_ALLOWED_SIGNER");
    expect(attestation).toContain("verify-commit \"$GITHUB_SHA\"");
    expect(attestation).toContain("scripts/security-evidence.ts create");
    const canary = readFileSync(new URL("../.github/workflows/attest-canary.yml", import.meta.url), "utf8");
    expect(canary).toContain("environment: canary-attestation");
    expect(canary).toContain("fetch-depth: 0");
    expect(canary).toContain("scripts/canary-evidence.ts create");
    expect(canary).toContain("--workflow attest-security-evidence.yml");
    expect(canary).toContain("audit signatures");
    const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(release).toContain("needs: [verify-release, release-secret-scan, release-codeql]");
    expect(release).toContain("--signer-workflow anipotts/imessage-mcp/.github/workflows/attest-security-evidence.yml");
    expect(release).toContain("--source-digest \"$GITHUB_SHA\"");
    expect(release).toContain("--signer-workflow anipotts/imessage-mcp/.github/workflows/attest-canary.yml");
    expect(release).toContain("scripts/canary-evidence.ts verify");
    expect(release).toContain("candidate-attestations.json");
    expect(release).toContain("--ignore-scripts --access public --provenance");
    const verifyJob = release.slice(release.indexOf("  verify-release:"), release.indexOf("  release-secret-scan:"));
    expect(verifyJob).toContain("fetch-depth: 0");
    expect(verifyJob.indexOf("npm run test:performance")).toBeLessThan(verifyJob.indexOf("retrieve and verify protected security evidence"));
    expect(verifyJob.slice(verifyJob.indexOf("retrieve and verify protected security evidence")))
      .not.toMatch(/npm run (?:verify|test:performance)/u);
    const npmJob = release.slice(release.indexOf("  publish-npm:"), release.indexOf("  verify-public-npm:"));
    expect(npmJob).toContain("attestations: read");
    expect(npmJob.match(/gh attestation verify/gu)).toHaveLength(3);
    expect(npmJob.indexOf("gh attestation verify")).toBeLessThan(npmJob.indexOf("npm publish"));
    expect(npmJob.indexOf("attest-canary.yml")).toBeLessThan(npmJob.indexOf("--tag latest"));
    const registry = release.slice(release.indexOf("  publish-registry:"), release.indexOf("  publish-github-release:"));
    expect(registry).toContain("contents: read");
    expect(registry).toContain("id-token: write");
    expect(registry).not.toContain("contents: write");
    expect(registry).toContain("persist-credentials: false");
    const github = release.slice(release.indexOf("  publish-github-release:"));
    expect(github).toContain("contents: write");
    expect(github).not.toContain("id-token: write");
    expect(github).not.toContain("mcp-publisher");
  });

  it("binds security evidence to canonical scan files whose exact parent was scanned", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "imessage-security-evidence-"));
    const runGit = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    try {
      runGit("init", "--quiet");
      runGit("config", "core.hooksPath", "/dev/null");
      runGit("config", "user.name", "Fixture");
      runGit("config", "user.email", "fixture@example.test");
      runGit("config", "commit.gpgsign", "false");
      writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "2.0.0-beta.1" }));
      writeFileSync(path.join(directory, "package.tgz"), "synthetic package bytes");
      runGit("add", "package.json", "package.tgz");
      runGit("commit", "--quiet", "-m", "base");
      const scanned = runGit("rev-parse", "HEAD");
      const scanId = "11111111-1111-1111-1111-111111111111";
      const findings = `${JSON.stringify({
        documentType: "codex-security.findings",
        schemaVersion: "1.0",
        scanId,
        findings: [],
      }, null, 2)}\n`;
      const coverage = `${JSON.stringify({
        documentType: "codex-security.coverage",
        schemaVersion: "1.0",
        scanId,
        mode: "repository",
        completeness: "complete",
        inventoryStrategy: "repository",
        includePaths: ["."],
        excludePaths: [],
        surfaces: [{
          id: "surface_release",
          label: "Release provenance",
          disposition: "no_issue_found",
          receiptRefs: [],
        }],
        explicitExclusions: [],
        deferred: [],
        openQuestions: [],
      }, null, 2)}\n`;
      const hash = (value: string) => createHash("sha256").update(value).digest("hex");
      const manifest = `${JSON.stringify({
        documentType: "codex-security.scan-manifest",
        schemaVersion: "1.0",
        scan: {
          id: scanId,
          producer: { name: "codex-security-plugin", version: "0.1.18" },
          status: "completed",
          startedAt: "2026-08-11T00:00:00.000Z",
          completedAt: "2026-08-11T00:01:00.000Z",
          sealedAt: "2026-08-11T00:01:00.000Z",
          target: {
            kind: "git_revision",
            targetId: `target_sha256_${"a".repeat(64)}`,
            displayName: "imessage-mcp",
            revision: scanned,
          },
          scope: { includePaths: ["."], excludePaths: [] },
          coverageRef: "coverage.json",
          findingsRef: "findings.json",
          artifacts: [
            { path: "findings.json", sha256: hash(findings), mediaType: "application/json" },
            { path: "coverage.json", sha256: hash(coverage), mediaType: "application/json" },
          ],
        },
      }, null, 2)}\n`;
      const scanDirectory = path.join(directory, "security", "scan");
      mkdirSync(scanDirectory, { recursive: true });
      writeFileSync(path.join(scanDirectory, "findings.json"), findings);
      writeFileSync(path.join(scanDirectory, "coverage.json"), coverage);
      writeFileSync(path.join(scanDirectory, "scan-manifest.json"), manifest);
      runGit("add", "security/scan/coverage.json", "security/scan/findings.json", "security/scan/scan-manifest.json");
      runGit("commit", "--quiet", "-m", "chore: attach sealed security scan");
      const evidenceCommit = runGit("rev-parse", "HEAD");
      const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
      const script = fileURLToPath(new URL("../scripts/security-evidence.ts", import.meta.url));
      execFileSync(tsx, [script, "create", "package.tgz", evidenceCommit, "evidence.json"], {
        cwd: directory,
        stdio: "ignore",
      });
      const evidence = JSON.parse(readFileSync(path.join(directory, "evidence.json"), "utf8")) as {
        schema_version: number;
        subject: { commit: string; scanned_commit: string };
        security_scan: { scan_revision: string; finding_count: number; coverage: string };
      };
      expect(evidence.schema_version).toBe(3);
      expect(evidence.subject.commit).toBe(evidenceCommit);
      expect(evidence.subject.scanned_commit).toBe(scanned);
      expect(evidence.security_scan).toMatchObject({ scan_revision: scanned, finding_count: 0, coverage: "complete" });

      runGit("commit", "--allow-empty", "--quiet", "-m", "unscanned child");
      const unscanned = runGit("rev-parse", "HEAD");
      expect(() => execFileSync(tsx, [script, "create", "package.tgz", unscanned, "invalid.json"], {
        cwd: directory,
        stdio: "ignore",
      })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds stable promotion to the public rc package and metadata-only direct derivation", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "imessage-canary-evidence-"));
    const runGit = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    const releaseFiles = [
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "README.md",
      "VERIFICATION.md",
      "npm-shrinkwrap.json",
      "package.json",
      "release-status.json",
      "server.json",
    ];
    const writeVersionFiles = (root: string, version: string, status: Record<string, unknown>) => {
      for (const file of releaseFiles) {
        const target = path.join(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        const value = file === "package.json"
          ? { name: "imessage-mcp", version }
          : file === "release-status.json"
            ? status
            : file.endsWith(".json")
              ? { version, marker: file }
              : `${file} for ${version}\n`;
        writeFileSync(target, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
      }
    };
    const buildPackage = (source: string, destination: string, runtime = "identical runtime\n") => {
      const root = path.join(directory, `package-${path.basename(destination)}`);
      for (const file of releaseFiles) {
        const target = path.join(root, "package", file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(path.join(source, file)));
      }
      mkdirSync(path.join(root, "package", "dist"), { recursive: true });
      writeFileSync(path.join(root, "package", "dist", "index.js"), runtime);
      execFileSync("tar", ["-czf", destination, "-C", root, "package"]);
    };
    try {
      runGit("init", "--quiet");
      runGit("config", "core.hooksPath", "/dev/null");
      runGit("config", "user.name", "Fixture");
      runGit("config", "user.email", "fixture@example.test");
      runGit("config", "commit.gpgsign", "false");
      writeVersionFiles(directory, "2.0.0-rc.1", { schema_version: 4, subject_version: "2.0.0-rc.1" });
      mkdirSync(path.join(directory, "dist"), { recursive: true });
      writeFileSync(path.join(directory, "dist", "index.js"), "identical runtime\n");
      runGit("add", ...releaseFiles, "dist/index.js");
      runGit("commit", "--quiet", "-m", "release candidate source");
      const scanDirectory = path.join(directory, "security", "scan");
      mkdirSync(scanDirectory, { recursive: true });
      for (const file of ["coverage.json", "findings.json", "scan-manifest.json"]) {
        writeFileSync(path.join(scanDirectory, file), `${JSON.stringify({ candidate: file })}\n`);
      }
      runGit("add", "security/scan/coverage.json", "security/scan/findings.json", "security/scan/scan-manifest.json");
      runGit("commit", "--quiet", "-m", "candidate evidence");
      const candidateCommit = runGit("rev-parse", "HEAD");
      runGit("tag", "v2.0.0-rc.1", candidateCommit);
      const candidatePackage = path.join(directory, "candidate.tgz");
      buildPackage(directory, candidatePackage);
      const candidateDigest = createHash("sha256").update(readFileSync(candidatePackage)).digest("hex");
      const started = "2026-08-01T00:00:00.000Z";
      const completed = "2026-08-08T00:00:00.000Z";
      const exercises = Object.fromEntries([
        "all_privacy_modes", "all_service_families", "all_seven_tools", "claude_code",
        "claude_desktop", "codex", "copied_database", "cursor", "http_proxy_simulation",
        "live_database", "stdio",
      ].map((key) => [key, true]));
      const stableStatus = {
        schema_version: 4,
        subject_version: "2.0.0",
        stable: {
          ready: true,
          subject_version: "2.0.0",
          release_candidate: "2.0.0-rc.1",
          candidate_commit: candidateCommit,
          candidate_package_sha256: candidateDigest,
          canary_started_at: started,
          canary_completed_at: completed,
          exercises,
        },
      };
      writeVersionFiles(directory, "2.0.0", stableStatus);
      runGit("add", ...releaseFiles);
      runGit("commit", "--quiet", "-m", "stable metadata derivation");
      const stableSource = runGit("rev-parse", "HEAD");
      expect(runGit("rev-parse", `${stableSource}^`)).toBe(candidateCommit);
      for (const file of ["coverage.json", "findings.json", "scan-manifest.json"]) {
        writeFileSync(path.join(scanDirectory, file), `${JSON.stringify({ stable: file })}\n`);
      }
      runGit("add", "security/scan/coverage.json", "security/scan/findings.json", "security/scan/scan-manifest.json");
      runGit("commit", "--quiet", "-m", "stable evidence");
      const stableCommit = runGit("rev-parse", "HEAD");
      const stablePackage = path.join(directory, "stable.tgz");
      buildPackage(directory, stablePackage);
      const metadata = path.join(directory, "candidate-npm.json");
      const attestationUrl = "https://registry.npmjs.org/-/npm/v1/attestations/imessage-mcp@2.0.0-rc.1";
      writeFileSync(metadata, `${JSON.stringify({
        version: "2.0.0-rc.1",
        dist: {
          tarball: "https://registry.npmjs.org/imessage-mcp/-/imessage-mcp-2.0.0-rc.1.tgz",
          attestations: {
            url: attestationUrl,
            provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          },
        },
        time: { "2.0.0-rc.1": started },
      }, null, 2)}\n`);
      const releaseRunId = 123456789;
      const provenance = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{
          name: "pkg:npm/imessage-mcp@2.0.0-rc.1",
          digest: { sha512: createHash("sha512").update(readFileSync(candidatePackage)).digest("hex") },
        }],
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: {
          buildDefinition: {
            buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
            externalParameters: { workflow: {
              ref: "refs/tags/v2.0.0-rc.1",
              repository: "https://github.com/anipotts/imessage-mcp",
              path: ".github/workflows/release.yml",
            } },
            internalParameters: { github: { event_name: "push" } },
            resolvedDependencies: [{
              uri: "git+https://github.com/anipotts/imessage-mcp@refs/tags/v2.0.0-rc.1",
              digest: { gitCommit: candidateCommit },
            }],
          },
          runDetails: {
            builder: { id: "https://github.com/actions/runner/github-hosted" },
            metadata: {
              invocationId: `https://github.com/anipotts/imessage-mcp/actions/runs/${releaseRunId}/attempts/1`,
            },
          },
        },
      };
      const attestations = path.join(directory, "candidate-attestations.json");
      writeFileSync(attestations, `${JSON.stringify({
        attestations: [{
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(provenance)).toString("base64") } },
        }],
      }, null, 2)}\n`);
      const releaseRun = path.join(directory, "candidate-release-run.json");
      writeFileSync(releaseRun, `${JSON.stringify({
        conclusion: "success",
        databaseId: releaseRunId,
        event: "push",
        headBranch: "v2.0.0-rc.1",
        headSha: candidateCommit,
        url: `https://github.com/anipotts/imessage-mcp/actions/runs/${releaseRunId}`,
        workflowName: "release 2.x",
      }, null, 2)}\n`);
      const evidence = path.join(directory, "canary-evidence.json");
      const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
      const script = fileURLToPath(new URL("../scripts/canary-evidence.ts", import.meta.url));
      execFileSync(tsx, [
        script, "create", stablePackage, stableCommit, candidatePackage, metadata, attestations, releaseRun, evidence,
      ], {
        cwd: directory,
        stdio: "ignore",
      });
      execFileSync(tsx, [
        script, "verify", stablePackage, stableCommit, candidatePackage, metadata, attestations, releaseRun, evidence,
      ], {
        cwd: directory,
        stdio: "ignore",
      });
      const value = JSON.parse(readFileSync(evidence, "utf8")) as {
        subject: { stable_source_commit: string };
        release_candidate: { commit: string };
        canary: { elapsed_seconds: number };
        stable_derivation: { changed_files: string[]; other_package_files_identical: boolean };
      };
      expect(value.subject.stable_source_commit).toBe(stableSource);
      expect(value.release_candidate.commit).toBe(candidateCommit);
      expect(value.canary.elapsed_seconds).toBe(604_800);
      expect(value.stable_derivation.changed_files).toEqual([...releaseFiles].sort());
      expect(value.stable_derivation.other_package_files_identical).toBe(true);

      const tamperedPackage = path.join(directory, "tampered.tgz");
      buildPackage(directory, tamperedPackage, "changed runtime\n");
      expect(() => execFileSync(
        tsx,
        [
          script, "create", tamperedPackage, stableCommit, candidatePackage, metadata, attestations, releaseRun,
          path.join(directory, "invalid.json"),
        ],
        { cwd: directory, stdio: "ignore" },
      )).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
