// SPDX-License-Identifier: Apache-2.0
// End-to-end smoke for @pome-sh/twin-stripe.
//
// Boots the built server (or assumes one is running on PORT) and walks
// the full x402 settlement flow:
//   1. healthz returns 200 with the expected shape
//   2. POST /v1/payment_intents → status=requires_action with deposit address
//   3. POST /v1/test_helpers/.../simulate_crypto_deposit → status=succeeded
//   4. GET /v1/balance reflects the PI amount
//   5. GET /v1/events lists the 5 expected events
//   6. an unsupported route returns the loud 501 envelope
//
// Exits 0 on full success, non-zero on any failure. Prints colored
// progress to stderr; the final line on stdout is "OK" or "FAIL: <why>"
// for easy scripting.

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 40_000 + Math.floor(Math.random() * 10_000);
const port = Number(process.env.PORT ?? String(DEFAULT_PORT));
const baseUrl = `http://127.0.0.1:${port}`;
const sid = "default";
const apiKey = "sk_test_pome_default";

const c = {
  step: "\x1b[36m",
  ok: "\x1b[32m",
  fail: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

function log(stage: "step" | "ok" | "fail", msg: string) {
  const prefix =
    stage === "ok" ? `${c.ok}✓${c.reset}` :
    stage === "fail" ? `${c.fail}✗${c.reset}` :
    `${c.step}step${c.reset}`;
  process.stderr.write(`${prefix} ${msg}\n`);
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    log("fail", msg);
    throw new Error(msg);
  }
}

async function waitForHealthz(
  timeoutMs: number,
  getChildExit?: () => string | undefined
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const childExit = getChildExit?.();
    if (childExit) {
      throw new Error(`server exited before healthz became ready: ${childExit}`);
    }
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.ok) return;
    } catch {
      /* server not ready yet */
    }
    await sleep(100);
  }
  throw new Error(`healthz did not return 200 within ${timeoutMs}ms`);
}

async function main() {
  process.stderr.write(`${c.bold}\n📋 twin-stripe end-to-end smoke${c.reset}\n\n`);

  // Boot the server we just built. If POME_SMOKE_NO_BOOT=1, assume one
  // is already running (CI uses this to test against a snapshot).
  let serverProc: ChildProcess | undefined;
  let dbDir: string | undefined;
  if (process.env.POME_SMOKE_NO_BOOT !== "1") {
    dbDir = mkdtempSync(join(tmpdir(), "twin-stripe-smoke-"));
    let childExit: string | undefined;
    let childStderr = "";
    serverProc = spawn("node", ["dist/src/server.js"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(port),
        STRIPE_CLONE_HOST: "127.0.0.1",
        STRIPE_CLONE_DB: join(dbDir, "smoke.db"),
        TWIN_AUTH_SECRET: process.env.TWIN_AUTH_SECRET ?? "smoke-secret-not-for-prod",
      },
    });
    serverProc.stderr?.on("data", (chunk) => {
      childStderr = `${childStderr}${String(chunk)}`.slice(-4000);
    });
    serverProc.once("exit", (code, signal) => {
      const status = code === null ? `signal=${signal}` : `code=${code}`;
      childExit = childStderr.trim()
        ? `${status}; stderr=${childStderr.trim()}`
        : status;
    });
    await waitForHealthz(5000, () => childExit);
    log("step", `server booted on :${port}`);
  } else {
    log("step", `assuming server on :${port} (POME_SMOKE_NO_BOOT=1)`);
  }

  try {
    // 1. healthz
    {
      const r = await fetch(`${baseUrl}/healthz`);
      assertOk(r.ok, `1. healthz returned ${r.status}`);
      const body = await r.json() as Record<string, unknown>;
      assertOk(body.twin === "stripe", `1. healthz twin=${body.twin}, expected "stripe"`);
      assertOk(body.implementation === "stripe_clone", `1. implementation=${body.implementation}`);
      assertOk(body.tools === 12, `1. tools=${body.tools}, expected 12`);
      log("ok", `healthz: tools=${body.tools}, fidelity=${body.fidelity}, tthw=${(body.tthw_seconds as number).toFixed(2)}s`);
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    // 2. create PI
    let piId = "";
    let depositAddress = "";
    {
      const r = await fetch(`${baseUrl}/s/${sid}/v1/payment_intents`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          amount: 1000,
          currency: "usd",
          payment_method_types: ["crypto"],
          payment_method_options: {
            crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
          },
        }),
      });
      const piRaw = await r.text();
      assertOk(r.ok, `2. create PI returned ${r.status}: ${piRaw}`);
      const pi = JSON.parse(piRaw) as Record<string, unknown>;
      assertOk((pi.id as string).startsWith("pi_"), `2. PI id ${pi.id} doesn't start with pi_`);
      assertOk(pi.status === "requires_action", `2. PI status=${pi.status}, expected requires_action`);
      assertOk(pi.amount === 1000, `2. PI amount=${pi.amount}, expected 1000`);
      assertOk(pi.currency === "usd", `2. PI currency=${pi.currency}, expected usd`);
      const next = pi.next_action as Record<string, Record<string, Record<string, { address: string }>>>;
      depositAddress = next.crypto_display_details.deposit_addresses.base.address;
      assertOk(/^0x[0-9a-f]{40}$/.test(depositAddress), `2. bad deposit address: ${depositAddress}`);
      piId = pi.id as string;
      log("ok", `created ${piId} with deposit ${c.dim}${depositAddress}${c.reset}`);
    }

    // 3. simulate deposit
    {
      const r = await fetch(`${baseUrl}/s/${sid}/v1/test_helpers/payment_intents/${piId}/simulate_crypto_deposit`, {
        method: "POST",
        headers,
        body: "{}",
      });
      assertOk(r.ok, `3. simulate_crypto_deposit returned ${r.status}`);
      const settled = await r.json() as Record<string, unknown>;
      assertOk(settled.status === "succeeded", `3. PI status after settle=${settled.status}, expected succeeded`);
      assertOk((settled.latest_charge as string).startsWith("ch_"), `3. latest_charge=${settled.latest_charge}, expected ch_*`);
      log("ok", `simulated deposit, PI succeeded, latest_charge=${settled.latest_charge}`);
    }

    // 4. balance
    {
      const r = await fetch(`${baseUrl}/s/${sid}/v1/balance`, { headers });
      assertOk(r.ok, `4. balance returned ${r.status}`);
      const balance = await r.json() as { available: Array<{ currency: string; amount: number }> };
      const usd = balance.available.find((row) => row.currency === "usd");
      assertOk(usd, `4. no usd row in balance.available`);
      assertOk(usd!.amount === 1000, `4. balance.available.usd.amount=${usd!.amount}, expected 1000`);
      log("ok", `balance.available.usd = $10.00 (1000 cents)`);
    }

    // 5. events
    {
      const r = await fetch(`${baseUrl}/s/${sid}/v1/events`, { headers });
      assertOk(r.ok, `5. events returned ${r.status}`);
      const list = await r.json() as { data: Array<{ type: string }> };
      const types = list.data.map((e) => e.type).sort();
      const expected = [
        "charge.succeeded",
        "payment_intent.created",
        "payment_intent.processing",
        "payment_intent.requires_action",
        "payment_intent.succeeded",
      ];
      assertOk(JSON.stringify(types) === JSON.stringify(expected), `5. events=${JSON.stringify(types)}, expected ${JSON.stringify(expected)}`);
      log("ok", `5 events emitted: ${types.join(", ")}`);
    }

    // 6. unsupported route → loud 501
    {
      const r = await fetch(`${baseUrl}/s/${sid}/v1/customers`, { headers });
      assertOk(r.status === 501, `6. /v1/customers returned ${r.status}, expected 501`);
      const env = await r.json() as { error: { code: string; fidelity: string } };
      assertOk(env.error.code === "endpoint_not_supported", `6. error.code=${env.error.code}`);
      assertOk(env.error.fidelity === "unsupported", `6. error.fidelity=${env.error.fidelity}`);
      log("ok", `loud 501 envelope: code=${env.error.code}, fidelity=${env.error.fidelity}`);
    }

    process.stderr.write(`\n${c.ok}${c.bold}✓ smoke passed${c.reset}\n`);
    process.stdout.write("OK\n");
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n${c.fail}${c.bold}✗ smoke failed${c.reset}: ${msg}\n`);
    process.stdout.write(`FAIL: ${msg}\n`);
    process.exit(1);
  } finally {
    if (serverProc) {
      serverProc.kill("SIGTERM");
      // give it a moment to flush
      await sleep(100);
    }
    if (dbDir) {
      try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err}\n`);
  process.exit(1);
});
