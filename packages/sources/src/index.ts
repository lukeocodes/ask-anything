import { registerAdapter } from "@ask/core";
import { gitPublic } from "./git-public.js";
import { website } from "./website.js";

export * from "./git-public.js";
export * from "./website.js";
export * from "./common.js";

/**
 * The two adapters the engine ships (ADR-0020): public git repositories and
 * websites. Registration order matters — `detectAdapter` takes the first
 * match, and the website adapter accepts any http(s) URL, so git goes first.
 * Call once at startup, before anything registers or indexes a source.
 */
export function registerBuiltinAdapters(): void {
  registerAdapter(gitPublic);
  registerAdapter(website);
}
