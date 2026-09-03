/**
 * The configuration schema exactly as the server receives it. The Admin UI
 * renders it as a form; the server stores what the form submits and applies
 * no defaults itself, so the effective values live in effective.ts.
 */
export const ConfigSchema = {
  type: "object",
  required: [
    "questdbHost",
    "questdbIlpPort",
    "questdbHttpPort",
    "pathFilter",
    "defaultSamplingRate",
    "samplingRates",
    "recordSelf",
    "recordOthers",
    "retentionDays",
  ],
  properties: {
    questdbHost: {
      type: "string",
      default: "127.0.0.1",
      title: "QuestDB host",
      description: "Hostname or address of the QuestDB server to connect to.",
    },
    questdbIlpPort: {
      type: "number",
      default: 9009,
      title: "ILP port (writes)",
      description:
        "QuestDB's line-protocol port. QuestDB's own default is 9009.",
    },
    questdbHttpPort: {
      type: "number",
      default: 9000,
      title: "HTTP port (queries)",
      description:
        "QuestDB's HTTP port, used for queries. Its default is 9000.",
    },
    pathFilter: {
      type: "object",
      required: ["mode", "paths"],
      properties: {
        mode: {
          anyOf: [
            { type: "string", const: "exclude" },
            { type: "string", const: "include" },
          ],
          default: "exclude",
          title: "Filter mode",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          default: [],
          title: "Path patterns (glob supported)",
          description: 'e.g. "notifications.*", "environment.wind.*"',
        },
      },
    },
    defaultSamplingRate: {
      type: "number",
      default: 2000,
      title: "Default sampling rate (ms)",
      description:
        "Minimum ms between writes for any path (0 = write every update). 2000ms is a sensible default for Pi-class hardware; lower it per-path via samplingRates when you need finer resolution.",
    },
    samplingRates: {
      type: "object",
      patternProperties: { "^.*$": { type: "number" } },
      default: {},
      title: "Per-path sampling rates (ms)",
      description:
        'Override default rate for specific paths. e.g. { "environment.wind.*": 200, "tanks.*": 10000 }',
    },
    recordSelf: {
      type: "boolean",
      default: true,
      title: "Record own vessel",
    },
    recordOthers: {
      type: "boolean",
      default: true,
      title: "Record other vessels",
    },
    retentionDays: {
      type: "number",
      default: 0,
      title: "Retention (days, 0 = keep forever)",
    },
  },
};
