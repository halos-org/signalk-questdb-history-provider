/**
 * QuestDB's HTTP query endpoint. Every statement, DDL included, goes through
 * `GET /exec` with the same deadline enforced on both ends.
 */
export const STATEMENT_TIMEOUT_MS = 30000;
export const HEALTH_PROBE_TIMEOUT_MS = 5000;

export interface ExecResult {
  columns: { name: string; type: string }[];
  dataset: unknown[][];
  count: number;
  timestamp: number;
}

/** Runs one SQL statement and returns the rows of its `dataset`. */
export type QueryRows = (sql: string) => Promise<unknown[][]>;

export interface SqlExecutor {
  query(sql: string): Promise<ExecResult>;
}

export const baseUrl = (host: string, port: number): string =>
  `http://${host}:${port}`;

export class SqlClient implements SqlExecutor {
  constructor(private readonly base: string) {}

  async query(sql: string): Promise<ExecResult> {
    const params = new URLSearchParams({ query: sql });
    const response = await fetch(`${this.base}/exec?${params}`, {
      headers: { "Statement-Timeout": String(STATEMENT_TIMEOUT_MS) },
      signal: AbortSignal.timeout(STATEMENT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`QuestDB query failed (${response.status}): ${body}`);
    }
    return (await response.json()) as ExecResult;
  }

  rows: QueryRows = async (sql) => (await this.query(sql)).dataset;
}

/** True when QuestDB answers `SELECT 1` with a 2xx status. Never throws. */
export async function probeHealth(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/exec?query=SELECT+1`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
