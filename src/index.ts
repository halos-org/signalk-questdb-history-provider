import type { Plugin } from "@signalk/server-api";
import { ConfigSchema } from "./config/schema.js";
import {
  PluginRuntime,
  type LifecycleTiming,
  type PluginApp,
} from "./lifecycle.js";
import { PLUGIN_ID } from "./plugin-id.js";

/** The same value is in `signalk.displayName` in package.json and in the README. */
export const DISPLAY_NAME = "QuestDB History Provider";

export interface HistoryPlugin extends Plugin {
  start(config: object): void;
  stop(): Promise<void>;
}

/**
 * Builds the plugin object with explicit lifecycle timing. The default
 * export is what the server loads; this form exists for tests that cannot
 * wait thirty seconds for a readiness deadline.
 */
export function createPlugin(
  app: PluginApp,
  timing?: LifecycleTiming,
): HistoryPlugin {
  const runtime = new PluginRuntime(app, timing);
  return {
    id: PLUGIN_ID,
    name: DISPLAY_NAME,
    schema: ConfigSchema,
    start: (config: object): void => runtime.start(config),
    stop: (): Promise<void> => runtime.stop(),
  };
}

export default function plugin(app: PluginApp): HistoryPlugin {
  return createPlugin(app);
}
