// Chain constants and address helpers shared by the deploy scripts, the relayer and the app.

import { defineChain, getAddress, type Address, type Hex } from 'viem';
import { bscTestnet } from 'viem/chains';

export const PORTALDOT_CHAIN_ID = 420420777;
export const BSC_CHAIN_ID = 97;

export const PORTALDOT_EVM_RPC = 'https://test-evm-rpc-v3.portaldot.dev';
export const PORTALDOT_SUBSTRATE_WS = 'wss://test-node-v3.portaldot.dev';
export const BSC_RPC = 'https://bsc-testnet-rpc.publicnode.com';
export const BSC_RPC_FALLBACK = 'https://data-seed-prebsc-1-s1.bnbchain.org:8545';

/** Native tPOT has 14 decimals while revive's msg.value has 18: one planck is 1e4 wei-units. */
export const NATIVE_UNIT = 10_000n;

export const portaldotTestnet = defineChain({
  id: PORTALDOT_CHAIN_ID,
  name: 'Portaldot V3 testnet',
  nativeCurrency: { name: 'Portaldot', symbol: 'tPOT', decimals: 18 },
  rpcUrls: { default: { http: [PORTALDOT_EVM_RPC] } },
});

export { bscTestnet };

export type ChainName = 'portaldot' | 'bsc';

export function chainIdOf(name: ChainName): number {
  return name === 'portaldot' ? PORTALDOT_CHAIN_ID : BSC_CHAIN_ID;
}

/**
 * Address of the pallet-assets ERC-20 precompile for `assetId`:
 * `assetId` as a big-endian u32, twelve zero bytes, then `0x00010000`.
 */
export function assetPrecompile(assetId: number): Address {
  if (!Number.isInteger(assetId) || assetId < 0 || assetId > 0xffffffff) throw new RangeError(`bad asset id ${assetId}`);
  return getAddress(`0x${assetId.toString(16).padStart(8, '0')}${'0'.repeat(24)}00010000`);
}

/** Substrate AccountId32 of an EVM address on revive: h160 ‖ 0xEE×12. */
export function accountId32Of(h160: Address): Hex {
  return `0x${getAddress(h160).slice(2).toLowerCase()}${'ee'.repeat(12)}`;
}

/** Rounds a native amount down to a whole tPOT planck (multiple of 1e4 wei-units). */
export function toNativeUnit(wei: bigint): bigint {
  return wei - (wei % NATIVE_UNIT);
}

export function txLink(chain: ChainName, hash: Hex, blockNumber?: bigint | number): string {
  if (chain === 'bsc') return `https://testnet.bscscan.com/tx/${hash}`;
  // No EVM explorer on the Portaldot testnet: link the block in polkadot.js apps.
  const rpc = encodeURIComponent(PORTALDOT_SUBSTRATE_WS);
  return blockNumber !== undefined
    ? `https://polkadot.js.org/apps/?rpc=${rpc}#/explorer/query/${blockNumber}`
    : `https://polkadot.js.org/apps/?rpc=${rpc}#/explorer`;
}

export function addressLink(chain: ChainName, address: Address): string | undefined {
  return chain === 'bsc' ? `https://testnet.bscscan.com/address/${address}` : undefined;
}
