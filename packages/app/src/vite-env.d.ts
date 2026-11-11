/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_NIMIQ_NETWORK?: 'mainnet' | 'testnet';
  readonly VITE_NIMIQ_RPC_URL?: string;
  readonly VITE_PUBLIC_ORIGIN?: string;
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
