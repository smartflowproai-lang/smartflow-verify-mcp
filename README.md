# smartflow-verify-mcp

MCP server for [SmartFlow Observatory](https://verify.smartflowproai.com), an independent x402 observatory on Base that runs its own ledger of USDC micro-transfers. It gives any MCP-capable agent (Claude Code, Claude Desktop, Cursor, and others) two capabilities:

1. **Read the integrity-sealed decomposition of x402 network growth**: how much of the headline volume is wash or self-dealing activity, how much is ERC-4337 bundler plumbing, and how large the organic core really is. Free.
2. **Order a $399 signed, human-reviewed audit of any x402 endpoint or receiving wallet**, paid over x402: the order is verified and settled through the Coinbase facilitator (positive control: a 0.01 USDC test order settled on 6 Nov 2026, Base tx `0x7c115eb1f7fb56846d41f164d77eda41b58c6201abea710afa0672bcb18cdbe4`). No human needed on the buying side.

The server is a pure HTTP client of the public observatory API. It holds no keys, stores nothing locally, and **never moves funds**. Payment, if you choose to make one, happens entirely outside this server through your own wallet or x402 client.

Human-facing verification portal: <https://verify.smartflowproai.com>

## Installation

Requires Node.js 18 or newer.

### Claude Code

```bash
claude mcp add smartflow-verify -- npx -y smartflow-verify-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "smartflow-verify": {
      "command": "npx",
      "args": ["-y", "smartflow-verify-mcp"]
    }
  }
}
```

Restart Claude Desktop and the three tools appear under the `smartflow-verify` server.

### From a local checkout

```bash
npm install
claude mcp add smartflow-verify -- node /path/to/mcp/src/server.js
```

## Tools

### `get_network_decomposition` (free)

Input: none.

Output: the full sealed decomposition document plus fields added by this client:

- `data`: the dataset (30d / 7d / previous-7d windows; universe, bundler, facilitator, wash, and `clean_core` categories with tx counts, USDC volume, and unique payers; category overlaps; concentration checks; explicit limitations).
- `seal` and `seal_verified`: the server publishes a SHA-256 seal over the canonical JSON of `data`. This client recomputes it locally and reports whether it matches, so the numbers are tamper-evident end to end. The recipe is included in the response.
- `data_age_hours`: how stale the snapshot is. The dataset refreshes roughly daily.

Use this before trusting any headline x402 volume figure. Note the `clean_core` field is a dataset category name meaning: facilitator-settled transfers with no flagged conditions after the full 48h detection window. Figures reflect the observatory's ingest time, so the most recent hour of activity may be under-represented.

### `order_endpoint_audit` (creates a $399 payable order; the call itself is free)

Input:

- `target` (string): an x402 endpoint URL (`https://...`) or a receiving wallet address (`0x...`).
- `email` (string): where the signed audit report is delivered.

Output: an order id (`aud_` + 16 hex chars), plain-language payment instructions, and the raw x402 payment challenge (see payment flow below).

What you are buying: a signed, human-reviewed audit of the target covering wash-share, payer concentration, demand dispersion, and attribution, delivered by email within 48 business hours of payment.

**Calling this tool moves no funds.** It only creates an order and returns payment instructions. Unpaid orders are harmless and expire on their own within 24h.

### `get_audit_order_status` (free)

Input:

- `order_id` (string): the id returned by `order_endpoint_audit`.

Output: order state. `pending_payment` means no payment has been settled or detected yet; `paid: true` confirms the payment was settled through the facilitator or matched by exact amount; a delivered state means the signed report was emailed.

A facilitator-settled x402 payment is paid when the order POST returns 200. Plain-transfer detection reads Base USDC transfer logs and can lag a few minutes behind the chain; if you just paid that way, wait 2-5 minutes and poll again before assuming a problem.

## Free vs paid

| Tool | Cost |
|---|---|
| `get_network_decomposition` | free |
| `order_endpoint_audit` | free to call; creates a $399 payable order |
| `get_audit_order_status` | free |

Nothing in this package can spend money by itself. A purchase happens only if you (or your operator) send the quoted USDC amount from your own wallet.

## How the x402 payment flow works

1. `order_endpoint_audit` POSTs to the observatory API. The API answers **HTTP 402 Payment Required** with an x402 v2 challenge envelope. That 402 is the success path for order creation, not an error.
2. The challenge quotes a **per-order unique amount**: $399 plus a unique micro-USDC fraction, for example `399.002732` USDC. The fraction ties the payment to your order. **Pay the exact amount; do not round it.**
3. Pay in either way:
   - **x402 client** (the normal path): sign the `exact` scheme entry from the `accepts` array (network `eip155:8453`, USDC asset contract, `payTo` address are all in the challenge) and POST it back with the `PAYMENT-SIGNATURE` header. The API verifies the signed authorization with the Coinbase facilitator and settles it on Base in the same request; a `200` means the payment is settled and the order is paid. The facilitator pays the gas, so the paying wallet needs USDC only.
   - **Plain transfer** (fallback): send the exact USDC amount on Base to the `payTo` address from any wallet. The observatory matches it to your order by amount from Base USDC transfer logs, usually within minutes.
4. Poll `get_audit_order_status` with your order id. For a facilitator-settled payment the order is already paid when the POST returns; for a plain transfer, detection can lag a few minutes behind the chain.
5. Once paid, the signed audit report is prepared, human-reviewed, and emailed to the address you gave, within 48 business hours of payment.

Positive control, so you do not have to take the flow on faith: on 6 Nov 2026 a 0.01 USDC test order was verified and settled through the facilitator, Base tx `0x7c115eb1f7fb56846d41f164d77eda41b58c6201abea710afa0672bcb18cdbe4` (the public price stayed $399; the test amount was enabled for one allow-listed payer and switched off right after). Versions up to 0.1.2 described the audit as paid over x402 while payment was matched by exact-amount transfer only; facilitator verify-and-settle went live on 6 Nov 2026.

Safety rules built into the tool descriptions, worth repeating:

- If a payment submission times out, **poll status before paying again**. Never pay the same order twice.
- Unpaid orders expire within 24h and cost nothing.
- Agents with spend policies: creating an order is free, but paying it is a real $399 purchase. Confirm with your operator if your policy requires it.

## Example session

A typical agent conversation:

> **User:** Before I integrate with this x402 endpoint, is the network volume real? And get me an audit of https://api.example-x402-service.com/paywall
>
> **Agent** calls `get_network_decomposition`, checks `seal_verified: true`, and reports that a large share of headline volume carries wash flags while the organic core is far smaller, citing exact figures and the dataset's own limitations.
>
> **Agent** calls `order_endpoint_audit` with the target URL and the user's email, and relays the payment instructions: "Pay exactly 399.002732 USDC on Base to 0xd779...C893. The order id is aud_a80214548a0c4276. Unpaid orders expire in 24h."
>
> **User** pays from their wallet (or approves their agent's x402 client to pay).
>
> **Agent** polls `get_audit_order_status` until `paid: true`, then tells the user the signed report will arrive by email within 48 business hours.

## Configuration

- `SMARTFLOW_BASE_URL` (env var): overrides the API base. Default `https://verify.smartflowproai.com`.
- HTTP timeout is 25s per request; the server reports timeouts as retryable network errors and never retries payments on its own.

## Selftest (from a source checkout)

```bash
npm run selftest
```

Writes `selftest.log` with the full JSON-RPC exchange against the live API. The selftest creates one real unpaid test order for `https://example.com`; test orders are harmless and expire in 24h. The selftest never pays anything.

## License

MIT. See [LICENSE](LICENSE).
