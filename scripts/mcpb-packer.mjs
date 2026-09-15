// Installs @anthropic-ai/mcpb by exact version and refuses to run it unless the
// tarball is the reviewed one. The packer writes and signs the artifact users
// double-click, so it is pinned like every other external component in the
// release path. To move it, run `npm pack @anthropic-ai/mcpb@<version>` and
// paste the tarball's sha256.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const PACKER_VERSION = "2.1.2";
const PACKER_SHA256 = "81174993380eb930bcacecc890b1acfdb06cf336366e445404aea36467417cc1";

export function installPinnedPacker(directory, cwd) {
  mkdirSync(directory, { recursive: true });
  const tarball = path.join(directory, `anthropic-ai-mcpb-${PACKER_VERSION}.tgz`);
  execFileSync("npm", ["pack", `@anthropic-ai/mcpb@${PACKER_VERSION}`, "--silent", "--pack-destination", directory], { cwd, stdio: "inherit" });
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (digest !== PACKER_SHA256) {
    throw new Error(`@anthropic-ai/mcpb@${PACKER_VERSION} sha256 ${digest} does not match the pinned ${PACKER_SHA256}`);
  }
  execFileSync("npm", ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", directory, tarball], { cwd, stdio: "inherit" });
  return path.join(directory, "node_modules", ".bin", "mcpb");
}
