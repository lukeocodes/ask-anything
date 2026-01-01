import { execFile } from "node:child_process";
import type { IndexResult } from "@ask/core";

/** A fresh, zeroed counter set for one index run. */
export function emptyResult(): Required<Omit<IndexResult, "lastCommit">> & { lastCommit: string | null } {
  return { skipped: false, created: 0, changed: 0, unchanged: 0, pruned: 0, seen: 0, failed: 0, lastCommit: null };
}

export type Counters = ReturnType<typeof emptyResult>;

export function tally(result: Counters, r: { created: boolean; changed: boolean }): void {
  if (r.created) result.created += 1;
  else if (r.changed) result.changed += 1;
  else result.unchanged += 1;
}

/** True when the first 8 KB contain a NUL byte. */
export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// --- Subprocesses -----------------------------------------------------------

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(`${command} ${args.join(" ")} failed (${exitCode ?? "signal"}): ${stderr.trim().slice(0, 500)}`);
    this.name = "CommandError";
  }
}

function exec<T extends string | Buffer>(
  command: string,
  args: string[],
  encoding: "utf8" | "buffer",
  opts: RunOptions,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as { code?: number | string }).code;
          const text = typeof stderr === "string" ? stderr : stderr.toString("utf8");
          reject(new CommandError(command, args, text || err.message, typeof code === "number" ? code : null));
          return;
        }
        resolvePromise(stdout as T);
      },
    );
  });
}

/** execFile with a timeout, never a shell. Stdout as utf8 text. */
export function run(command: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return exec<string>(command, args, "utf8", opts);
}

/** Raw bytes from a subprocess (for `git show` of arbitrary files). */
export function runBuffer(command: string, args: string[], opts: RunOptions = {}): Promise<Buffer> {
  return exec<Buffer>(command, args, "buffer", opts);
}
