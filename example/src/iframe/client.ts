/**
 * /@vite/client served to preview-iframe modules.
 *
 * import-analysis injects `import { createHotContext } from "/@vite/client"`
 * into every transformed module, and CSS dev modules import updateStyle /
 * removeStyle. This module provides those exports, delegating to the host
 * runtime's real implementations exposed on `window`.
 */

declare const window: {
  __vite_createHotContext: (ownerPath: string) => unknown;
} & Window;

export function createHotContext(ownerPath: string): unknown {
  return window.__vite_createHotContext(ownerPath);
}

export function updateStyle(id: string, css: string): void {
  let style = document.querySelector<HTMLStyleElement>(
    'style[data-vite-dev-id=' + JSON.stringify(id) + ']',
  );
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('data-vite-dev-id', id);
    document.head.appendChild(style);
  }
  style.textContent = css;
}

export function removeStyle(id: string): void {
  const style = document.querySelector('style[data-vite-dev-id=' + JSON.stringify(id) + ']');
  if (style) style.remove();
}

export function injectQuery(url: string, queryToInject: string): string {
  return url + (url.includes('?') ? '&' : '?') + queryToInject;
}
