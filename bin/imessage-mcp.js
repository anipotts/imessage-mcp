#!/usr/bin/env node
// The node:sqlite runtime floor is checked before importing the server.
// Optional checkpoint APIs are feature-detected separately across Node majors.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 16)) {
  process.stderr.write(`imessage-mcp needs Node 24.16 or newer (this is ${process.versions.node}). Install a current Node from nodejs.org, or use the Claude Desktop extension, which brings its own.\n`);
  process.exit(1);
}
await import("../dist/cli.js");
