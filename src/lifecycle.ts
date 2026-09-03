import type { history } from "@signalk/server-api";
import { effectiveConfig } from "./config/effective.js";
import { createHistoryApiProvider } from "./history/v2.js";
import { createPlaybackProvider, type PlaybackProvider } from "./history/v1.js";
import { IlpConnection, recordingStatus } from "./ilp/connection.js";
import { IlpTimestamps, encodeSample } from "./ilp/line.js";
import { PathFilter } from "./ingestion/path-filter.js";
import { Recorder, type DeltaLike } from "./ingestion/recorder.js";
import { SamplingGate, SamplingPolicy } from "./ingestion/sampling.js";
import { SqlClient, baseUrl, probeHealth } from "./storage/sql-client.js";
import {
  KEEP_FOREVER_TTL,
  applyRetention,
  createTables,
  errorMessage,
  repairSchema,
  retentionTtl,
} from "./storage/tables.js";

/** The part of the server's plugin API this plugin touches. */
export interface PluginApp {
  debug: (...args: unknown[]) => void;
  error: (message: string) => void;
  setPluginStatus: (message: string) => void;
  setPluginError: (message: string) => void;
  registerHistoryApiProvider: (provider: history.HistoryProvider) => void;
  registerHistoryProvider: (provider: PlaybackProvider) => void;
  streambundle: {
    getBus: () => {
      onValue: (callback: (delta: DeltaLike) => void) => () => void;
    };
  };
  selfContext: string;
}

export interface LifecycleTiming {
  readinessPollIntervalMs: number;
  readinessDeadlineMs: number;
  schemaRepairIntervalMs: number;
}

export const PRODUCTION_TIMING: LifecycleTiming = {
  readinessPollIntervalMs: 500,
  readinessDeadlineMs: 30000,
  schemaRepairIntervalMs: 60000,
};

export const STATUS_WAITING = "Waiting for QuestDB to become ready...";
export const STATUS_CREATING_TABLES = "Creating tables...";

class StartRun {
  cancelled = false;
  aborted = false;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start and stop. Starts run one at a time; a stop cancels starts that are
 * still queued and aborts the running one at its next wait, up to the point
 * where the ILP connection is up.
 */
export class PluginRuntime {
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<StartRun>();
  private current: StartRun | null = null;
  private sql: SqlClient | null = null;
  private ilp: IlpConnection | null = null;
  private unsubscribe: (() => void) | null = null;
  private repairTimer: NodeJS.Timeout | null = null;
  private repairInFlight = false;
  private ttl = KEEP_FOREVER_TTL;

  constructor(
    private readonly app: PluginApp,
    private readonly timing: LifecycleTiming = PRODUCTION_TIMING,
  ) {}

  start(config: unknown): void {
    const run = new StartRun();
    this.pending.add(run);
    this.queue = this.queue.then(() => this.runStart(run, config));
  }

  async stop(): Promise<void> {
    for (const run of this.pending) run.cancelled = true;
    if (this.current) this.current.aborted = true;
    this.sql = null;
    try {
      this.unsubscribe?.();
    } catch {
      // The bus is gone or already unsubscribed; nothing to undo.
    }
    this.unsubscribe = null;
    if (this.repairTimer) {
      clearInterval(this.repairTimer);
      this.repairTimer = null;
    }
    const ilp = this.ilp;
    this.ilp = null;
    if (ilp) await ilp.disconnect();
  }

  private async runStart(run: StartRun, config: unknown): Promise<void> {
    this.pending.delete(run);
    if (run.cancelled) {
      this.app.debug("skipping queued start: plugin stopped while it waited");
      return;
    }
    this.current = run;
    try {
      await this.startSequence(run, config);
    } catch (error) {
      this.app.setPluginError(`Startup failed: ${errorMessage(error)}`);
    } finally {
      if (this.current === run) this.current = null;
    }
  }

  private async startSequence(run: StartRun, config: unknown): Promise<void> {
    const cfg = effectiveConfig(config);
    const filter = new PathFilter(cfg.pathFilter.mode, cfg.pathFilter.paths);
    const sampling = new SamplingPolicy(
      cfg.defaultSamplingRate,
      cfg.samplingRates,
    );
    const {
      questdbHost: host,
      questdbHttpPort: httpPort,
      questdbIlpPort: ilpPort,
    } = cfg;
    const httpBase = baseUrl(host, httpPort);

    this.app.debug("connecting to QuestDB at %s:%d", host, httpPort);
    this.app.setPluginStatus(STATUS_WAITING);
    this.sql = new SqlClient(httpBase);
    this.ttl = KEEP_FOREVER_TTL;

    if (!(await this.waitForQuestDb(run, httpBase))) return;
    if (!(await probeHealth(httpBase))) {
      this.app.setPluginError(`QuestDB not responding at ${host}:${httpPort}`);
      return;
    }

    this.app.setPluginStatus(STATUS_CREATING_TABLES);
    const sql = this.sql!;
    await createTables(sql);
    if (!run.aborted) await this.repairPass();

    const gate = new SamplingGate();
    const timestamps = new IlpTimestamps();
    let recorder: Recorder | null = null;
    const ilp = new IlpConnection({
      host,
      port: ilpPort,
      log: (message) => this.app.debug(message),
      setError: (message) => this.app.setPluginError(message),
      setStatus: (message) => this.app.setPluginStatus(message),
      onDrop: () => recorder?.forgetNames(),
    });
    this.ilp = ilp;
    await ilp.connect();
    if (run.aborted) {
      await ilp.disconnect();
      return;
    }

    this.app.registerHistoryApiProvider(
      createHistoryApiProvider({
        selfContext: this.app.selfContext,
        query: sql.rows,
      }),
    );
    this.app.registerHistoryProvider(
      createPlaybackProvider({
        selfContext: this.app.selfContext,
        query: sql.rows,
        debug: (message) => this.app.debug(message),
      }),
    );
    recorder = new Recorder({
      selfContext: this.app.selfContext,
      recordSelf: cfg.recordSelf,
      recordOthers: cfg.recordOthers,
      filter,
      sampling,
      gate,
      emit: (sample) => ilp.append(encodeSample(sample, timestamps.next())),
    });
    const handle = (delta: DeltaLike): void => recorder!.handle(delta);
    this.unsubscribe = this.app.streambundle.getBus().onValue(handle);

    this.ttl = retentionTtl(cfg.retentionDays);
    try {
      await applyRetention(sql, this.ttl);
    } catch (error) {
      this.app.error(
        `Could not apply the retention setting: ${errorMessage(error)}`,
      );
    }

    this.repairTimer = setInterval(
      () => void this.repairPass(),
      this.timing.schemaRepairIntervalMs,
    );
    this.app.setPluginStatus(recordingStatus(host, ilpPort));
  }

  /** False when the start was aborted while polling. */
  private async waitForQuestDb(
    run: StartRun,
    httpBase: string,
  ): Promise<boolean> {
    const first = Date.now();
    let ready = await probeHealth(httpBase);
    if (run.aborted) return false;
    while (!ready && Date.now() - first < this.timing.readinessDeadlineMs) {
      await sleep(this.timing.readinessPollIntervalMs);
      if (run.aborted) return false;
      ready = await probeHealth(httpBase);
      if (run.aborted) return false;
    }
    return true;
  }

  private async repairPass(): Promise<void> {
    if (this.repairInFlight) return;
    this.repairInFlight = true;
    try {
      await repairSchema(
        () => this.sql!,
        this.ttl,
        (message) => this.app.debug(message),
      );
    } finally {
      this.repairInFlight = false;
    }
  }
}
