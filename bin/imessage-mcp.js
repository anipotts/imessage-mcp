#!/usr/bin/env node

const cmd = process.argv[2];

if (cmd === "doctor") {
  await import("../dist/commands/doctor.js");
} else if (cmd === "dump") {
  await import("../dist/commands/dump.js");
} else {
  await import("../dist/index.js");
}
