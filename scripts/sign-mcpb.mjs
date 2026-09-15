#!/usr/bin/env node

// Signs dist-mcpb/imessage-mcp.mcpb so Claude Desktop shows a verified publisher.
// Claude Desktop trusts a signature only when its certificate chain passes the
// operating system's code-signing policy (`security verify-cert -p codeSign` on
// macOS), so a self-signed certificate still installs as unsigned. An Apple
// Developer ID Application certificate with its intermediate satisfies it.
//
// MCPB_SIGNING_CERT_FILE and MCPB_SIGNING_KEY_FILE name PEM files, and
// MCPB_SIGNING_INTERMEDIATE_FILE optionally names the chain. With neither set
// the bundle stays unsigned; with only one set, or when verification does not
// report a trusted signature, this exits non-zero.

import { execFileSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installPinnedPacker } from "./mcpb-packer.mjs";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = path.join(repository, "dist-mcpb", "imessage-mcp.mcpb");
const signer = path.join(repository, "dist-mcpb", "signer");
const cert = process.env.MCPB_SIGNING_CERT_FILE;
const key = process.env.MCPB_SIGNING_KEY_FILE;
const intermediate = process.env.MCPB_SIGNING_INTERMEDIATE_FILE;

statSync(bundle);
if (!cert && !key) {
  process.stdout.write("bundle signing: no certificate configured, bundle stays unsigned\n");
  process.exit(0);
}
if (!cert || !key) throw new Error("bundle signing needs both MCPB_SIGNING_CERT_FILE and MCPB_SIGNING_KEY_FILE");

try {
  const mcpb = installPinnedPacker(signer, repository);
  execFileSync(mcpb, ["sign", "--cert", cert, "--key", key, ...(intermediate ? ["--intermediate", intermediate] : []), bundle], {
    cwd: repository,
    stdio: ["ignore", "ignore", "inherit"],
  });
  let report = "";
  try {
    report = execFileSync(mcpb, ["verify", bundle], { cwd: repository, encoding: "utf8" });
  } catch (error) {
    report = String(error.stdout ?? "");
  }
  // Only the status and publisher are printed; certificate details stay out of logs.
  if (!/^Signature is valid$/mu.test(report)) {
    throw new Error("the signed bundle does not verify as trusted; a self-signed or untrusted certificate installs as unsigned");
  }
  const publisher = /^Signed by: (.+)$/mu.exec(report)?.[1] ?? "unknown";
  process.stdout.write(`bundle signing: signed and trusted, publisher ${publisher}\n`);
} finally {
  rmSync(signer, { recursive: true, force: true });
}
