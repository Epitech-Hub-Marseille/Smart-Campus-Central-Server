import { epitechMy } from "./plugins/epitechMy.js";
import type { PortalPlugin } from "./types.js";

/**
 * The portals the server can talk to. Adding one is a file in `plugins/` and a line here; nothing else knows which exist.
 * (Typed loosely on purpose: each plugin keeps its own settings type, the registry only needs to run them.)
 */
const PLUGINS: PortalPlugin<never>[] = [epitechMy as PortalPlugin<never>];

export const listPlugins = () => PLUGINS as readonly PortalPlugin<never>[];
export const getPlugin = (id: string) => PLUGINS.find((p) => p.id === id) as PortalPlugin<Record<string, unknown>> | undefined;
export const PLUGIN_IDS = PLUGINS.map((p) => p.id) as [string, ...string[]];
