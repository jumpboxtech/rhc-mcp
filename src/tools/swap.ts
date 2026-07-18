import {
  formatUnits,
  parseUnits,
  getContract,
  type Address,
  type Hex,
} from "viem";
import {
  publicClient,
  walletClient,
  resolveToken,
} from "../chain.js";
import { erc8056Abi, rhcSwapAbi } from "../abis.js";
import { buildPoolKey } from "../pool.js";
import { quoteSwap } from "./quote.js";

export type SwapPlan = {
  executed: boolean;
  reason?: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  expectedOut: string;
  minAmountOut: string;
  recipient: Address;
  fee: number;
  tickSpacing: number;
  approvalTx?: Hex;
  swapTx?: Hex;
  status?: string;
};

function maxSwapAmount(): number {
  const v = Number(process.env.RHC_MAX_SWAP_AMOUNT ?? "1");
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Execute (or dry-run) an exact-input single-hop swap via the RHCSwap helper.
 *
 * Safety model — this tool moves real funds, so it is deliberately locked down:
 *  - the signing key comes ONLY from RHC_PRIVATE_KEY, never a tool argument;
 *  - `dryRun` defaults to TRUE — nothing is sent unless the caller opts in;
 *  - `amountIn` is capped by RHC_MAX_SWAP_AMOUNT (whole input tokens);
 *  - a real `minAmountOut` is always enforced (from the arg, or derived from a
 *    fresh quote minus `slippageBps`) — the on-chain price limit gives none;
 *  - the plan (expected out, min out, recipient) is always returned so the
 *    agent/user can see exactly what will happen before executing.
 */
export async function executeSwap(opts: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut?: string;
  slippageBps?: number;
  fee?: number;
  tickSpacing?: number;
  recipient?: string;
  dryRun?: boolean;
}): Promise<SwapPlan> {
  const fee = opts.fee ?? 3000;
  const tickSpacing = opts.tickSpacing ?? 60;
  const slippageBps = opts.slippageBps ?? 50;
  const dryRun = opts.dryRun !== false; // default true

  const pub = publicClient();
  const tokenIn = resolveToken(opts.tokenIn);
  const tokenOut = resolveToken(opts.tokenOut);

  const rhcSwap = process.env.RHCSWAP_ADDRESS as Address | undefined;
  const wallet = walletClient();

  const decIn = (await getContract({ address: tokenIn, abi: erc8056Abi, client: pub })
    .read.decimals()
    .catch(() => 18)) as number;

  // Guard: hard cap on input size.
  if (Number(opts.amountIn) > maxSwapAmount()) {
    throw new Error(
      `amountIn ${opts.amountIn} exceeds RHC_MAX_SWAP_AMOUNT=${maxSwapAmount()}. Raise the cap deliberately to proceed.`,
    );
  }

  const amountIn = parseUnits(opts.amountIn, decIn);

  // Always quote first — proves the pool exists and sizes minOut.
  const quote = await quoteSwap(opts.tokenIn, opts.tokenOut, opts.amountIn, fee, tickSpacing);
  const expectedOutRaw = BigInt(quote.amountOutRaw);

  let minOutRaw: bigint;
  if (opts.minAmountOut !== undefined) {
    const decOut = (await getContract({ address: tokenOut, abi: erc8056Abi, client: pub })
      .read.decimals()
      .catch(() => 18)) as number;
    minOutRaw = parseUnits(opts.minAmountOut, decOut);
  } else {
    minOutRaw = (expectedOutRaw * BigInt(10000 - slippageBps)) / 10000n;
  }

  const decOut = (await getContract({ address: tokenOut, abi: erc8056Abi, client: pub })
    .read.decimals()
    .catch(() => 18)) as number;

  const recipient = (opts.recipient as Address) ?? wallet?.account;

  const plan: SwapPlan = {
    executed: false,
    tokenIn,
    tokenOut,
    amountIn: opts.amountIn,
    expectedOut: quote.amountOut,
    minAmountOut: formatUnits(minOutRaw, decOut),
    recipient: recipient as Address,
    fee,
    tickSpacing,
  };

  if (dryRun) {
    plan.reason = "dry run — set dryRun:false to execute";
    return plan;
  }

  // ---- from here on, we send real transactions ----
  if (!wallet) {
    plan.reason = "no RHC_PRIVATE_KEY configured — server is read-only";
    return plan;
  }
  if (!rhcSwap) {
    plan.reason = "no RHCSWAP_ADDRESS configured — deploy github.com/jumpboxtech/rhcswap and set it";
    return plan;
  }
  if (!recipient) {
    plan.reason = "no recipient resolved";
    return plan;
  }

  const { key, zeroForOne } = buildPoolKey(tokenIn, tokenOut, fee, tickSpacing);

  // Ensure the RHCSwap helper can pull tokenIn.
  const inToken = getContract({ address: tokenIn, abi: erc8056Abi, client: pub });
  const allowance = (await inToken.read.allowance([wallet.account, rhcSwap])) as bigint;
  if (allowance < amountIn) {
    const approvalTx = await wallet.client.writeContract({
      address: tokenIn,
      abi: erc8056Abi,
      functionName: "approve",
      args: [rhcSwap, amountIn],
      account: wallet.client.account!,
      chain: wallet.client.chain,
    });
    plan.approvalTx = approvalTx;
    await pub.waitForTransactionReceipt({ hash: approvalTx });
  }

  const swapTx = await wallet.client.writeContract({
    address: rhcSwap,
    abi: rhcSwapAbi,
    functionName: "swap",
    args: [key, zeroForOne, amountIn, minOutRaw, recipient],
    account: wallet.client.account!,
    chain: wallet.client.chain,
  });
  plan.swapTx = swapTx;

  const receipt = await pub.waitForTransactionReceipt({ hash: swapTx });
  plan.executed = receipt.status === "success";
  plan.status = receipt.status;
  return plan;
}
