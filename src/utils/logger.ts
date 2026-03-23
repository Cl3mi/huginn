import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { CONFIG } from "../config.ts";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

let currentPhase = "startup";
let logFilePath: string | null = null;

export function setPhase(phase: string): void {
  currentPhase = phase;
}

function getLogFilePath(): string {
  if (!logFilePath) {
    mkdirSync(CONFIG.reportOutput, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    logFilePath = join(CONFIG.reportOutput, `scan-${ts}.log`);
  }
  return logFilePath;
}

// Truncate log messages to 120 chars — prevents accidental content leakage
function sanitizeMessage(msg: string): string {
  return msg.length > 120 ? msg.slice(0, 117) + "..." : msg;
}

function log(level: LogLevel, message: string, data?: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    phase: currentPhase,
    level,
    message: sanitizeMessage(message),
    ...(data !== undefined ? { data } : {}),
  };

  const line = JSON.stringify(entry);
  console.log(line);

  try {
    appendFileSync(getLogFilePath(), line + "\n");
  } catch (e) {
    process.stderr.write(`[logger] log file write failed: ${String(e)}\n`);
  }
}

export const logger = {
  debug: (message: string, data?: unknown) => log("DEBUG", message, data),
  info: (message: string, data?: unknown) => log("INFO", message, data),
  warn: (message: string, data?: unknown) => log("WARN", message, data),
  error: (message: string, data?: unknown) => log("ERROR", message, data),

  phaseStart: (phase: string) => {
    setPhase(phase);
    log("INFO", `Phase started: ${phase}`);
    return Date.now();
  },

  phaseEnd: (phase: string, startTime: number, extra?: unknown) => {
    const durationMs = Date.now() - startTime;
    log("INFO", `Phase completed: ${phase}`, { durationMs, ...((extra as object) ?? {}) });
  },
};
