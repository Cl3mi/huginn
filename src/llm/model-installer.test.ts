import { expect, test, describe } from "bun:test";
import { parseOllamaPullLine, type PullEvent } from "./model-installer.ts";

describe("parseOllamaPullLine", () => {
  test("parses a 'pulling manifest' status line", () => {
    const ev = parseOllamaPullLine(`{"status":"pulling manifest"}`);
    expect(ev).toEqual({ type: "status", status: "pulling manifest" });
  });

  test("parses a progress line with completed/total bytes", () => {
    const line = `{"status":"pulling abc123","completed":1024,"total":2048}`;
    const ev = parseOllamaPullLine(line);
    expect(ev).toEqual({ type: "progress", completedBytes: 1024, totalBytes: 2048 });
  });

  test("parses a 'success' final line", () => {
    const ev = parseOllamaPullLine(`{"status":"success"}`);
    expect(ev).toEqual({ type: "complete" });
  });

  test("returns null for malformed JSON", () => {
    expect(parseOllamaPullLine("not json")).toBeNull();
  });

  test("returns null for empty line", () => {
    expect(parseOllamaPullLine("")).toBeNull();
  });

  test("returns an error event when error field is present", () => {
    const ev = parseOllamaPullLine(`{"error":"manifest not found"}`);
    expect(ev).toEqual({ type: "error", message: "manifest not found" });
  });

  test("clamps long error messages to <= 120 chars", () => {
    const longMsg = "x".repeat(500);
    const ev = parseOllamaPullLine(JSON.stringify({ error: longMsg }));
    expect(ev?.type).toBe("error");
    if (ev?.type === "error") {
      expect(ev.message.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("PullEvent type discriminator (compile-time)", () => {
  test("can discriminate on type field", () => {
    const events: PullEvent[] = [
      { type: "status", status: "pulling manifest" },
      { type: "progress", completedBytes: 0, totalBytes: 100 },
      { type: "complete" },
      { type: "error", message: "fail" },
    ];
    expect(events.length).toBe(4);
  });
});
