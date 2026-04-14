import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const sourceDir = path.resolve("src/data");
const targetDir = path.resolve("dist/src/data");

await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });
