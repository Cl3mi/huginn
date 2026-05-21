export type SseEvent =
  | { type: "phase_start"; phase: string; phaseIndex: number; totalPhases: number }
  | { type: "phase_end"; phase: string; durationMs: number }
  | { type: "log"; level: "INFO" | "WARN" | "ERROR"; phase: string; message: string }
  | { type: "stats"; filesFound?: number; parsed?: number; pairsScored?: number; versionPairs?: number; references?: number; requirements?: number }
  | { type: "scan_complete"; scanId: string; reports: string[] }
  | { type: "scan_error"; phase: string; message: string };

export function encodeSseEvent(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export class SseBroadcaster {
  private clients = new Map<string, ReadableStreamDefaultController<string>>();

  get size(): number {
    return this.clients.size;
  }

  add(id: string, controller: ReadableStreamDefaultController<string>): void {
    this.clients.set(id, controller);
  }

  remove(id: string): void {
    this.clients.delete(id);
  }

  emit(event: SseEvent): void {
    const encoded = encodeSseEvent(event);
    for (const [id, ctrl] of this.clients) {
      try {
        ctrl.enqueue(encoded);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  closeAll(): void {
    for (const [, ctrl] of this.clients) {
      try { ctrl.close(); } catch { /* already closed */ }
    }
    this.clients.clear();
  }
}

export const broadcaster = new SseBroadcaster();
