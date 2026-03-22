import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(THIS_DIR, "..");
const DIST_ROOT = path.resolve(THIS_DIR, "..", "..");
const PACKAGE_ROOT = existsSync(path.join(SOURCE_ROOT, "package.json")) ? SOURCE_ROOT : DIST_ROOT;

export function getPackageRoot(): string {
  return PACKAGE_ROOT;
}

export function resolvePackagePath(...parts: string[]): string {
  return path.join(PACKAGE_ROOT, ...parts);
}
