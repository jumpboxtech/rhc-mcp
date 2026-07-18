#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Address } from "viem";

import { walletClient, ADDRESSES, KNOWN_TOKENS, rpcUrl } from "./chain.js";
import { getPositions } from "./tools/positions.js";
import { quoteSwap } from "./tools/quote.js";
import { executeSwap } from "./tools/swap.js";

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
});

const server = new McpServer({ name: "rhc-mcp", version: "0.1.0" });

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 40-hex address");

server.registerTool(
  "rhc_info",
  {
    title: "Robinhood Chain info",
    description:
      "Chain, RPC, core contract addresses, known stock tokens, and whether this server can swap (a signing key is configured) or is read-only.",
    inputSchema: {},
  },
  async () => {
    const w = walletClient();
    return json({
      chain: "Robinhood Chain (Arbitrum Orbit)",
      chainId: 4663,
      rpc: rpcUrl(),
      explorer: "https://robinhoodchain.blockscout.com",
      contracts: ADDRESSES,
      knownTokens: KNOWN_TOKENS,
      swapEnabled: Boolean(w && process.env.RHCSWAP_ADDRESS),
      signer: w ? w.account : null,
      note: "Stock tokens are ERC-8056 total-return tokens: raw balanceOf is static; uiMultiplier() scales it to the real value.",
    });
  },
);

server.registerTool(
  "get_positions",
  {
    title: "Get stock-token positions",
    description:
      "Read a wallet's Robinhood Chain stock-token positions. Returns raw balance, uiMultiplier, the real total-return balance (raw * multiplier / 1e18), and the accrued appreciation % that raw ERC-20 reads hide. Omit `tokens` to scan the known-token registry.",
    inputSchema: {
      wallet: addressSchema.describe("wallet address to inspect"),
      tokens: z
        .array(z.string())
        .optional()
        .describe("token symbols or 0x addresses; omit to scan known tokens"),
    },
  },
  async ({ wallet, tokens }) => {
    try {
      return json(await getPositions(wallet as Address, tokens));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "quote_swap",
  {
    title: "Quote a swap",
    description:
      "Quote an exact-input single-hop swap through the Uniswap v4 Quoter on Robinhood Chain. Proves the pool has liquidity and sizes minAmountOut before executing. Reverts if there is no/thin pool for the given fee + tickSpacing.",
    inputSchema: {
      tokenIn: z.string().describe("input token symbol or 0x address"),
      tokenOut: z.string().describe("output token symbol or 0x address"),
      amountIn: z.string().describe("human-readable input amount, e.g. \"1\" or \"0.5\""),
      fee: z.number().optional().describe("pool fee (default 3000 = 0.3%)"),
      tickSpacing: z.number().optional().describe("pool tick spacing (default 60)"),
    },
  },
  async ({ tokenIn, tokenOut, amountIn, fee, tickSpacing }) => {
    try {
      return json(await quoteSwap(tokenIn, tokenOut, amountIn, fee, tickSpacing));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "execute_swap",
  {
    title: "Execute a swap",
    description:
      "Execute an exact-input single-hop swap via the RHCSwap helper. SAFETY: dryRun defaults to true (returns the plan without sending); amountIn is capped by RHC_MAX_SWAP_AMOUNT; a real minAmountOut is always enforced (from the arg or a fresh quote minus slippageBps). Requires RHC_PRIVATE_KEY and RHCSWAP_ADDRESS to actually send.",
    inputSchema: {
      tokenIn: z.string().describe("input token symbol or 0x address"),
      tokenOut: z.string().describe("output token symbol or 0x address"),
      amountIn: z.string().describe("human-readable input amount"),
      minAmountOut: z
        .string()
        .optional()
        .describe("explicit minimum output (human units); overrides slippageBps"),
      slippageBps: z
        .number()
        .optional()
        .describe("slippage tolerance in bps when minAmountOut omitted (default 50 = 0.5%)"),
      fee: z.number().optional().describe("pool fee (default 3000)"),
      tickSpacing: z.number().optional().describe("pool tick spacing (default 60)"),
      recipient: addressSchema.optional().describe("output recipient (default: the signer)"),
      dryRun: z
        .boolean()
        .optional()
        .describe("default true; set false to actually send the transaction"),
    },
  },
  async (args) => {
    try {
      return json(await executeSwap(args));
    } catch (e) {
      return fail(e);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP channel.
  process.stderr.write("rhc-mcp server running on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
