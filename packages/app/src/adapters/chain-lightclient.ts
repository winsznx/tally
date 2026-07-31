/**
 * Light-client chain adapter — @nimiq/core as WASM. Lazy-loaded so it never
 * blocks first paint (the 60-second onboarding target is scored). Used for
 * verification and live updates (addTransactionListener); RPC serves the hot
 * read path. Nothing is `confirmed` before the transaction reaches macro
 * finality — the client reports that directly via the transaction state.
 *
 * Not unit-tested here (it needs the browser + wasm + network); it is exercised
 * in the on-device pass. The pure logic it depends on lives in RpcChain and the
 * core, which are fully tested.
 */
import type { Client, PlainTransactionDetails } from '@nimiq/core';
import { MAINNET, TESTNET, type ChainAdapter, type ChainTx, type NetworkId } from './types.js';

type Core = typeof import('@nimiq/core');

export interface LightClientOptions {
  network: 'TestAlbatross' | 'MainAlbatross';
}

export class LightClientChain implements ChainAdapter {
  #core: Core | undefined;
  #client: Client | undefined;
  #ready: Promise<Client> | undefined;

  constructor(private readonly opts: LightClientOptions) {}

  /** Kick off wasm load + consensus. Callers await this off the hot path. */
  start(): Promise<Client> {
    this.#ready ??= this.#boot().catch((e) => {
      this.#ready = undefined; // allow retry after a transient failure
      throw e;
    });
    return this.#ready;
  }

  async #boot(): Promise<Client> {
    const core = (this.#core = await import('@nimiq/core'));
    const config = new core.ClientConfiguration();
    config.network(this.opts.network);
    config.logLevel('warn');
    const client = (this.#client = await core.Client.create(config.build()));
    await client.waitForConsensusEstablished();
    return client;
  }

  async #c(): Promise<Client> {
    return this.start();
  }

  async headHeight(): Promise<number> {
    return (await this.#c()).getHeadHeight();
  }

  async networkId(): Promise<NetworkId> {
    const id = await (await this.#c()).getNetworkId();
    return id === MAINNET ? MAINNET : TESTNET;
  }

  async getBalance(address: string): Promise<bigint> {
    const acct = await (await this.#c()).getAccount(address);
    return acct.type === 'basic' ? BigInt(acct.balance) : 0n;
  }

  async getTransactionsByAddress(address: string, max = 100, startAt: string | null = null): Promise<ChainTx[]> {
    const client = await this.#c();
    const txs = await client.getTransactionsByAddress(address, undefined, undefined, startAt ?? undefined, max);
    return txs.map(toChainTx);
  }

  async getTransactionByHash(hash: string): Promise<ChainTx | null> {
    try {
      return toChainTx(await (await this.#c()).getTransaction(hash));
    } catch {
      return null;
    }
  }

  async broadcast(serializedHex: string): Promise<{ hash: string }> {
    const det = await (await this.#c()).sendTransaction(serializedHex);
    return { hash: det.transactionHash };
  }

  async subscribe(addresses: string[], onTx: (tx: ChainTx) => void): Promise<() => void> {
    const client = await this.#c();
    const handle = await client.addTransactionListener((tx) => onTx(toChainTx(tx)), addresses);
    return () => void client.removeListener(handle);
  }
}

function toChainTx(tx: PlainTransactionDetails): ChainTx {
  return {
    hash: tx.transactionHash.toLowerCase(),
    sender: tx.sender,
    recipient: tx.recipient,
    value: BigInt(tx.value),
    validityStartHeight: tx.validityStartHeight,
    blockHeight: tx.blockHeight,
    // The client's own finality signal — never "settled" before this.
    confirmed: tx.state === 'confirmed',
    dataHex: tx.data.type === 'raw' ? tx.data.raw : undefined,
  };
}
