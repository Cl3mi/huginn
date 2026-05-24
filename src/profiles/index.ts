import type { SectorProfile } from "./types.ts";
import { automotiveDe } from "./automotive.ts";

export { automotiveDe } from "./automotive.ts";
export type { SectorProfile, CompanyIdentity, ReqType } from "./types.ts";

export const PROFILES: SectorProfile[] = [automotiveDe];

export function resolveProfile(id: string): SectorProfile {
  return PROFILES.find((p) => p.id === id) ?? automotiveDe;
}
