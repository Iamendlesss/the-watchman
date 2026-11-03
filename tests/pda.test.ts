import { describe, expect, it } from "vitest";
import { base58Decode } from "../src/scanner/borsh";
import { PUMP_PROGRAM } from "../src/scanner/events";
import { PUMP_MINT_AUTHORITY, findProgramAddress, isOnCurve } from "../src/scanner/pda";

// Reference values computed independently with @solana/web3.js findProgramAddressSync.
describe("program derived addresses", () => {
  it("derives the pump.fun mint-authority PDA exactly like the standard Solana library", () => {
    expect(PUMP_MINT_AUTHORITY).toBe("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM");
  });
  it("matches other known derivations", () => {
    const enc = new TextEncoder();
    expect(findProgramAddress([enc.encode("global")], PUMP_PROGRAM).address).toBe("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
    const mint = base58Decode("7yWCHJMJ8sxBkdUEnYyvBQU5h3sTKtScyDA1gACHpump");
    expect(findProgramAddress([enc.encode("bonding-curve"), mint], PUMP_PROGRAM).address).toBe("8MSsTcdbGiZJ7C4UWXTXU9UuBxbK55zydx2h9y7Bx4XR");
  });
  it("finds bump 255 for the mint-authority seed", () => {
    expect(findProgramAddress([new TextEncoder().encode("mint-authority")], PUMP_PROGRAM).bump).toBe(255);
  });
  it("tells real wallets (on the curve) from PDAs (off the curve)", () => {
    expect(isOnCurve(base58Decode(PUMP_PROGRAM))).toBe(true); // a program id is a normal ed25519 point
    expect(isOnCurve(base58Decode(PUMP_MINT_AUTHORITY))).toBe(false);
    expect(isOnCurve(new Uint8Array(31))).toBe(false);
  });
});
