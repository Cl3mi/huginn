import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  loadSetupState,
  saveSetupState,
  autoRecoverIfPossible,
  type SetupState,
} from "./setup-state.ts";

const TMP = "/tmp/huginn-setup-test";
const FILE = join(TMP, "setup.json");

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("loadSetupState / saveSetupState", () => {
  test("returns null when file does not exist", () => {
    expect(loadSetupState(FILE)).toBeNull();
  });

  test("round-trips a valid state", () => {
    const state: SetupState = {
      schemaVersion: 2,
      installedChatModel: "llama3.1:8b",
      installedAt: "2026-05-21T10:00:00.000Z",
      fitReportAtInstall: null,
      companyIdentity: null,
    };
    saveSetupState(FILE, state);
    expect(existsSync(FILE)).toBe(true);
    const loaded = loadSetupState(FILE);
    expect(loaded).toEqual(state);
  });

  test("returns null and deletes corrupt JSON", () => {
    writeFileSync(FILE, "{ not valid json");
    expect(loadSetupState(FILE)).toBeNull();
    expect(existsSync(FILE)).toBe(false);
  });

  test("returns null and deletes mismatched schema version", () => {
    writeFileSync(FILE, JSON.stringify({ schemaVersion: 99, installedChatModel: "x" }));
    expect(loadSetupState(FILE)).toBeNull();
    expect(existsSync(FILE)).toBe(false);
  });
});

describe("autoRecoverIfPossible", () => {
  test("returns null when no catalog model is installed in Ollama", async () => {
    const recovered = await autoRecoverIfPossible(FILE, async () => ["random-model:1.0"]);
    expect(recovered).toBeNull();
    expect(existsSync(FILE)).toBe(false);
  });

  test("picks largest validated catalog model when multiple are installed", async () => {
    const recovered = await autoRecoverIfPossible(FILE, async () => [
      "llama3.2:3b",
      "llama3.1:8b",
      "qwen2.5:14b",
      "junk-model",
    ]);
    expect(recovered).not.toBeNull();
    expect(recovered!.installedChatModel).toBe("qwen2.5:14b");
    expect(existsSync(FILE)).toBe(true);
  });

  test("ignores unvalidated catalog entries during auto-recovery", async () => {
    const recovered = await autoRecoverIfPossible(FILE, async () => [
      "llama3.1:8b",
      "llama3.3:70b",
    ]);
    expect(recovered).not.toBeNull();
    expect(recovered!.installedChatModel).toBe("llama3.1:8b");
  });

  test("returns null and does not write file when Ollama tags lookup throws", async () => {
    const recovered = await autoRecoverIfPossible(FILE, async () => {
      throw new Error("ollama down");
    });
    expect(recovered).toBeNull();
    expect(existsSync(FILE)).toBe(false);
  });
});
