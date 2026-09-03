// A recording stand-in for the server's plugin app object.

import type { PluginApp } from "../lifecycle.js";
import type { DeltaLike } from "../ingestion/recorder.js";

export interface FakeApp extends PluginApp {
  debugLines: string[];
  errorLines: string[];
  statuses: string[];
  errors: string[];
  v2Providers: unknown[];
  v1Providers: unknown[];
  listeners: ((delta: DeltaLike) => void)[];
  emit(delta: DeltaLike): void;
}

export function fakeApp(
  selfContext = "vessels.urn:mrn:imo:mmsi:123456789",
): FakeApp {
  const app: FakeApp = {
    debugLines: [],
    errorLines: [],
    statuses: [],
    errors: [],
    v2Providers: [],
    v1Providers: [],
    listeners: [],
    selfContext,
    debug: (...args: unknown[]) => {
      app.debugLines.push(args.map(String).join(" "));
    },
    error: (message) => {
      app.errorLines.push(message);
    },
    setPluginStatus: (message) => {
      app.statuses.push(message);
    },
    setPluginError: (message) => {
      app.errors.push(message);
    },
    registerHistoryApiProvider: (provider) => {
      app.v2Providers.push(provider);
    },
    registerHistoryProvider: (provider) => {
      app.v1Providers.push(provider);
    },
    streambundle: {
      getBus: () => ({
        onValue: (callback) => {
          app.listeners.push(callback);
          return () => {
            app.listeners = app.listeners.filter((l) => l !== callback);
          };
        },
      }),
    },
    emit: (delta) => {
      for (const listener of app.listeners) listener(delta);
    },
  };
  return app;
}
