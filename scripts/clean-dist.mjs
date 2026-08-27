import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = path.resolve(fileURLToPath(new URL("../dist", import.meta.url)));
if (path.dirname(target) !== repository || path.basename(target) !== "dist") {
  throw new Error("refusing to clean an unexpected build directory");
}
rmSync(target, { recursive: true, force: true });
