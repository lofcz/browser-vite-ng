/**
 * OverlayScrollbars wired to a host element, themed to VS Code's Dark+
 * scrollbar (a thin strip that fades in on hover/scroll, like the real
 * workbench). We use OverlayScrollbars instead of the native bar so the
 * Explorer tree, editor tab strip, and install console all share the exact
 * same minimal look — no chunky white native thumb.
 *
 * The hook attaches to the element returned by `ref` and re-uses that element
 * as both the scroll host and viewport, so it never disturbs React-managed
 * children (Monaco, iframes).
 */
import { useEffect, useRef } from 'react';
import { OverlayScrollbars } from 'overlayscrollbars';
import type { RefObject } from 'react';

import 'overlayscrollbars/overlayscrollbars.css';

export interface UseOverlayScrollbarOptions {
  /** Scroll axes that may overflow. 'x' for horizontal strips, 'y' (default)
   *  for vertical lists. */
  direction?: 'x' | 'y' | 'xy';
  /** Extra deps that should re-initialize the instance (e.g. mount gating). */
  deps?: readonly unknown[];
}

export function useOverlayScrollbar<T extends HTMLElement>(
  ref: RefObject<T | null>,
  { direction = 'y', deps = [] }: UseOverlayScrollbarOptions = {},
) {
  const instance = useRef<OverlayScrollbars | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    instance.current = OverlayScrollbars(
      {
        target: el,
        // Keep the host as the scroll container so absolutely-positioned
        // children scroll with the content and keep the host as their offset
        // parent. `paddingElement: false` is
        // essential: it defaults to [target, viewport], and with a custom
        // viewport that double-structure makes OS mis-measure overflow as
        // "hidden", tag the rails `unusable`, and suppress the native bar —
        // which is exactly why no scrollbar appeared.
        elements: { viewport: el, content: false, paddingElement: false },
      },
      {
        overflow: {
          x: direction === 'y' ? 'hidden' : 'scroll',
          y: direction === 'x' ? 'hidden' : 'scroll',
        },
        scrollbars: {
          theme: 'os-theme-vscode',
          // 'move' reveals the thumb when the pointer moves over the host OR on
          // scroll — the closest match to VS Code, where the strip appears as
          // soon as you hover/scroll a pane.
          autoHide: 'move',
          autoHideDelay: 600,
          clickScroll: true,
        },
      },
    );
    return () => {
      instance.current?.destroy();
      instance.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
