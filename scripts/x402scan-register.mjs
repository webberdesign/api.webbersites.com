// Register api.webbersites.com with x402scan (x402scan.com/resources/register).
// Their API requires a SIWX (Sign-In With X) wallet signature — identity proof,
// no payment. Signs with EVM_PRIVATE_KEY (the seed hot wallet) from .env.
//
//   node scripts/x402scan-register.mjs        (run from the repo root)
import "dotenv/config";
import { wrapFetchWithSIWx } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
console.log("signing wallet:", account.address);

const siwxFetch = wrapFetchWithSIWx(fetch, account);

const res = await siwxFetch("https://www.x402scan.com/api/x402/registry/register-origin", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ origin: "https://api.webbersites.com" }),
});
console.log("HTTP", res.status);
console.log(JSON.stringify(await res.json(), null, 2).slice(0, 2500));
