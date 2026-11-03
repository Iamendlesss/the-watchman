import { base58Encode } from "../src/scanner/borsh";
import { PumpEventDecoder, loadPumpIdl, PUMP_PROGRAM, type PumpEvent } from "../src/scanner/events";
import type { Idl } from "../src/scanner/borsh";

export const idl: Idl = loadPumpIdl();
export const decoder = new PumpEventDecoder(idl);

/** A deterministic fake wallet/mint address (valid 32-byte base58). */
export const pk = (seed: number): string =>
  base58Encode(Uint8Array.from({ length: 32 }, (_, i) => ((seed + 1) * 31 + i * 17) % 251 || 1));

function zeroFor(t: unknown): unknown {
  if (typeof t === "string") {
    if (t === "bool") return false;
    if (t === "pubkey") return "11111111111111111111111111111111";
    if (t === "string") return "";
    return t.startsWith("i") || t.startsWith("u") ? 0n : undefined;
  }
  if (t && typeof t === "object" && "vec" in t) return [];
  return undefined;
}

/** Build the base64 payload of an event with every field zeroed except the overrides. */
export function eventData(name: string, overrides: Record<string, unknown>): string {
  const def = idl.types.find((t) => t.name === name)!;
  const v: Record<string, unknown> = {};
  for (const f of def.type.fields ?? []) v[f.name] = zeroFor(f.type);
  return decoder.encodeEvent(name, { ...v, ...overrides });
}

/** Log lines for one transaction where the pump program emits the given events. */
export function pumpLogs(datas: string[]): string[] {
  const lines = [`Program ${PUMP_PROGRAM} invoke [1]`, "Program log: Instruction: Buy"];
  for (const d of datas) lines.push(`Program data: ${d}`);
  lines.push(`Program ${PUMP_PROGRAM} consumed 40000 of 200000 compute units`, `Program ${PUMP_PROGRAM} success`);
  return lines;
}

export const SUPPLY = 1_000_000_000_000_000n; // 1B tokens at 6 decimals
export const CURVE_TOKENS = 793_100_000_000_000n;

export function createEv(mint: string, creator: string, over: Record<string, unknown> = {}): PumpEvent {
  const logs = pumpLogs([
    eventData("CreateEvent", {
      name: "Test Coin",
      symbol: "TEST",
      mint,
      bonding_curve: pk(900),
      user: creator,
      creator,
      token_total_supply: SUPPLY,
      virtual_token_reserves: 1_073_000_000_000_000n,
      virtual_sol_reserves: 30_000_000_000n,
      real_token_reserves: CURVE_TOKENS,
      token_program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      ...over,
    }),
  ]);
  return decoder.decodeLogs(logs)[0]!;
}

export function tradeEv(mint: string, user: string, isBuy: boolean, tokens: bigint, sol: bigint, over: Record<string, unknown> = {}): PumpEvent {
  const logs = pumpLogs([
    eventData("TradeEvent", {
      mint,
      user,
      is_buy: isBuy,
      token_amount: tokens,
      sol_amount: sol,
      virtual_sol_reserves: 31_000_000_000n,
      virtual_token_reserves: 1_040_000_000_000_000n,
      real_sol_reserves: 5_000_000_000n,
      real_token_reserves: CURVE_TOKENS - tokens,
      fee_basis_points: 95n,
      creator_fee_basis_points: 30n,
      ...over,
    }),
  ]);
  return decoder.decodeLogs(logs)[0]!;
}
