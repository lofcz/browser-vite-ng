declare module '*/vendor/react-refresh-runtime.js' {
  const src: string;
  export default src;
}

declare module 'virtual:node-builtins' {
  /** Authoritative Node builtin module names (generated from node:module). */
  export const NODE_BUILTINS: string[];
}

declare module 'virtual:iframe-runtime' {
  /** Precompiled preview-iframe runtime (plain JS, ESM). */
  export const iframeRuntimeJs: string;
  /** Precompiled /@vite/client module served to iframe modules (plain JS, ESM). */
  export const iframeClientJs: string;
  /** Precompiled /@react-refresh module served to iframe modules (plain JS, ESM). */
  export const reactRefreshJs: string;
}
