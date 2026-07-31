/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Log relay base URL, injected at build time. Never hardcoded. */
  readonly VITE_RELAY_URL?: string;
  readonly VITE_TESTNET_RPC_URL?: string;
  readonly VITE_MAINNET_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
