import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

interface PackageManifest {
  schema_version: 2;
  subject_version: string;
  channel: "next" | "latest";
  expected_paths: string[];
}

interface AssetManifest {
  schema_version: 2;
  subject_version: string;
  channel: "next" | "latest";
  assets: Array<{ path: string; sha256: string; width: number; height: number }>;
}

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  assert.ok(bytes.length >= 24, `${path} is not a complete PNG`);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${path} has an invalid PNG signature`);
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR", `${path} has no leading IHDR chunk`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function assertPackedPackage(actualPaths: string[]): void {
  const manifest = json<PackageManifest>("package-files.json");
  const version = json<{ version: string }>("package.json").version;
  const channel = version.includes("-") ? "next" : "latest";
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.subject_version, version);
  assert.equal(manifest.channel, channel);
  assert.equal(new Set(manifest.expected_paths).size, manifest.expected_paths.length, "package manifest contains duplicates");
  assert.deepEqual([...actualPaths].sort(), [...manifest.expected_paths].sort(), "npm tarball paths differ from the exact reviewed manifest");

  const assets = json<AssetManifest>("assets/manifest.json");
  assert.equal(assets.schema_version, 2);
  assert.equal(assets.subject_version, version);
  assert.equal(assets.channel, channel);
  const assetPaths = actualPaths.filter((value) => value.startsWith("assets/") && value !== "assets/manifest.json").sort();
  assert.deepEqual(assetPaths, assets.assets.map((asset) => asset.path).sort(), "packed assets differ from the synthetic asset manifest");
  for (const asset of assets.assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(sha256(asset.path), asset.sha256, `${asset.path} differs from its reviewed synthetic hash`);
    assert.deepEqual(pngDimensions(asset.path), { width: asset.width, height: asset.height });
  }
}
