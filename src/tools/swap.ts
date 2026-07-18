import {
  formatUnits,
  parseUnits,
  getContract,
  maxUint256,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { publicClient, walletClient, resolveToken, ADDRESSES } from "../chain.js";
import { erc8056Abi, permit2Abi, universalRouterAbi } from "../abis.js";
import { buildPoolKey } from "../pool.js";
import { encodeExactInputSingle } from "../v4.js";
import { quoteSwap } from "./quote.js";

export type SwapPlan = {
  executed: boolean;
  reason?: string;
  route: "universal-router";
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  expectedOut: string;
  minAmountOut: string;
  recipient: Address | null;
  fee: number;
  tickSpacing: number;
  approvalsNeeded: string[] | null;
  approvalTxs?: Hex[];
  swapTx?: Hex;
  status?: string;
};

function maxSwapAmount(): number {
  const v = Number(process.env.RHC_MAX_SWAP_AMOUNT ?? "1");
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Execute (or dry-run) an exact-input single-hop swap through Robinhood Chain's
 * Uniswap v4 UniversalRouter — no deployed helper contract required. The calldata
 * is standard v4 (SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL), verified
 * byte-identical to real on-chain swaps. Output is taken to the signer.
 *
 * Safety model (unchanged, this moves real funds):
 *  - the signing key comes ONLY from RHC_PRIVATE_KEY, never a tool argument;
 *  - `dryRun` defaults to TRUE — nothing is sent unless the caller opts in;
 *  - `amountIn` is capped by RHC_MAX_SWAP_AMOUNT (whole input tokens);
 *  - a real `minAmountOut` is always enforced (arg, or a fresh quote minus slippage);
 *  - ERC-20 input flows through Permit2; the dry-run reports which approvals a real
 *    run would send, and Permit2→router allowance is scoped to `amountIn` + a short
 *    expiry (not an unbounded standing grant).
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
  const isNativeIn = tokenIn.toLowerCase() === zeroAddress;

  const wallet = walletClient();
  const signer = wallet?.account ?? null;

  // Guard: hard cap on input size.
  if (Number(opts.amountIn) > maxSwapAmount()) {
    throw new Error(
      `amountIn ${opts.amountIn} exceeds RHC_MAX_SWAP_AMOUNT=${maxSwapAmount()}. Raise the cap deliberately to proceed.`,
    );
  }

  // TAKE_ALL delivers to the router's caller (the signer); custom recipients would
  // need a different action and aren't supported on this minimal path.
  if (opts.recipient && signer && opts.recipient.toLowerCase() !== signer.toLowerCase()) {
    throw new Error(
      "custom recipient not supported on the router path (output is taken to the signer).",
    );
  }

  const decIn = (await getContract({ address: tokenIn, abi: erc8056Abi, client: pub })
    .read.decimals()
    .catch(() => 18)) as number;
  const decOut = (await getContract({ address: tokenOut, abi: erc8056Abi, client: pub })
    .read.decimals()
    .catch(() => 18)) as number;

  const amountIn = parseUnits(opts.amountIn, decIn);

  // Always quote first — proves the pool exists and sizes minOut.
  const quote = await quoteSwap(opts.tokenIn, opts.tokenOut, opts.amountIn, fee, tickSpacing);
  const expectedOutRaw = BigInt(quote.amountOutRaw);
  const minOutRaw =
    opts.minAmountOut !== undefined
      ? parseUnits(opts.minAmountOut, decOut)
      : (expectedOutRaw * BigInt(10000 - slippageBps)) / 10000n;

  // Figure out which approvals a real run needs (only knowable with an owner address).
  let approvalsNeeded: string[] | null = null;
  if (signer && !isNativeIn) {
    approvalsNeeded = await computeApprovalsNeeded(signer, tokenIn, amountIn);
  } else if (isNativeIn) {
    approvalsNeeded = [];
  }

  const plan: SwapPlan = {
    executed: false,
    route: "universal-router",
    router: ADDRESSES.universalRouter,
    tokenIn,
    tokenOut,
    amountIn: opts.amountIn,
    expectedOut: quote.amountOut,
    minAmountOut: formatUnits(minOutRaw, decOut),
    recipient: signer,
    fee,
    tickSpacing,
    approvalsNeeded,
  };

  if (dryRun) {
    plan.reason = "dry run — set dryRun:false to execute";
    return plan;
  }

  if (!wallet) {
    plan.reason = "no RHC_PRIVATE_KEY configured — server is read-only";
    return plan;
  }

  const { key, zeroForOne } = buildPoolKey(tokenIn, tokenOut, fee, tickSpacing);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

  // ---- ensure Permit2 plumbing for ERC-20 input ----
  const approvalTxs: Hex[] = [];
  if (!isNativeIn) {
    approvalTxs.push(...(await ensurePermit2(wallet, tokenIn, amountIn)));
  }
  plan.approvalTxs = approvalTxs;

  const data = encodeExactInputSingle({
    key,
    zeroForOne,
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut: minOutRaw,
    deadline,
  });

  const swapTx = await wallet.client.sendTransaction({
    account: wallet.client.account!,
    chain: wallet.client.chain,
    to: ADDRESSES.universalRouter,
    data,
    value: isNativeIn ? amountIn : 0n,
  });
  plan.swapTx = swapTx;

  const receipt = await pub.waitForTransactionReceipt({ hash: swapTx });
  plan.executed = receipt.status === "success";
  plan.status = receipt.status;
  return plan;
}

const PERMIT2_EXPIRY_SECONDS = 3600n;

async function computeApprovalsNeeded(
  owner: Address,
  tokenIn: Address,
  amountIn: bigint,
): Promise<string[]> {
  const pub = publicClient();
  const needed: string[] = [];

  const erc20Allowance = (await getContract({ address: tokenIn, abi: erc8056Abi, client: pub })
    .read.allowance([owner, ADDRESSES.permit2])) as bigint;
  if (erc20Allowance < amountIn) needed.push("ERC-20 approve: token → Permit2 (one-time)");

  const [p2Amount, p2Expiration] = (await getContract({
    address: ADDRESSES.permit2,
    abi: permit2Abi,
    client: pub,
  }).read.allowance([owner, tokenIn, ADDRESSES.universalRouter])) as [bigint, number, number];
  const now = Math.floor(Date.now() / 1000);
  if (p2Amount < amountIn || Number(p2Expiration) <= now) {
    needed.push("Permit2 approve: token → UniversalRouter (scoped to amountIn, ~1h)");
  }
  return needed;
}

async function ensurePermit2(
  wallet: { client: NonNullable<ReturnType<typeof walletClient>>["client"]; account: Address },
  tokenIn: Address,
  amountIn: bigint,
): Promise<Hex[]> {
  const pub = publicClient();
  const txs: Hex[] = [];
  const account = wallet.client.account!;
  const chain = wallet.client.chain;

  // 1) token → Permit2 (max, one-time)
  const erc20Allowance = (await getContract({ address: tokenIn, abi: erc8056Abi, client: pub })
    .read.allowance([wallet.account, ADDRESSES.permit2])) as bigint;
  if (erc20Allowance < amountIn) {
    const tx = await wallet.client.writeContract({
      address: tokenIn,
      abi: erc8056Abi,
      functionName: "approve",
      args: [ADDRESSES.permit2, maxUint256],
      account,
      chain,
    });
    txs.push(tx);
    await pub.waitForTransactionReceipt({ hash: tx });
  }

  // 2) Permit2 → UniversalRouter (scoped to amountIn + short expiry)
  const [p2Amount, p2Expiration] = (await getContract({
    address: ADDRESSES.permit2,
    abi: permit2Abi,
    client: pub,
  }).read.allowance([wallet.account, tokenIn, ADDRESSES.universalRouter])) as [
    bigint,
    number,
    number,
  ];
  const now = Math.floor(Date.now() / 1000);
  if (p2Amount < amountIn || Number(p2Expiration) <= now) {
    const expiration = BigInt(now) + PERMIT2_EXPIRY_SECONDS;
    const tx = await wallet.client.writeContract({
      address: ADDRESSES.permit2,
      abi: permit2Abi,
      functionName: "approve",
      args: [tokenIn, ADDRESSES.universalRouter, amountIn, Number(expiration)],
      account,
      chain,
    });
    txs.push(tx);
    await pub.waitForTransactionReceipt({ hash: tx });
  }
  return txs;
}
