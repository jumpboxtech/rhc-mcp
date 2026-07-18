import type { Address } from "viem";

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Build a canonical v4 PoolKey from an unordered token pair. v4 requires
 * currency0 < currency1 by address. Returns the key plus `zeroForOne` for a
 * `tokenIn -> tokenOut` swap so callers don't have to reason about ordering.
 */
export function buildPoolKey(
  tokenIn: Address,
  tokenOut: Address,
  fee: number,
  tickSpacing: number,
  hooks: Address = ZERO,
): { key: PoolKey; zeroForOne: boolean } {
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  if (inLower === outLower) throw new Error("tokenIn and tokenOut are the same");

  const inIsZero = inLower < outLower;
  const currency0 = (inIsZero ? tokenIn : tokenOut) as Address;
  const currency1 = (inIsZero ? tokenOut : tokenIn) as Address;

  return {
    key: { currency0, currency1, fee, tickSpacing, hooks },
    // zeroForOne = selling currency0. If tokenIn is currency0, that's true.
    zeroForOne: inIsZero,
  };
}
