// Fakes shared by the surface suites: a scripted QuestDB HTTP endpoint, a
// TCP peer for ILP, and a scripted SQL executor.

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import type { ExecResult, SqlExecutor } from "../storage/sql-client.js";

export const emptyResult: ExecResult = {
  columns: [],
  dataset: [],
  count: 0,
  timestamp: 0,
};

export const resultOf = (dataset: unknown[][]): ExecResult => ({
  ...emptyResult,
  dataset,
});

// Captured before any suite mocks the timers, so waits stay real.
const realSetTimeout = globalThis.setTimeout;

/** Polls `condition` until it holds or `timeoutMs` of real time pass. */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
  throw new Error("waitFor: condition never held");
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type ScriptedAnswer =
  ExecResult | { status: number; body: string } | Error;

export interface FakeQuestDb {
  host: string;
  port: number;
  url: string;
  /** Every `query` parameter received, in order. Health probes included. */
  queries: string[];
  headers: http.IncomingHttpHeaders[];
  answer: (sql: string) => ScriptedAnswer | Promise<ScriptedAnswer>;
  close(): Promise<void>;
}

/** A local `/exec` endpoint whose answers the test scripts. */
export async function startFakeQuestDb(
  answer: (sql: string) => ScriptedAnswer = () => emptyResult,
): Promise<FakeQuestDb> {
  const fake: FakeQuestDb = {
    host: "127.0.0.1",
    port: 0,
    url: "",
    queries: [],
    headers: [],
    answer,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const sql = url.searchParams.get("query") ?? "";
    fake.queries.push(sql);
    fake.headers.push(req.headers);
    const reply = await fake.answer(sql);
    if (reply instanceof Error) {
      req.socket.destroy();
      return;
    }
    if ("status" in reply && "body" in reply) {
      res.writeHead(reply.status).end(reply.body);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  server.listen(0, fake.host);
  await once(server, "listening");
  fake.port = (server.address() as net.AddressInfo).port;
  fake.url = `http://${fake.host}:${fake.port}`;
  return fake;
}

export interface FakeIlpPeer {
  host: string;
  port: number;
  sockets: net.Socket[];
  /** Text received per connection, in connection order. */
  received: string[];
  onConnection: (socket: net.Socket, index: number) => void;
  close(): Promise<void>;
}

/** A TCP listener standing in for QuestDB's ILP port. */
export async function startFakeIlpPeer(
  onConnection: (socket: net.Socket, index: number) => void = () => undefined,
): Promise<FakeIlpPeer> {
  const peer: FakeIlpPeer = {
    host: "127.0.0.1",
    port: 0,
    sockets: [],
    received: [],
    onConnection,
    close: async () => {
      for (const socket of peer.sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
  const server = net.createServer((socket) => {
    const index = peer.sockets.length;
    peer.sockets.push(socket);
    peer.received.push("");
    socket.on("data", (chunk) => {
      peer.received[index] += chunk.toString("utf8");
    });
    socket.on("error", () => undefined);
    peer.onConnection(socket, index);
  });
  server.listen(0, peer.host);
  await once(server, "listening");
  peer.port = (server.address() as net.AddressInfo).port;
  return peer;
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
}

export interface ScriptedSql extends SqlExecutor {
  statements: string[];
  rows: (sql: string) => Promise<unknown[][]>;
}

/** An in-memory SQL executor whose answers the test scripts. */
export function scriptedSql(
  answer: (sql: string) => ExecResult | Error = () => emptyResult,
): ScriptedSql {
  const sql: ScriptedSql = {
    statements: [],
    query: async (statement) => {
      sql.statements.push(statement);
      const reply = answer(statement);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    rows: async (statement) => (await sql.query(statement)).dataset,
  };
  return sql;
}
