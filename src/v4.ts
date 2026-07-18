import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import { universalRouterAbi } from "./abis.js";
import type { PoolKey } from "./pool.js";

// UniversalRouter command + v4 action opcodes.
const CMD_V4_SWAP = "0x10";
const ACTION_SWAP_EXACT_IN_SINGLE = "06";
const ACTION_SETTLE_ALL = "0c";
const ACTION_TAKE_ALL = "0f";

// Robinhood Chain's ExactInputSingleParams. It is the standard Uniswap v4 struct
// PLUS one extra field, `minHopPriceX36` (uint256), inserted between
// amountOutMinimum and hookData. This is the chain's fork of the v4 swap struct —
// omitting it (as the stock Uniswap SDK does) makes the calldata one word short
// and the router reverts. It is 0 in normal swaps (no per-hop price floor);
// verified byte-identical to real on-chain swaps.
const EXACT_IN_SINGLE = [
  {
    type: "tuple",
    components: [
      {
        type: "tuple",
        components: [
          { type: "address" },
          { type: "address" },
          { type: "uint24" },
          { type: "int24" },
          { type: "address" },
        ],
      },
      { type: "bool" },
      { type: "uint128" },
      { type: "uint128" },
      { type: "uint256" }, // minHopPriceX36 — RHC-specific
      { type: "bytes" },
    ],
  },
] as const;

const CURRENCY_AMOUNT = [{ type: "address" }, { type: "uint256" }] as const;
const V4_SWAP_INPUT = [{ type: "bytes" }, { type: "bytes[]" }] as const;

/**
 * Build the exact `execute()` calldata a standard Uniswap v4 exact-input single-hop
 * swap produces on Robinhood Chain: one V4_SWAP command whose actions are
 * SWAP_EXACT_IN_SINGLE → SETTLE_ALL(tokenIn) → TAKE_ALL(tokenOut). Output is taken
 * to the router's caller (the signer). This encoding was verified byte-identical to
 * real on-chain swaps through the live UniversalRouter.
 */
export function encodeExactInputSingle(params: {
  key: PoolKey;
  zeroForOne: boolean;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
  minHopPriceX36?: bigint;
}): Hex {
  const { key, zeroForOne, tokenIn, tokenOut, amountIn, minAmountOut, deadline } = params;
  const minHopPriceX36 = params.minHopPriceX36 ?? 0n;

  const actions = `0x${ACTION_SWAP_EXACT_IN_SINGLE}${ACTION_SETTLE_ALL}${ACTION_TAKE_ALL}` as Hex;

  const swapParams = encodeAbiParameters(EXACT_IN_SINGLE, [
    [
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      zeroForOne,
      amountIn,
      minAmountOut,
      minHopPriceX36,
      "0x",
    ],
  ]);
  const settleParams = encodeAbiParameters(CURRENCY_AMOUNT, [tokenIn, amountIn]);
  const takeParams = encodeAbiParameters(CURRENCY_AMOUNT, [tokenOut, minAmountOut]);

  const v4Input = encodeAbiParameters(V4_SWAP_INPUT, [
    actions,
    [swapParams, settleParams, takeParams],
  ]);

  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [CMD_V4_SWAP as Hex, [v4Input], deadline],
  });
}
