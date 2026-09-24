import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MAX_REPORT_BYTES, ReportError } from "./model.js";
import type { Provenance } from "./model.js";

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function privateDirectory(base: string, target: string): Promise<void> {
  if (!inside(base, target)) throw new ReportError("unsafe_path", "Storage path escapes the session workspace.");
  const parts = relative(base, target).split(sep).filter(Boolean);
  let current = base;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ReportError("unsafe_path", "Session evidence directories must not be symlinks or files.");
    }
  }
}

export async function readEvidence(path: string, roots: string[], maxBytes = MAX_REPORT_BYTES): Promise<{ text: string; bytes: Buffer; source: Provenance }> {
  if (!isAbsolute(path)) throw new ReportError("unsafe_path", "Evidence path must resolve to an absolute path.");
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new ReportError("missing_report", "Report file is missing; the command may have failed before writing it.");
    throw error;
  }
  if (!roots.some(root => inside(root, canonical)) || (await lstat(path)).isSymbolicLink()) {
    throw new ReportError("unsafe_path", "Evidence paths must not escape through symlinks.");
  }
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new ReportError("unsafe_path", "Only regular evidence files are accepted.");
    if (before.size > maxBytes) throw new ReportError("report_too_large", `Evidence exceeds the ${maxBytes}-byte limit.`);
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (size > maxBytes) throw new ReportError("report_too_large", "Evidence grew beyond the size limit while being read.");
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || size !== after.size) {
      throw new ReportError("changing_report", "Report changed during import. Wait for the command to finish.");
    }
    const bytes = Buffer.concat(chunks);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ReportError("invalid_encoding", "Reports must be UTF-8 text.");
    }
    return {
      text, bytes,
      source: {
        path, sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: size, modifiedAt: after.mtime.toISOString(),
      },
    };
  } finally {
    await handle.close();
  }
}

export async function atomicJson(base: string, path: string, value: unknown): Promise<void> {
  await privateDirectory(base, dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp);
    throw error;
  }
}
