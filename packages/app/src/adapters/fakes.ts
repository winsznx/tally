/**
 * In-memory fakes for every adapter, so flows and the state layer are testable
 * with no phone and no network. These are test doubles, not production code.
 */
import {
  DECLINED,
  ok,
  providerError,
  type BasicTxParams,
  type BasicTxWithDataParams,
  type ChainAdapter,
  type ChainTx,
  type NetworkId,
  type ProviderAdapter,
  type ProviderResult,
  type RelayAdapter,
  type RelayEntry,
  type SignatureResult,
  type WalletTx,
} from './types.js';

export class FakeProvider implements ProviderAdapter {
  insideNimiqPay = true;
  language: string | undefined = 'en';
  detectedNetworkId: number | undefined;
  /** Queue outcomes for the next calls; default is to succeed. */
  nextOutcome: 'ok' | 'declined' | 'error' = 'ok';
  signImpl?: (message: string) => SignatureResult;
  sendImpl?: (p: BasicTxParams | BasicTxWithDataParams) => WalletTx;

  async init(): Promise<{ insideNimiqPay: boolean; language: string | undefined }> {
    return { insideNimiqPay: this.insideNimiqPay, language: this.language };
  }
  accounts: string[] = ['NQ00 FAKE'];
  async listAccounts(): Promise<ProviderResult<string[]>> {
    if (this.nextOutcome === 'declined') return DECLINED;
    if (this.nextOutcome === 'error') return providerError('fake error');
    return ok(this.accounts);
  }
  async sign(message: string): Promise<ProviderResult<SignatureResult>> {
    if (this.nextOutcome === 'declined') return DECLINED;
    if (this.nextOutcome === 'error') return providerError('fake error');
    return ok(this.signImpl ? this.signImpl(message) : { publicKey: '00'.repeat(32), signature: '00'.repeat(64) });
  }
  async sendBasicTransaction(p: BasicTxParams): Promise<ProviderResult<WalletTx>> {
    return this.#send(p);
  }
  async sendBasicTransactionWithData(p: BasicTxWithDataParams): Promise<ProviderResult<WalletTx>> {
    return this.#send(p);
  }
  async #send(p: BasicTxParams | BasicTxWithDataParams): Promise<ProviderResult<WalletTx>> {
    if (this.nextOutcome === 'declined') return DECLINED;
    if (this.nextOutcome === 'error') return providerError('fake error');
    const tx = this.sendImpl
      ? this.sendImpl(p)
      : {
          serializedHex: 'ab',
          hash: 'cd'.repeat(32),
          sender: 'NQ00 FAKE',
          recipient: p.recipient,
          value: p.value,
          fee: p.fee ?? 0n,
          validityStartHeight: p.validityStartHeight ?? 0,
          networkId: 5,
          dataHex: '',
        };
    this.detectedNetworkId = tx.networkId;
    return ok(tx);
  }
}

export class FakeChain implements ChainAdapter {
  head = 1000;
  balances = new Map<string, bigint>();
  txs: ChainTx[] = [];
  broadcastLog: string[] = [];
  #net: NetworkId;
  constructor(net: NetworkId = 5) {
    this.#net = net;
  }
  async headHeight(): Promise<number> {
    return this.head;
  }
  async networkId(): Promise<NetworkId> {
    return this.#net;
  }
  async getBalance(address: string): Promise<bigint> {
    return this.balances.get(address) ?? 0n;
  }
  async getTransactionsByAddress(address: string): Promise<ChainTx[]> {
    return this.txs.filter((t) => t.sender === address || t.recipient === address);
  }
  async getTransactionByHash(hash: string): Promise<ChainTx | null> {
    return this.txs.find((t) => t.hash === hash) ?? null;
  }
  async broadcast(serializedHex: string): Promise<{ hash: string }> {
    this.broadcastLog.push(serializedHex);
    return { hash: `hash:${serializedHex}` };
  }
}

export class FakeRelay implements RelayAdapter {
  ledgers = new Map<string, { network: NetworkId; entries: RelayEntry[]; head: string | null }>();
  #seq = 0;
  reachable = true;

  async createLedger(network: NetworkId): Promise<{ ledgerId: string; network: NetworkId }> {
    this.#assertReachable();
    const ledgerId = `ledger-${++this.#seq}`;
    this.ledgers.set(ledgerId, { network, entries: [], head: null });
    return { ledgerId, network };
  }
  async getHead(ledgerId: string): Promise<string | null> {
    this.#assertReachable();
    return this.ledgers.get(ledgerId)?.head ?? null;
  }
  async getSince(ledgerId: string, sinceHash: string | null): Promise<RelayEntry[]> {
    this.#assertReachable();
    const l = this.ledgers.get(ledgerId);
    if (!l) return [];
    if (sinceHash === null) return [...l.entries];
    const idx = l.entries.findIndex((e) => e.entryId === sinceHash);
    return idx < 0 ? [...l.entries] : l.entries.slice(idx + 1);
  }
  async append(ledgerId: string, entriesJson: string[]): Promise<void> {
    this.#assertReachable();
    const l = this.ledgers.get(ledgerId);
    if (!l) throw new Error('no such ledger');
    for (const entryJson of entriesJson) {
      const parsed = JSON.parse(entryJson) as { authorAddress: string; prevEntryHash: string | null };
      // Idempotent on entry content (the real relay dedups on the content-derived entryId).
      if (l.entries.some((e) => e.entryJson === entryJson)) continue;
      const entryId = `e${l.entries.length}`;
      l.entries.push({
        entryId,
        prevEntryHash: parsed.prevEntryHash,
        authorAddress: parsed.authorAddress,
        entryJson,
        receivedAt: l.entries.length,
      });
      l.head = entryId;
    }
  }
  async stats(): Promise<number> {
    const accounts = new Set<string>();
    for (const l of this.ledgers.values()) for (const e of l.entries) accounts.add(e.authorAddress);
    return accounts.size;
  }
  #assertReachable(): void {
    if (!this.reachable) throw new Error('relay unreachable (fake)');
  }
}
