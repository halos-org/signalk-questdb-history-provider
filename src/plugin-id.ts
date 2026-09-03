/**
 * The plugin's identity, in one place.
 *
 * Signal K derives nothing from the package name: `plugin.id` is declared in
 * code, and the CI integration job reads it from this built module. Every
 * site that needs the id reads it from here.
 */
export const PLUGIN_ID = "signalk-questdb-history-provider";
