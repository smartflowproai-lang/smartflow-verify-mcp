#!/usr/bin/env node
/**
 * smartflow-verify-mcp: MCP server for SmartFlow Observatory
 * (independent x402 observatory on Base).
 *
 * Tools:
 *   get_network_decomposition  (free)  - sealed decomposition of x402 growth
 *   order_endpoint_audit       ($399)  - create a payable audit order (x402 402 challenge)
 *   get_audit_order_status     (free)  - poll an audit order
 *
 * This server is a pure HTTP client of the public observatory API.
 * It holds no keys and NEVER moves funds.
 */

import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.SMARTFLOW_BASE_URL || "https://verify.smartflowproai.com";
const DECOMPOSED_URL = `${BASE_URL}/decomposed/decomposed.json`;
const ORDER_URL = `${BASE_URL}/audit/order`;
const HTTP_TIMEOUT_MS = 25_000;
const USER_AGENT = "smartflow-verify-mcp/0.1.0";

// ---------- helpers ----------

/** fetch with timeout; returns {status, json|null, text}; throws only on network-level failure */
async function httpJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { "User-Agent": USER_AGENT, ...(options.headers || {}) },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000}s` : (err?.cause?.message || err?.message || String(err));
    throw new Error(`Could not reach the SmartFlow Observatory API at ${url} (${reason}). This is a network problem, not an order problem. Retry in a minute; nothing was created or charged by a failed request.`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body; keep text */ }
  return { status: res.status, json, text };
}

/**
 * Canonical JSON matching the seal recipe:
 * python json.dumps(data, sort_keys=True, separators=(',',':'), ensure_ascii=False), sha256 of UTF-8 bytes.
 */
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

function verifySeal(doc) {
  if (!doc || typeof doc !== "object" || !doc.seal?.sha256 || doc.data === undefined) return { verified: false, note: "document has no data/seal fields" };
  const computed = createHash("sha256").update(Buffer.from(canonicalJson(doc.data), "utf8")).digest("hex");
  return {
    verified: computed === doc.seal.sha256,
    computed_sha256: computed,
    note: computed === doc.seal.sha256
      ? "Seal verified locally by this MCP client: sha256 over canonical JSON of `data` matches `seal.sha256`. The numbers are tamper-evident."
      : "SEAL MISMATCH: locally computed sha256 of `data` does not match `seal.sha256`. Treat the numbers as unverified (possible tampering, truncated download, or a float-serialization edge case).",
  };
}

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function fail(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// ---------- server ----------

const server = new McpServer({
  name: "smartflow-verify-mcp",
  version: "0.1.0",
});

// T1: get_network_decomposition (free)
server.registerTool(
  "get_network_decomposition",
  {
    title: "x402 growth, decomposed (free)",
    description:
      "FREE, read-only. Integrity-sealed decomposition of x402 payment growth on Base from SmartFlow Observatory's independent ledger of USDC micro-transfers: how much of the headline volume is wash / self-dealing / clone-fleet activity vs bundler plumbing vs the organic clean core. " +
      "Returns the full dataset plus `seal_verified` (this client recomputes the SHA-256 seal locally, recipe included in the response) and `data_age_hours`. " +
      "Use this BEFORE trusting any headline x402 volume figure. " +
      "Caveats: data refreshes roughly daily (check `data_age_hours`); figures reflect the observatory's ingest time, so the most recent ~1h of activity may be under-represented.",
    inputSchema: {},
  },
  async () => {
    let resp;
    try {
      resp = await httpJson(DECOMPOSED_URL);
    } catch (err) {
      return fail(err.message);
    }
    if (resp.status !== 200 || !resp.json) {
      return fail(`The decomposition endpoint answered HTTP ${resp.status} instead of the expected sealed JSON. The dataset may be mid-refresh; retry in a few minutes. First bytes of the response: ${resp.text.slice(0, 300)}`);
    }
    const doc = resp.json;
    const seal = verifySeal(doc);
    let ageHours = null;
    const gen = doc.data?.generated_at_utc;
    if (gen) {
      const t = Date.parse(gen);
      if (!Number.isNaN(t)) ageHours = Math.round(((Date.now() - t) / 3_600_000) * 10) / 10;
    }
    return ok({
      data: doc.data,
      seal: doc.seal,
      seal_verified: seal.verified,
      seal_verification_note: seal.note,
      data_age_hours: ageHours,
      source_url: DECOMPOSED_URL,
    });
  }
);

// T4: order_endpoint_audit ($399, tool itself never moves funds)
server.registerTool(
  "order_endpoint_audit",
  {
    title: "Order a $399 x402 endpoint audit",
    description:
      "Creates a PAYABLE ORDER for a $399 signed, human-reviewed audit of an x402 endpoint or receiving wallet (wash-share, payer concentration, demand dispersion, attribution), delivered by email within 48 business hours of payment. " +
      "COST: calling this tool is free and moves NO funds. It returns an x402 `exact`-scheme payment challenge (HTTP 402) with a per-order UNIQUE USDC amount on Base, plus plain-language payment instructions and the order id. " +
      "The purchase only happens if you (or your operator) then pay the EXACT quoted amount to the quoted address; do not round it. This is a real $399 purchase; confirm with your operator if your spend policy requires it. " +
      "Unpaid orders are harmless and expire on their own within 24h. After paying, poll get_audit_order_status with the order id; if a payment submission times out, poll status BEFORE paying again. Never pay the same order twice.",
    inputSchema: {
      target: z
        .string()
        .min(3)
        .max(500)
        .describe("What to audit: an x402 endpoint URL (https://...) or a receiving wallet address (0x...)."),
      email: z
        .string()
        .email()
        .max(254)
        .describe("Email address to deliver the signed audit report to."),
    },
  },
  async ({ target, email }) => {
    let resp;
    try {
      resp = await httpJson(ORDER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, email }),
      });
    } catch (err) {
      return fail(err.message);
    }
    // The success path for order creation IS HTTP 402 (payment required).
    if (resp.status === 402 && resp.json?.accepts?.length) {
      const challenge = resp.json;
      const accept = challenge.accepts[0];
      const order = challenge.order || {};
      const amountAtomic = accept.amount ?? accept.maxAmountRequired;
      const amountUsdc = order.expected_amount_usdc || (amountAtomic ? (Number(amountAtomic) / 1e6).toFixed(6) : null);
      return ok({
        order_id: order.id || null,
        status: "pending_payment",
        payment_instructions:
          `Pay EXACTLY ${amountUsdc} USDC on Base (${accept.network}) to ${accept.payTo}. ` +
          `The micro-USDC fraction is unique to this order; do not round or the payment cannot be matched. ` +
          `Asset (USDC contract): ${accept.asset}. Use the x402 'exact' scheme (verified and settled through the Coinbase facilitator in the same request), or a plain USDC transfer of the exact amount matched by amount. ` +
          `After paying, poll get_audit_order_status with order_id ${order.id || "(see challenge)"}. ` +
          `If nothing is paid, the order expires harmlessly within 24h.`,
        amount_usdc: amountUsdc,
        amount_atomic: amountAtomic,
        pay_to: accept.payTo,
        network: accept.network,
        asset: accept.asset,
        status_url: order.status_url || null,
        x402_challenge: challenge,
        note: "This tool moved no funds. The order becomes a purchase only when the exact amount above is paid.",
      });
    }
    if (resp.status === 400 || resp.status === 422) {
      const detail = resp.json?.error || resp.json?.detail || resp.text.slice(0, 300);
      return fail(`The order was rejected as invalid (HTTP ${resp.status}): ${detail}. Check that 'target' is an x402 endpoint URL (https://...) or a 0x wallet address, and that 'email' is a deliverable address, then call the tool again. No order was created and nothing was charged.`);
    }
    return fail(`Unexpected response from the audit order endpoint (HTTP ${resp.status}). Expected an HTTP 402 payment challenge. The service may be briefly unavailable. Retry in a minute; if a 402 was never returned, no order was created and nothing was charged. First bytes: ${resp.text.slice(0, 300)}`);
  }
);

// T5: get_audit_order_status (free)
server.registerTool(
  "get_audit_order_status",
  {
    title: "Check audit order status (free)",
    description:
      "FREE, read-only. Poll the status of an audit order created with order_endpoint_audit. " +
      "Status `pending_payment` means no payment has been settled or detected yet; `paid: true` confirms your x402 payment was settled through the facilitator or matched by exact amount; a delivered state means the signed report was emailed. " +
      "Caveats: payment detection reads Base USDC transfer logs and can lag a few minutes behind the chain. If you just paid the exact amount, wait 2-5 minutes and poll again before assuming a problem. Unpaid orders expire within 24h.",
    inputSchema: {
      order_id: z
        .string()
        .regex(/^aud_[0-9a-f]{16}$/, "order id looks like aud_ followed by 16 hex characters")
        .describe("The order id returned by order_endpoint_audit, e.g. aud_2e4270db0cc840c3."),
    },
  },
  async ({ order_id }) => {
    let resp;
    try {
      resp = await httpJson(`${ORDER_URL}?id=${encodeURIComponent(order_id)}`);
    } catch (err) {
      return fail(err.message);
    }
    if (resp.status === 200 && resp.json) {
      return ok(resp.json);
    }
    if (resp.status === 404) {
      return fail(`No order found with id ${order_id}. Either the id is mistyped (expected format aud_ + 16 hex chars) or the unpaid order already expired (unpaid orders expire within 24h). If you already paid it, keep the payment tx hash and re-create the order via order_endpoint_audit, mentioning the tx in the email thread.`);
    }
    return fail(`Unexpected response from the order status endpoint (HTTP ${resp.status}). Retry in a minute. First bytes: ${resp.text.slice(0, 300)}`);
  }
);

// ---------- start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("smartflow-verify-mcp ready on stdio");
