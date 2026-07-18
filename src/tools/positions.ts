import { formatUnits, getContract, type Address } from "viem";
import { publicClient, KNOWN_TOKENS, resolveToken } from "../chain.js";
import { erc8056Abi } from "../abis.js";

const ONE_E18 = 10n ** 18n;

export type Position = {
  token: string;
  address: Address;
  symbol: string;
  rawBalance: string;
  uiMultiplier: string;
  uiBalance: string;
  appreciationPct: string | null;
};

/**
 * Read a wallet's stock-token positions. For each token we read the static raw
 * `balanceOf` and the ERC-8056 `uiMultiplier`, then compute the real total-return
 * balance (raw * multiplier / 1e18). The gap between raw and ui is the in-kind
 * yield + splits that the token has accrued — the value the on-chain UI shows
 * but that raw ERC-20 reads hide.
 */
export async function getPositions(
  wallet: Address,
  tokens?: string[],
): Promise<Position[]> {
  const client = publicClient();
  const entries = tokens?.length
    ? tokens.map((t) => [t.toUpperCase(), resolveToken(t)] as const)
    : (Object.entries(KNOWN_TOKENS) as [string, Address][]);

  const out: Position[] = [];
  for (const [label, address] of entries) {
    const c = getContract({ address, abi: erc8056Abi, client });

    const [rawBalance, decimals, symbol] = await Promise.all([
      c.read.balanceOf([wallet]),
      c.read.decimals().catch(() => 18),
      c.read.symbol().catch(() => label),
    ]);

    // uiMultiplier is optional — a plain ERC-20 (e.g. USDG) won't have it.
    let multiplier = ONE_E18;
    try {
      multiplier = await c.read.uiMultiplier();
    } catch {
      multiplier = ONE_E18;
    }

    if (rawBalance === 0n) continue;

    const uiBalanceRaw = (rawBalance * multiplier) / ONE_E18;
    const appreciation =
      multiplier > ONE_E18
        ? (((multiplier - ONE_E18) * 10000n) / ONE_E18).toString()
        : null;

    out.push({
      token: label,
      address,
      symbol: symbol as string,
      rawBalance: formatUnits(rawBalance, decimals as number),
      uiMultiplier: formatUnits(multiplier, 18),
      uiBalance: formatUnits(uiBalanceRaw, decimals as number),
      appreciationPct:
        appreciation === null
          ? null
          : (Number(appreciation) / 100).toFixed(2),
    });
  }
  return out;
}
