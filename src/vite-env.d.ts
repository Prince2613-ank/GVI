/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_TOKEN?: string;
  readonly VITE_ENABLE_BALCONY_DEBUG?: string;
  readonly VITE_BALCONY_API_URL?: string;
  readonly VITE_BALCONY_ADMIN_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
