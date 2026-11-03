import { createHash } from "node:crypto";
import { base58Decode, base58Encode } from "./borsh";
import { PUMP_PROGRAM } from "./events";

const P = 2n ** 255n - 19n;
const D = ((P - 121665n * modInv(121666n)) % P + P) % P; // -121665 / 121666 mod p

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}
function modInv(a: bigint): bigint {
  return modPow(a, P - 2n, P);
}

/** True if the 32 bytes are a valid ed25519 curve point (Solana wallets live on the curve, PDAs must not). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * modInv(v)) % P;
  return x2 === 0n || modPow(x2, (P - 1n) / 2n, P) === 1n;
}

/** Solana's findProgramAddress: the first off-curve hash, searching bump seeds from 255 down. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  const program = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.from([bump]));
    h.update(program);
    h.update("ProgramDerivedAddress");
    const digest = Uint8Array.from(h.digest());
    if (!isOnCurve(digest)) return { address: base58Encode(digest), bump };
  }
  throw new Error("no valid program address found");
}

const text = (s: string) => new TextEncoder().encode(s);

/**
 * The pump.fun `mint_authority` PDA. Per the official IDL it is an account of the `create` and `create_v2`
 * instructions only, so a logs subscription on this address delivers launch transactions and nothing else.
 */
export const PUMP_MINT_AUTHORITY = findProgramAddress([text("mint-authority")], PUMP_PROGRAM).address;
