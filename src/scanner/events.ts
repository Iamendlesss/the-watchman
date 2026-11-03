import fs from "node:fs";
import path from "node:path";
import { Reader, Writer, decodeType, encodeType, type Decoded, type Idl, type IdlTypeDef } from "./borsh";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SYSTEM_DEFAULT = "11111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";

export interface CreateEvent {
  name: string;
  symbol: string;
  mint: string;
  bondingCurve: string;
  creator: string;
  totalSupply: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenProgram: string;
  mayhem: boolean;
  quoteIsSol: boolean;
}
export interface TradeEvent {
  mint: string;
  user: string;
  isBuy: boolean;
  solAmount: bigint;
  tokenAmount: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  /** Protocol fee rate plus creator fee rate, in basis points. This is the cost of a trade to the trader. */
  totalFeeBps: number;
  /** Each fee field as the event reports it, kept separate for calibration. holder_rewards_bps repeats the creator
   *  fee rate on holder-reward coins, so it must never be added to the total. */
  feeFields: { fee: number; creator: number; cashback: number; buyback: number; holderRewards: number };
}
export interface CompleteEvent {
  mint: string;
}

export type PumpEvent =
  | { name: "CreateEvent"; data: CreateEvent }
  | { name: "TradeEvent"; data: TradeEvent }
  | { name: "CompleteEvent"; data: CompleteEvent }
  | { name: "CompletePumpAmmMigrationEvent"; data: CompleteEvent };

type Obj = { [k: string]: Decoded };
const big = (o: Obj, k: string): bigint => {
  const v = o[k];
  return typeof v === "bigint" ? v : 0n;
};
const str = (o: Obj, k: string): string => {
  const v = o[k];
  return typeof v === "string" ? v : "";
};
const bool = (o: Obj, k: string): boolean => o[k] === true;

const HANDLED = new Set(["CreateEvent", "TradeEvent", "CompleteEvent", "CompletePumpAmmMigrationEvent"]);

export function loadPumpIdl(rootDir: string = process.cwd()): Idl {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "idl", "pump.json"), "utf8")) as Idl;
}

export interface DecodeStats {
  events: number;
  errors: number;
  /** Event names seen from the pump program that we do not use, with counts (for debugging). */
  ignored: Map<string, number>;
}

export class PumpEventDecoder {
  private readonly byDisc = new Map<string, string>();
  private readonly types = new Map<string, IdlTypeDef>();
  readonly stats: DecodeStats = { events: 0, errors: 0, ignored: new Map() };

  constructor(idl: Idl) {
    for (const e of idl.events) this.byDisc.set(e.discriminator.join(","), e.name);
    for (const t of idl.types) this.types.set(t.name, t);
  }

  /** Discriminator bytes for an event name (used by tests to build data). */
  discriminator(name: string): number[] {
    for (const [k, v] of this.byDisc) if (v === name) return k.split(",").map(Number);
    throw new Error(`unknown event ${name}`);
  }

  /** Encode an event the way the program would emit it (tests only). */
  encodeEvent(name: string, value: Record<string, unknown>): string {
    const w = new Writer();
    w.raw(Uint8Array.from(this.discriminator(name)));
    const def = this.types.get(name);
    if (!def?.type.fields) throw new Error(`no type for ${name}`);
    for (const f of def.type.fields) encodeType(w, value[f.name], f.type, this.types);
    return Buffer.from(w.toBytes()).toString("base64");
  }

  /**
   * Pull pump.fun events out of one transaction's log lines. `Program data:` lines are only trusted when the
   * innermost running program is the pump program, so events from other programs are never misread.
   */
  decodeLogs(logs: string[]): PumpEvent[] {
    const out: PumpEvent[] = [];
    const stack: string[] = [];
    for (const line of logs) {
      const inv = /^Program (\S+) invoke \[\d+\]/.exec(line);
      if (inv) { stack.push(inv[1]!); continue; }
      if (/^Program \S+ (success|failed)/.test(line)) { stack.pop(); continue; }
      if (!line.startsWith("Program data: ")) continue;
      if (stack[stack.length - 1] !== PUMP_PROGRAM) continue;
      const ev = this.decodeData(line.slice("Program data: ".length).trim());
      if (ev) out.push(ev);
    }
    return out;
  }

  private decodeData(b64: string): PumpEvent | null {
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    } catch {
      this.stats.errors++;
      return null;
    }
    if (bytes.length < 8) return null;
    const name = this.byDisc.get(Array.from(bytes.subarray(0, 8)).join(","));
    if (!name) return null;
    if (!HANDLED.has(name)) {
      this.stats.ignored.set(name, (this.stats.ignored.get(name) ?? 0) + 1);
      return null;
    }
    try {
      const def = this.types.get(name);
      if (!def?.type.fields) throw new Error("no type");
      const r = new Reader(bytes.subarray(8));
      const o: Obj = {};
      for (const f of def.type.fields) o[f.name] = decodeType(r, f.type, this.types);
      this.stats.events++;
      return this.convert(name, o);
    } catch {
      this.stats.errors++;
      return null;
    }
  }

  private convert(name: string, o: Obj): PumpEvent | null {
    switch (name) {
      case "CreateEvent": {
        const q = str(o, "quote_mint");
        return {
          name,
          data: {
            name: str(o, "name"),
            symbol: str(o, "symbol"),
            mint: str(o, "mint"),
            bondingCurve: str(o, "bonding_curve"),
            creator: str(o, "creator"),
            totalSupply: big(o, "token_total_supply"),
            virtualTokenReserves: big(o, "virtual_token_reserves"),
            virtualSolReserves: big(o, "virtual_sol_reserves"),
            realTokenReserves: big(o, "real_token_reserves"),
            tokenProgram: str(o, "token_program"),
            mayhem: bool(o, "is_mayhem_mode"),
            quoteIsSol: q === "" || q === SYSTEM_DEFAULT || q === WSOL,
          },
        };
      }
      case "TradeEvent": {
        const bps = (k: string) => Number(big(o, k));
        return {
          name,
          data: {
            mint: str(o, "mint"),
            user: str(o, "user"),
            isBuy: bool(o, "is_buy"),
            solAmount: big(o, "sol_amount"),
            tokenAmount: big(o, "token_amount"),
            virtualSolReserves: big(o, "virtual_sol_reserves"),
            virtualTokenReserves: big(o, "virtual_token_reserves"),
            realSolReserves: big(o, "real_sol_reserves"),
            realTokenReserves: big(o, "real_token_reserves"),
            totalFeeBps: bps("fee_basis_points") + bps("creator_fee_basis_points"),
            feeFields: {
              fee: bps("fee_basis_points"),
              creator: bps("creator_fee_basis_points"),
              cashback: bps("cashback_fee_basis_points"),
              buyback: bps("buyback_fee_basis_points"),
              holderRewards: bps("holder_rewards_bps"),
            },
          },
        };
      }
      case "CompleteEvent":
      case "CompletePumpAmmMigrationEvent":
        return { name, data: { mint: str(o, "mint") } };
      default:
        return null;
    }
  }
}
