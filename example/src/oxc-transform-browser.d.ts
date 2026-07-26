declare module 'oxc-transform/browser.js' {
  export function transformSync(
    filename: string,
    code: string,
    options?: Record<string, unknown>,
  ): {
    code: string;
    map?: object | null;
    errors?: Array<{ message: string }>;
  };
  const _default: { transformSync: typeof transformSync };
  export default _default;
}
