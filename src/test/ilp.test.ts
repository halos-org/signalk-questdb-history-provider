// The ILP wire format surface: line shapes, timestamps, batching, buffering,
// reconnect backoff, and the health messages. Timers are mocked so the rows
// run at the production constants; the sockets are real.

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { IlpTimestamps, encodeSample, type Sample } from "../ilp/line.js";
import {
  BUFFER_CAP_LINES,
  FLUSH_INTERVAL_MS,
  FLUSH_LINE_COUNT,
  INITIAL_RECONNECT_DELAY_MS,
  IlpConnection,
  MAX_RECONNECT_DELAY_MS,
  STABILITY_WINDOW_MS,
  UNHEALTHY_FLAP_THRESHOLD,
} from "../ilp/connection.js";
import {
  closedPort,
  startFakeIlpPeer,
  waitFor,
  type FakeIlpPeer,
} from "./helpers.js";

const SOG: Sample = {
  kind: "numeric",
  path: "navigation.speedOverGround",
  context: "self",
  value: 6.4,
};

const UNHEALTHY =
  "QuestDB keeps dropping the write connection — the container may be unhealthy or out of memory";

describe("constants", () => {
  it("match the specification", () => {
    assert.equal(FLUSH_INTERVAL_MS, 5000);
    assert.equal(FLUSH_LINE_COUNT, 1000);
    assert.equal(BUFFER_CAP_LINES, 100000);
    assert.equal(INITIAL_RECONNECT_DELAY_MS, 1000);
    assert.equal(MAX_RECONNECT_DELAY_MS, 30000);
    assert.equal(STABILITY_WINDOW_MS, 5000);
    assert.equal(UNHEALTHY_FLAP_THRESHOLD, 5);
  });
});

describe("line shapes", () => {
  const ts = 1700000000000000000n;

  it("numeric", () => {
    assert.equal(
      encodeSample(SOG, ts),
      "signalk,path=navigation.speedOverGround,context=self value=6.4 1700000000000000000\n",
    );
  });

  it("string without a kind", () => {
    assert.equal(
      encodeSample(
        {
          kind: "string",
          path: "navigation.state",
          context: "self",
          value: "motoring",
        },
        ts,
      ),
      'signalk_str,path=navigation.state,context=self value_str="motoring" 1700000000000000000\n',
    );
  });

  it("tagged boolean and untagged text true", () => {
    assert.equal(
      encodeSample(
        {
          kind: "string",
          path: "switches.bilge.state",
          context: "self",
          value: "true",
          valueKind: "boolean",
        },
        ts,
      ),
      'signalk_str,path=switches.bilge.state,context=self,value_kind=boolean value_str="true" 1700000000000000000\n',
    );
    assert.equal(
      encodeSample(
        {
          kind: "string",
          path: "some.text.path",
          context: "self",
          value: "true",
        },
        ts,
      ),
      'signalk_str,path=some.text.path,context=self value_str="true" 1700000000000000000\n',
    );
  });

  it("source tags, present only when non-empty", () => {
    assert.equal(
      encodeSample({ ...SOG, source: "gps.main" }, ts),
      "signalk,path=navigation.speedOverGround,context=self,source=gps.main value=6.4 1700000000000000000\n",
    );
    assert.equal(
      encodeSample(
        {
          kind: "string",
          path: "navigation.state",
          context: "self",
          source: "n2k-on-ve.can0.115",
          value: "true",
          valueKind: "boolean",
        },
        ts,
      ),
      'signalk_str,path=navigation.state,context=self,source=n2k-on-ve.can0.115,value_kind=boolean value_str="true" 1700000000000000000\n',
    );
    assert.equal(
      encodeSample(
        {
          kind: "position",
          context: "self",
          source: "gps.main",
          latitude: 60.1,
          longitude: 24.9,
        },
        ts,
      ),
      "signalk_position,context=self,source=gps.main lat=60.1,lon=24.9 1700000000000000000\n",
    );
    assert.equal(
      encodeSample(
        {
          kind: "numeric",
          path: "environment.depth.belowKeel",
          context: "self",
          source: "",
          value: 3.2,
        },
        ts,
      ),
      "signalk,path=environment.depth.belowKeel,context=self value=3.2 1700000000000000000\n",
    );
  });

  it("position", () => {
    assert.equal(
      encodeSample(
        { kind: "position", context: "self", latitude: 52.5, longitude: 13.4 },
        ts,
      ),
      "signalk_position,context=self lat=52.5,lon=13.4 1700000000000000000\n",
    );
  });

  it("escapes tag values and string fields", () => {
    const line = encodeSample(
      {
        kind: "numeric",
        path: "path with spaces",
        context: "ctx,with,commas",
        value: 1,
      },
      ts,
    );
    assert.ok(line.includes("path\\ with\\ spaces"));
    assert.ok(line.includes("ctx\\,with\\,commas"));
    assert.equal(
      encodeSample(
        {
          kind: "string",
          path: "a=b",
          context: "c\\d",
          value: 'say "hi" \\ now',
        },
        ts,
      ),
      'signalk_str,path=a\\=b,context=c\\\\d value_str="say \\"hi\\" \\\\ now" 1700000000000000000\n',
    );
  });

  it("formats numbers with the default conversion", () => {
    assert.ok(encodeSample({ ...SOG, value: 1 }, ts).includes(" value=1 "));
    assert.ok(
      encodeSample({ ...SOG, value: 1e21 }, ts).includes(" value=1e+21 "),
    );
    assert.ok(
      encodeSample({ ...SOG, value: 1e-7 }, ts).includes(" value=1e-7 "),
    );
  });
});

describe("timestamps", () => {
  it("are nanoseconds with a one microsecond monotonic floor", () => {
    const clock = new IlpTimestamps();
    const first = clock.next(1700000000000);
    assert.equal(first, 1700000000000000000n);
    const second = clock.next(1700000000000);
    assert.equal(second, first + 1000n);
    const third = clock.next(1699999999999);
    assert.equal(third, second + 1000n);
    assert.equal(clock.next(1700000000001), 1700000000001000000n);
  });
});

interface Harness {
  peer: FakeIlpPeer;
  connection: IlpConnection;
  log: string[];
  errors: string[];
  statuses: string[];
  clock: IlpTimestamps;
  send(sample: Sample): void;
}

const realSetTimeout = setTimeout;

function harness(peer: FakeIlpPeer, port = peer.port): Harness {
  const h: Harness = {
    peer,
    log: [],
    errors: [],
    statuses: [],
    clock: new IlpTimestamps(),
    connection: new IlpConnection({
      host: peer.host,
      port,
      log: (m) => h.log.push(m),
      setError: (m) => h.errors.push(m),
      setStatus: (m) => h.statuses.push(m),
    }),
    send: (sample) => h.connection.append(encodeSample(sample, h.clock.next())),
  };
  return h;
}

const lineCount = (text: string): number => text.split("\n").length - 1;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const flapLine = (k: number, delay: number): string =>
  `(flap #${k}), retrying in ${delay}ms`;

describe("connection", () => {
  let peers: FakeIlpPeer[] = [];
  let connections: IlpConnection[] = [];

  beforeEach(() => {
    mock.timers.enable({
      apis: ["setTimeout", "setInterval", "Date"],
      now: Date.now(),
    });
  });

  afterEach(async () => {
    mock.timers.reset();
    for (const c of connections) await c.disconnect();
    for (const p of peers) await p.close();
    peers = [];
    connections = [];
  });

  async function connected(
    onConnection?: (socket: net.Socket, index: number) => void,
  ): Promise<Harness> {
    const peer = await startFakeIlpPeer(onConnection);
    peers.push(peer);
    const h = harness(peer);
    connections.push(h.connection);
    await h.connection.connect();
    await waitFor(() => peer.sockets.length >= 1);
    return h;
  }

  it("delivers a numeric line on the flush timer", async () => {
    const h = await connected();
    h.send(SOG);
    mock.timers.tick(FLUSH_INTERVAL_MS);
    await waitFor(() => h.peer.received[0].length > 0);
    assert.ok(
      h.peer.received[0].includes(
        "signalk,path=navigation.speedOverGround,context=self value=6.4",
      ),
    );
    assert.ok(h.peer.received[0].endsWith("\n"));
  });

  it("delivers string, boolean, source and position lines", async () => {
    const h = await connected();
    h.send({
      kind: "string",
      path: "navigation.state",
      context: "self",
      value: "motoring",
    });
    h.send({
      kind: "string",
      path: "switches.bilge.state",
      context: "self",
      value: "true",
      valueKind: "boolean",
    });
    h.send({
      kind: "string",
      path: "some.text.path",
      context: "self",
      value: "true",
    });
    h.send({ ...SOG, source: "gps.main" });
    h.send({
      kind: "position",
      context: "self",
      source: "gps.main",
      latitude: 60.1,
      longitude: 24.9,
    });
    h.send({
      kind: "numeric",
      path: "environment.depth.belowKeel",
      context: "self",
      value: 3.2,
    });
    h.send({
      kind: "position",
      context: "self",
      latitude: 52.5,
      longitude: 13.4,
    });
    h.send({
      kind: "numeric",
      path: "path with spaces",
      context: "ctx,with,commas",
      value: 1,
    });
    mock.timers.tick(FLUSH_INTERVAL_MS);
    await waitFor(() => lineCount(h.peer.received[0]) === 8);
    const text = h.peer.received[0];
    for (const expected of [
      'signalk_str,path=navigation.state,context=self value_str="motoring"',
      'signalk_str,path=switches.bilge.state,context=self,value_kind=boolean value_str="true"',
      'signalk_str,path=some.text.path,context=self value_str="true"',
      "signalk,path=navigation.speedOverGround,context=self,source=gps.main value=6.4",
      "signalk_position,context=self,source=gps.main lat=60.1,lon=24.9",
      "signalk,path=environment.depth.belowKeel,context=self value=3.2",
      "signalk_position,context=self lat=52.5,lon=13.4",
      "path\\ with\\ spaces",
      "ctx\\,with\\,commas",
    ]) {
      assert.ok(text.includes(expected), `missing ${expected}`);
    }
  });

  it("has sent nothing 700 ms after a sample", async () => {
    const h = await connected();
    h.send(SOG);
    mock.timers.tick(700);
    await settle();
    assert.equal(h.peer.received[0], "");
  });

  it("has sent the sample 5000 ms after connecting", async () => {
    const h = await connected();
    h.send(SOG);
    mock.timers.tick(5000);
    await waitFor(() =>
      h.peer.received[0].includes("navigation.speedOverGround"),
    );
  });

  it("flushes 1000 lines at once without the timer", async () => {
    const h = await connected();
    for (let i = 0; i < 1000; i++) h.send(SOG);
    await waitFor(() => lineCount(h.peer.received[0]) === 1000);
  });

  it("assigns strictly increasing timestamps a microsecond apart", async () => {
    const h = await connected();
    for (let i = 0; i < 5; i++) h.send(SOG);
    mock.timers.tick(FLUSH_INTERVAL_MS);
    await waitFor(() => lineCount(h.peer.received[0]) === 5);
    const stamps = h.peer.received[0]
      .trim()
      .split("\n")
      .map((line) => BigInt(line.slice(line.lastIndexOf(" ") + 1)));
    for (let i = 1; i < stamps.length; i++) {
      assert.ok(stamps[i] > stamps[i - 1]);
      assert.ok(stamps[i] - stamps[i - 1] >= 1000n);
      assert.notEqual(stamps[i] / 1000n, stamps[i - 1] / 1000n);
    }
  });

  it("reconnects after 2000 ms and flushes at once", async () => {
    const h = await connected((socket, index) => {
      if (index === 0) socket.destroy();
    });
    await waitFor(() => h.log.some((l) => l.includes(flapLine(1, 2000))));
    h.send(SOG);
    mock.timers.tick(1999);
    await settle();
    assert.equal(h.peer.sockets.length, 1);
    mock.timers.tick(1);
    await waitFor(() => h.peer.sockets.length === 2);
    await waitFor(() =>
      h.peer.received[1].includes(
        "signalk,path=navigation.speedOverGround,context=self value=6.4",
      ),
    );
  });

  it("re-queues pending batches in reverse order after a reset", async () => {
    const h = await connected((socket, index) => {
      if (index === 0) socket.pause();
    });
    // 100000 lines is more than any loopback kernel buffers before the peer
    // stops reading, so some batches always fail, and it is exactly the buffer
    // cap, so every failed batch survives the re-queue.
    for (let i = 0; i < 100000; i++) h.send({ ...SOG, value: i });
    await settle();
    h.peer.sockets[0].resetAndDestroy();
    await waitFor(() => h.log.some((l) => l.includes(flapLine(1, 2000))));

    const failed = h.log.filter((l) =>
      l.startsWith("ILP write failed, re-queued batch: "),
    );
    assert.ok(failed.length > 0);
    const errorIndex = h.log.findIndex((l) =>
      l.startsWith("ILP socket error: "),
    );
    const flapIndex = h.log.findIndex((l) => l.includes(flapLine(1, 2000)));
    assert.ok(errorIndex >= 0);
    assert.ok(flapIndex > errorIndex);

    mock.timers.tick(2000);
    await waitFor(() => h.peer.sockets.length === 2);
    await waitFor(() => lineCount(h.peer.received[1]) === failed.length * 1000);
    const values = h.peer.received[1]
      .trim()
      .split("\n")
      .map((line) => Number(/value=(\d+)/.exec(line)![1]));
    assert.equal(values[0], 100000 - 1000);
    for (let b = 0; b < failed.length; b++) {
      const batch = values.slice(b * 1000, (b + 1) * 1000);
      const start = 100000 - (b + 1) * 1000;
      assert.deepEqual(
        batch,
        Array.from({ length: 1000 }, (_, i) => start + i),
      );
    }
  });

  it("reports an unhealthy peer at the fifth flap and on every later one", async () => {
    const h = await connected((socket) => socket.destroy());
    const delays = [2000, 4000, 8000, 16000, 30000];
    for (let k = 1; k <= 5; k++) {
      await waitFor(() =>
        h.log.some((l) => l.includes(flapLine(k, delays[k - 1]))),
      );
      if (k < 5) mock.timers.tick(delays[k - 1]);
    }
    assert.equal(h.errors.length, 1);
    assert.ok(h.errors[0].includes("dropping the write connection"));
    mock.timers.tick(30000);
    await waitFor(() => h.log.some((l) => l.includes(flapLine(6, 30000))));
    assert.equal(h.errors.length, 2);
    mock.timers.tick(30000);
    await waitFor(() => h.log.some((l) => l.includes(flapLine(7, 30000))));
    assert.equal(h.errors.length, 3);
  });

  it("recovers on the stability window alone", async () => {
    const h = await connected((socket, index) => {
      if (index < 5) socket.destroy();
    });
    const delays = [2000, 4000, 8000, 16000, 30000];
    for (let k = 1; k <= 5; k++) {
      await waitFor(() =>
        h.log.some((l) => l.includes(flapLine(k, delays[k - 1]))),
      );
      if (k < 5) mock.timers.tick(delays[k - 1]);
    }
    assert.equal(h.errors.length, 1);
    mock.timers.tick(30000);
    await waitFor(() => h.peer.sockets.length === 6);
    await waitFor(
      () => h.log.filter((l) => l.startsWith("ILP connected to")).length === 6,
    );
    assert.deepEqual(h.statuses, []);
    mock.timers.tick(4999);
    await settle();
    assert.deepEqual(h.statuses, []);
    mock.timers.tick(1);
    await settle();
    assert.deepEqual(h.statuses, [
      `Recording to QuestDB at 127.0.0.1:${h.peer.port}`,
    ]);
  });

  async function refused(): Promise<{ h: Harness; port: number }> {
    const port = await closedPort();
    const peer = await startFakeIlpPeer();
    peers.push(peer);
    const h = harness(peer, port);
    connections.push(h.connection);
    await assert.rejects(h.connection.connect());
    return { h, port };
  }

  it("counts dropped lines in the unhealthy message", async () => {
    const { h } = await refused();
    for (let i = 0; i < 100002; i++) h.send({ ...SOG, value: i });
    const delays = [2000, 4000, 8000, 16000, 30000];
    for (let k = 1; k <= 5; k++) {
      await waitFor(() =>
        h.log.some((l) => l.includes(flapLine(k, delays[k - 1]))),
      );
      if (k < 5) mock.timers.tick(delays[k - 1]);
    }
    assert.deepEqual(h.errors, [`${UNHEALTHY} (2 buffered samples dropped).`]);
  });

  it("delivers the 100000 most recent lines once the peer accepts", async () => {
    const { h, port } = await refused();
    for (let i = 0; i < 100002; i++) h.send({ ...SOG, value: i });
    await waitFor(() => h.log.some((l) => l.includes(flapLine(1, 2000))));
    const peer = await startFakeIlpPeer(undefined, port);
    peers.push(peer);
    mock.timers.tick(2000);
    await waitFor(() => peer.sockets.length === 1);
    await waitFor(() => lineCount(peer.received[0]) === 100000, 20000);
    const lines = peer.received[0].trim().split("\n");
    assert.equal(lines.length, 100000);
    assert.ok(lines[0].includes(" value=2 "));
    assert.ok(lines[99999].includes(" value=100001 "));
  });

  it("writes buffered lines before the socket closes on disconnect", async () => {
    const h = await connected();
    h.send(SOG);
    await h.connection.disconnect();
    await waitFor(() =>
      h.peer.received[0].includes("navigation.speedOverGround"),
    );
    await waitFor(() => h.peer.sockets[0].readableEnded);
  });

  it("logs the drain line once per flush issued under backpressure", async () => {
    const h = await connected((socket, index) => {
      if (index === 0) {
        socket.pause();
        realSetTimeout(() => socket.resume(), 100);
      }
    });
    // The burst must exceed what the kernel buffers for a peer that is not
    // reading; Linux loopback takes several megabytes before a write is held.
    for (let i = 0; i < 200000; i++) h.send({ ...SOG, value: i });
    await waitFor(
      () =>
        h.log.filter((l) => l === "ILP socket drained, resuming writes")
          .length >= 1,
      50000,
    );
  });
});
