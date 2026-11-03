/**
 * A small Borsh reader/writer driven by an Anchor IDL. The reader decodes pump.fun event logs; the writer
 * exists so tests can build realistic event bytes from the same IDL. Nothing here touches a network.
 */
export type IdlType =
  | string
  | { vec: IdlType }
  | { option: IdlType }
  | { array: [IdlType, number] }
  | { defined: { name: string } | string };

export interface IdlField {
  name: string;
  type: IdlType;
}
export interface IdlTypeDef {
  name: string;
  type: { kind: "struct" | "enum"; fields?: IdlField[]; variants?: { name: string; fields?: IdlField[] }[] };
}
export interface Idl {
  address: string;
  events: { name: string; discriminator: number[] }[];
  types: IdlTypeDef[];
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}

export function base58Decode(str: string): Uint8Array {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const v = B58.indexOf(str[i]!);
    if (v < 0) throw new Error(`invalid base58 character '${str[i]}'`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

export class Reader {
  private off = 0;
  private readonly view: DataView;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining(): number {
    return this.buf.length - this.off;
  }
  private need(n: number): void {
    if (this.off + n > this.buf.length) throw new Error(`borsh: need ${n} bytes, have ${this.remaining}`);
  }
  u8(): number { this.need(1); return this.buf[this.off++]!; }
  u16(): number { this.need(2); const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  u64(): bigint { this.need(8); const v = this.view.getBigUint64(this.off, true); this.off += 8; return v; }
  i64(): bigint { this.need(8); const v = this.view.getBigInt64(this.off, true); this.off += 8; return v; }
  bool(): boolean { return this.u8() !== 0; }
  bytes(n: number): Uint8Array { this.need(n); const v = this.buf.subarray(this.off, this.off + n); this.off += n; return v; }
  string(): string {
    const n = this.u32();
    if (n > 10_000) throw new Error(`borsh: implausible string length ${n}`);
    return new TextDecoder().decode(this.bytes(n));
  }
  pubkey(): string { return base58Encode(this.bytes(32)); }
}

export class Writer {
  private parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); }
  u16(v: number) { this.u8(v); this.u8(v >> 8); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); }
  u64(v: bigint) { for (let i = 0n; i < 8n; i++) this.u8(Number((v >> (8n * i)) & 0xffn)); }
  i64(v: bigint) { this.u64(BigInt.asUintN(64, v)); }
  bool(v: boolean) { this.u8(v ? 1 : 0); }
  raw(b: Uint8Array) { for (const x of b) this.parts.push(x); }
  string(s: string) { const b = new TextEncoder().encode(s); this.u32(b.length); this.raw(b); }
  pubkey(s: string) { const b = base58Decode(s); if (b.length !== 32) throw new Error("pubkey must be 32 bytes"); this.raw(b); }
  toBytes(): Uint8Array { return Uint8Array.from(this.parts); }
}

export type Decoded = bigint | number | string | boolean | null | Decoded[] | { [k: string]: Decoded };

function definedName(t: { defined: { name: string } | string }): string {
  return typeof t.defined === "string" ? t.defined : t.defined.name;
}

export function decodeType(r: Reader, t: IdlType, types: Map<string, IdlTypeDef>): Decoded {
  if (typeof t === "string") {
    switch (t) {
      case "bool": return r.bool();
      case "u8": return r.u8();
      case "u16": return r.u16();
      case "u32": return r.u32();
      case "u64": return r.u64();
      case "i64": return r.i64();
      case "pubkey": return r.pubkey();
      case "string": return r.string();
      default: throw new Error(`borsh: unsupported primitive type '${t}'`);
    }
  }
  if ("vec" in t) {
    const n = r.u32();
    if (n > 1000) throw new Error(`borsh: implausible vec length ${n}`);
    const out: Decoded[] = [];
    for (let i = 0; i < n; i++) out.push(decodeType(r, t.vec, types));
    return out;
  }
  if ("option" in t) return r.u8() === 0 ? null : decodeType(r, t.option, types);
  if ("array" in t) {
    const out: Decoded[] = [];
    for (let i = 0; i < t.array[1]; i++) out.push(decodeType(r, t.array[0], types));
    return out;
  }
  const def = types.get(definedName(t));
  if (!def) throw new Error(`borsh: unknown defined type '${definedName(t)}'`);
  if (def.type.kind === "struct") {
    const obj: { [k: string]: Decoded } = {};
    for (const f of def.type.fields ?? []) obj[f.name] = decodeType(r, f.type, types);
    return obj;
  }
  const idx = r.u8();
  const variant = def.type.variants?.[idx];
  if (!variant) throw new Error(`borsh: bad enum variant ${idx} for ${def.name}`);
  return variant.fields?.length ? { variant: variant.name } : variant.name;
}

export function encodeType(w: Writer, v: unknown, t: IdlType, types: Map<string, IdlTypeDef>): void {
  if (typeof t === "string") {
    switch (t) {
      case "bool": return w.bool(Boolean(v));
      case "u8": return w.u8(Number(v));
      case "u16": return w.u16(Number(v));
      case "u32": return w.u32(Number(v));
      case "u64": return w.u64(BigInt(v as bigint | number));
      case "i64": return w.i64(BigInt(v as bigint | number));
      case "pubkey": return w.pubkey(String(v));
      case "string": return w.string(String(v));
      default: throw new Error(`borsh: unsupported primitive type '${t}'`);
    }
  }
  if ("vec" in t) {
    const arr = (v ?? []) as unknown[];
    w.u32(arr.length);
    for (const x of arr) encodeType(w, x, t.vec, types);
    return;
  }
  if ("option" in t) {
    if (v === null || v === undefined) return w.u8(0);
    w.u8(1);
    return encodeType(w, v, t.option, types);
  }
  if ("array" in t) {
    for (const x of v as unknown[]) encodeType(w, x, t.array[0], types);
    return;
  }
  const def = types.get(definedName(t));
  if (!def || def.type.kind !== "struct") throw new Error(`borsh: cannot encode '${definedName(t)}'`);
  const obj = (v ?? {}) as Record<string, unknown>;
  for (const f of def.type.fields ?? []) encodeType(w, obj[f.name], f.type, types);
}
