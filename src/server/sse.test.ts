import { expect, test, describe } from "bun:test";
import { SseBroadcaster, encodeSseEvent } from "./sse.ts";

describe("encodeSseEvent", () => {
  test("formats a phase_start event as SSE text", () => {
    const result = encodeSseEvent({ type: "phase_start", phase: "1-harvest", phaseIndex: 0, totalPhases: 9 });
    expect(result).toBe('data: {"type":"phase_start","phase":"1-harvest","phaseIndex":0,"totalPhases":9}\n\n');
  });

  test("formats a log event as SSE text", () => {
    const result = encodeSseEvent({ type: "log", level: "WARN", phase: "2-parse", message: "Tika timeout" });
    expect(result).toBe('data: {"type":"log","level":"WARN","phase":"2-parse","message":"Tika timeout"}\n\n');
  });
});

describe("SseBroadcaster", () => {
  test("tracks added controllers", () => {
    const b = new SseBroadcaster();
    const chunks: string[] = [];
    const fakeCtrl = { enqueue: (c: string) => chunks.push(c), close: () => {} };
    b.add("c1", fakeCtrl as unknown as ReadableStreamDefaultController<string>);
    expect(b.size).toBe(1);
    b.remove("c1");
    expect(b.size).toBe(0);
  });

  test("emit encodes and sends to all controllers", () => {
    const b = new SseBroadcaster();
    const received: string[] = [];
    const fakeCtrl = { enqueue: (c: string) => received.push(c), close: () => {} };
    b.add("c1", fakeCtrl as unknown as ReadableStreamDefaultController<string>);
    b.emit({ type: "phase_end", phase: "1-harvest", durationMs: 3000 });
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('"phase_end"');
    expect(received[0]).toContain('"durationMs":3000');
  });

  test("remove is idempotent", () => {
    const b = new SseBroadcaster();
    b.remove("nonexistent"); // must not throw
  });
});
