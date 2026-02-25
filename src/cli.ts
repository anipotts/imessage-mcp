#!/usr/bin/env node
// CLI entry point — routes subcommands to their handlers

const cmd = process.argv[2];

if (cmd === "doctor") {
  await import("./commands/doctor.js");
} else if (cmd === "dump") {
  await import("./commands/dump.js");
} else {
  await import("./index.js");
}
