import { CONFIG } from "../config.ts";

export type PullEvent =
  | { type: "status"; status: string }
  | { type: "progress"; completedBytes: number; totalBytes: number }
  | { type: "complete" }
  | { type: "error"; message: string };

function clamp(s: string, max = CONFIG.maxStringLengthInReport): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function parseOllamaPullLine(line: string): PullEvent | null {
  if (!line || line.trim().length === 0) return null;
  let obj: { status?: string; completed?: number; total?: number; error?: string };
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj.error === "string") {
    return { type: "error", message: clamp(obj.error) };
  }
  if (obj.status === "success") {
    return { type: "complete" };
  }
  if (typeof obj.completed === "number" && typeof obj.total === "number") {
    return { type: "progress", completedBytes: obj.completed, totalBytes: obj.total };
  }
  if (typeof obj.status === "string") {
    return { type: "status", status: clamp(obj.status) };
  }
  return null;
}

export type PullController = {
  abort: () => void;
};

export async function pullModel(
  modelId: string,
  onEvent: (ev: PullEvent) => void,
): Promise<PullController> {
  const controller = new AbortController();
  const pc: PullController = { abort: () => controller.abort() };

  (async () => {
    try {
      const res = await fetch(`${CONFIG.ollamaUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelId, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        onEvent({ type: "error", message: clamp(`pull HTTP ${res.status}`) });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          const ev = parseOllamaPullLine(line);
          if (ev) onEvent(ev);
          nl = buffer.indexOf("\n");
        }
      }
      const tail = buffer.trim();
      if (tail) {
        const ev = parseOllamaPullLine(tail);
        if (ev) onEvent(ev);
      }
    } catch (e: unknown) {
      if (controller.signal.aborted) {
        onEvent({ type: "error", message: "cancelled" });
      } else {
        onEvent({ type: "error", message: clamp(String(e)) });
      }
    }
  })();

  return pc;
}
