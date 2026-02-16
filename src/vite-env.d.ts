/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OVERPASS_PROXY_URL?: string;
  readonly VITE_OVERPASS_PROXY_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
