import { formatUnits, parseUnits, getContract, type Address } from "viem";
import { publicClient, ADDRESSES, resolveToken } from "../chain.js";
import { erc8056Abi, quoterAbi } from "../abis.js";
import { buildPoolKey } from "../pool.js";

export type Quote = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  amountOut: string;
  amountOutRaw: string;
  fee: number;
  tickSpacing: number;
};

/**
 * Quote an exact-input single-hop swap through the v4 Quoter (which simulates
 * the real swap on-chain and reverts with the result — viem decodes it). Use
 * this to size `minAmountOut` before calling execute_swap. Confirms the pool
 * actually has liquidity; a revert here means no/thin pool for those params.
 */
export async function quoteSwap(
  tokenInArg: string,
  tokenOutArg: string,
  humanAmountIn: string,
  fee = 3000,
  tickSpacing = 60,
): Promise<Quote> {
  const client = publicClient();
  const tokenIn = resolveToken(tokenInArg);
  const tokenOut = resolveToken(tokenOutArg);

  const [decIn, decOut] = await Promise.all([
    getContract({ address: tokenIn, abi: erc8056Abi, client })
      .read.decimals()
      .catch(() => 18),
    getContract({ address: tokenOut, abi: erc8056Abi, client })
      .read.decimals()
      .catch(() => 18),
  ]);

  const amountIn = parseUnits(humanAmountIn, decIn as number);
  const { key, zeroForOne } = buildPoolKey(tokenIn, tokenOut, fee, tickSpacing);

  const { result } = await client.simulateContract({
    address: ADDRESSES.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: key,
        zeroForOne,
        exactAmount: amountIn,
        hookData: "0x",
      },
    ],
  });

  const amountOut = result[0] as bigint;

  return {
    tokenIn,
    tokenOut,
    amountIn: humanAmountIn,
    amountOut: formatUnits(amountOut, decOut as number),
    amountOutRaw: amountOut.toString(),
    fee,
    tickSpacing,
  };
}
