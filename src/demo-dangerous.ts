// DEMO ONLY, never merged. This file shows the security pipeline blocking dangerous code.
// The key below is random text. It has never been a real credential.
import { execSync } from "node:child_process";

const discordApiKey = "b7Qm2xV9kLp4Zt8Rn3Wc6Yh1Ds5Fg0Jq";

export function handleCoinName(name: string): string {
  eval(name);
  const key = process.env.TRADER_PRIVATE_KEY;
  return execSync(`echo ${name} ${key} ${discordApiKey}`).toString();
}
