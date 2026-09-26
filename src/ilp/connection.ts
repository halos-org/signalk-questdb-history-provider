import net from "node:net";

export const FLUSH_INTERVAL_MS = 5000;
export const FLUSH_LINE_COUNT = 1000;
export const BUFFER_CAP_LINES = 100000;
export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 30000;
export const STABILITY_WINDOW_MS = 5000;
export const UNHEALTHY_FLAP_THRESHOLD = 5;

export interface IlpConnectionOptions {
  host: string;
  port: number;
  log: (message: string) => void;
  setError: (message: string) => void;
  setStatus: (message: string) => void;
  /** Called after the buffer discards lines. */
  onDrop?: () => void;
}

export const recordingStatus = (host: string, port: number): string =>
  `Recording to QuestDB at ${host}:${port}`;

/**
 * The single TCP connection that carries ILP lines to QuestDB. The lines of
 * one delta are buffered as one entry, so a flush or the buffer cap never
 * splits a delta. The connection reconnects with backoff
 * and reports a persistently flapping peer on the plugin's status card.
 */
export class IlpConnection {
  /** One entry per hand-over: every line of one delta. */
  private buffer: (readonly string[])[] = [];
  private lineCount = 0;
  private socket: net.Socket | null = null;
  private attempt: Promise<void> | null = null;
  private connected = false;
  private connectedAt = 0;
  private stable = false;
  private flaps = 0;
  private delay = INITIAL_RECONNECT_DELAY_MS;
  private unhealthy = false;
  private dropped = 0;
  private disconnectRequested = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: IlpConnectionOptions) {}

  /** Opens the first connection. Rejects when that attempt fails. */
  connect(): Promise<void> {
    return this.open(false);
  }

  /** Buffers the lines of one delta together. */
  append(lines: readonly string[]): void {
    if (lines.length === 0) return;
    this.buffer.push(lines);
    this.lineCount += lines.length;
    this.applyCap();
    if (this.connected && this.lineCount >= FLUSH_LINE_COUNT) {
      this.flush();
    }
  }

  async disconnect(): Promise<void> {
    this.disconnectRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.attempt) {
      await this.attempt.catch(() => undefined);
    }
    this.stopTimers();
    const socket = this.socket;
    if (!this.connected || !socket) {
      this.buffer = [];
      this.lineCount = 0;
      return;
    }
    if (this.buffer.length > 0) {
      this.flush();
    }
    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.end(() => resolve());
    });
  }

  private open(reconnection: boolean): Promise<void> {
    const socket = net.connect({
      host: this.options.host,
      port: this.options.port,
    });
    this.socket = socket;
    const attempt = new Promise<void>((resolve, reject) => {
      socket.once("connect", () => {
        this.onConnect(reconnection);
        resolve();
      });
      socket.once("error", reject);
    });
    socket.on("error", (error) => {
      this.options.log(`ILP socket error: ${error.message}`);
    });
    socket.on("close", () => this.onClose(socket));
    this.attempt = attempt;
    const settled = (): void => {
      if (this.attempt === attempt) this.attempt = null;
    };
    attempt.then(settled, settled);
    return attempt;
  }

  private onConnect(reconnection: boolean): void {
    this.connected = true;
    this.connectedAt = Date.now();
    this.stable = false;
    this.options.log(
      `ILP connected to ${this.options.host}:${this.options.port}`,
    );
    if (this.disconnectRequested) return;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.stabilityTimer = setTimeout(
      () => this.onStable(),
      STABILITY_WINDOW_MS,
    );
    if (reconnection && this.buffer.length > 0) {
      this.flush();
    }
  }

  private onStable(): void {
    this.stable = true;
    this.delay = INITIAL_RECONNECT_DELAY_MS;
    this.flaps = 0;
    if (this.unhealthy) {
      this.unhealthy = false;
      this.dropped = 0;
      this.options.setStatus(
        recordingStatus(this.options.host, this.options.port),
      );
    }
  }

  private onClose(socket: net.Socket): void {
    if (socket !== this.socket) return;
    const up = this.connected ? Date.now() - this.connectedAt : 0;
    this.connected = false;
    this.socket = null;
    this.stopTimers();
    if (this.disconnectRequested) {
      this.buffer = [];
      this.lineCount = 0;
      return;
    }
    if (!this.stable) {
      this.flaps += 1;
      this.delay = Math.min(this.delay * 2, MAX_RECONNECT_DELAY_MS);
      this.options.log(
        `ILP connection dropped after ${up}ms (flap #${this.flaps}), retrying in ${this.delay}ms`,
      );
      if (this.flaps >= UNHEALTHY_FLAP_THRESHOLD) {
        this.unhealthy = true;
        this.options.setError(this.unhealthyMessage());
      }
    }
    this.stable = false;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open(true).catch(() => undefined);
    }, this.delay);
  }

  private unhealthyMessage(): string {
    const drops =
      this.dropped > 0 ? ` (${this.dropped} buffered samples dropped)` : "";
    return `QuestDB keeps dropping the write connection — the container may be unhealthy or out of memory${drops}.`;
  }

  private stopTimers(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private applyCap(): void {
    if (this.lineCount <= BUFFER_CAP_LINES) return;
    let removed = 0;
    let entries = 0;
    for (const entry of this.buffer) {
      if (this.lineCount - removed <= BUFFER_CAP_LINES) break;
      removed += entry.length;
      entries++;
    }
    this.buffer.splice(0, entries);
    this.lineCount -= removed;
    this.dropped += removed;
    this.options.onDrop?.();
  }

  private flush(): void {
    const socket = this.socket;
    if (!this.connected || !socket || this.buffer.length === 0) return;
    const batch = this.buffer;
    const batchLines = this.lineCount;
    this.buffer = [];
    this.lineCount = 0;
    const written = socket.write(batch.flat().join(""), (error) => {
      if (!error) return;
      this.buffer = batch.concat(this.buffer);
      this.lineCount += batchLines;
      this.applyCap();
      this.options.log(`ILP write failed, re-queued batch: ${error.message}`);
    });
    if (!written) {
      socket.once("drain", () =>
        this.options.log("ILP socket drained, resuming writes"),
      );
    }
  }
}
