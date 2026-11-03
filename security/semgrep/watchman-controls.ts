// Examples that prove each rule in watchman-controls.yml fires when it should and stays quiet when it should.
// This file is never run or built. `semgrep --test` reads the annotations.

// ok: watchman-no-signing-library
import { z } from "zod";
// ruleid: watchman-no-signing-library
import { Keypair } from "@solana/web3.js";
// ruleid: watchman-no-signing-library
import nacl from "tweetnacl";
// ruleid: watchman-no-signing-library
import * as ed from "@noble/ed25519";
// ruleid: watchman-no-signing-library
const bs58 = require("bs58");

// ok: watchman-no-process-spawn
import fs from "node:fs";
// ruleid: watchman-no-process-spawn
import { execSync } from "node:child_process";
// ruleid: watchman-no-process-spawn
import vm from "vm";
// ruleid: watchman-no-process-spawn
const cp = require("child_process");

// ruleid: watchman-no-dynamic-code
eval(coinName);
// ruleid: watchman-no-dynamic-code
const run = new Function("a", coinName);
// ok: watchman-no-dynamic-code
JSON.parse(coinName);

// ruleid: watchman-no-trading-key-read
const key = process.env.TRADER_PRIVATE_KEY;
// ruleid: watchman-no-trading-key-read
const key2 = process.env["TRADER_PRIVATE_KEY"];
// ok: watchman-no-trading-key-read
const helius = process.env.HELIUS_API_KEY;

// ruleid: watchman-sql-from-data
db.prepare(`SELECT * FROM positions WHERE symbol = '${coinName}'`).all();
// ok: watchman-sql-from-data
db.prepare("SELECT * FROM positions WHERE symbol = ?").all(coinName);
// ok: watchman-sql-from-data
db.prepare(`SELECT * FROM positions WHERE status = 'closed'${since !== undefined ? " AND opened_at >= ?" : ""}`).all();
