import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Robinhood Chain — Arbitrum Orbit L2, chain id 4663. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

/** Canonical Uniswap v4 + core contracts on Robinhood Chain. */
export const ADDRESSES = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
} as const satisfies Record<string, Address>;

/**
 * A small starter registry of known Robinhood Chain stock tokens. This is not
 * exhaustive — pass any token address to the tools directly. Stock tokens are
 * ERC-8056 total-return tokens: raw `balanceOf` is static, and `uiMultiplier()`
 * (1e18-scaled) grows as in-kind dividends reinvest and on splits.
 */
export const KNOWN_TOKENS: Record<string, Address> = {
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
};

export function rpcUrl(): string {
  return process.env.RHC_RPC_URL || robinhoodChain.rpcUrls.default.http[0];
}

export function publicClient(): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(rpcUrl()),
  });
}

/**
 * A wallet client for sending swaps, or null if no key is configured. The key
 * is read ONLY from RHC_PRIVATE_KEY and is never accepted as a tool argument,
 * returned, or logged. No key -> the server is read-only.
 */
export function walletClient(): { client: WalletClient; account: Address } | null {
  const pk = process.env.RHC_PRIVATE_KEY;
  if (!pk) return null;
  const account = privateKeyToAccount(
    (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`,
  );
  const client = createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(rpcUrl()),
  });
  return { client, account: account.address };
}

/** Resolve a symbol from the starter registry, or accept a raw 0x address. */
export function resolveToken(symbolOrAddress: string): Address {
  const upper = symbolOrAddress.toUpperCase();
  if (KNOWN_TOKENS[upper]) return KNOWN_TOKENS[upper];
  if (/^0x[0-9a-fA-F]{40}$/.test(symbolOrAddress)) {
    return symbolOrAddress as Address;
  }
  throw new Error(
    `Unknown token "${symbolOrAddress}". Pass a 0x address or one of: ${Object.keys(KNOWN_TOKENS).join(", ")}`,
  );
}
