/**
 * Dockview layout construction — the single source of truth for the editor
 * grid. All grid mutation goes through here, built atomically in `onReady`
 * when the grid is empty. Nothing outside this module calls `api.addPanel`,
 * so the arrangement can never drift between restore / default / reopen paths.
 *
 * Layout:  code (file tabs)  |  preview
 */
import type { DockviewApi } from 'dockview-react';

export const PREVIEW_PANEL_ID = 'preview';
export const DEVTOOLS_PANEL_ID = 'devtools';
export const FILE_PREFIX = 'file:';

export const filePanelId = (path: string) => `${FILE_PREFIX}${path}`;
export const pathFromPanelId = (id: string) => id.slice(FILE_PREFIX.length);
export const isFilePanel = (id: string) => id.startsWith(FILE_PREFIX);
const basename = (path: string) => path.split('/').pop() ?? path;

/**
 * Build the whole grid in one synchronous pass against an EMPTY grid. This is
 * the only safe way to construct the layout — dockview resolves every relative
 * position within a single mutation batch.
 *
 * Order matters: the first file panel becomes the left-most group; every later
 * file stacks within it; the preview splits to the right of that group.
 */
export function buildLayout(api: DockviewApi, openFiles: string[], activeTab: string | null) {
  const firstFile = openFiles[0];
  for (const path of openFiles) {
    api.addPanel({
      id: filePanelId(path),
      component: 'editor',
      tabComponent: 'fileTab',
      params: { path },
      title: basename(path),
      position:
        path === firstFile
          ? undefined
          : { referencePanel: filePanelId(firstFile), direction: 'within' },
      inactive: path !== activeTab,
    });
  }
  api.addPanel({
    id: PREVIEW_PANEL_ID,
    component: 'preview',
    title: 'Preview',
    position: firstFile
      ? { referencePanel: filePanelId(firstFile), direction: 'right' }
      : { direction: 'right' },
  });
  if (activeTab) api.getPanel(filePanelId(activeTab))?.api.setActive();
}

/** Open one file as a tab in the code group.
 *
 * dockview rejects `addPanel` while the grid is mid-layout (the engine opens
 * its first file during construction, before the layout pass finishes). Rather
 * than surfacing that, defer to the next animation frame and retry until the
 * grid is stable — the file always lands, and no caller has to care about the
 * grid's lifecycle. */
export function openFile(api: DockviewApi, path: string, activate: boolean, attempt = 0) {
  if (api.getPanel(filePanelId(path))) {
    if (activate) revealFileTab(api, path);
    return;
  }
  const codePanel = api.panels.find((p) => isFilePanel(p.id));
  // Stack into the existing code group; otherwise open the code group to the
  // LEFT of the preview so the layout stays `code | preview`.
  const preview = api.getPanel(PREVIEW_PANEL_ID);
  const anchored: Parameters<DockviewApi['addPanel']>[0]['position'] = codePanel
    ? { referencePanel: codePanel.id, direction: 'within' }
    : preview
      ? { referencePanel: preview.id, direction: 'left' }
      : undefined;
  try {
    api.addPanel({
      id: filePanelId(path),
      component: 'editor',
      tabComponent: 'fileTab',
      params: { path },
      title: basename(path),
      position: anchored,
      inactive: !activate,
    });
    if (activate) revealFileTab(api, path);
  } catch (err) {
    // The anchored position can throw while the grid is mid-layout. Retry on
    // the next frame; after enough attempts, fall back to a bare add (always
    // accepted) so the file is never dropped, then the code group can be split
    // left by the next open/layout pass.
    if (attempt < 120) {
      requestAnimationFrame(() => openFile(api, path, activate, attempt + 1));
    } else {
      try {
        api.addPanel({
          id: filePanelId(path),
          component: 'editor',
          tabComponent: 'fileTab',
          params: { path },
          title: basename(path),
          inactive: !activate,
        });
        if (activate) revealFileTab(api, path);
      } catch (fallbackErr) {
        console.error(`[dock] openFile ${path} failed`, fallbackErr);
      }
    }
  }
}

/** Close a file's tab if it is open. */
export function closeFile(api: DockviewApi, path: string) {
  const panel = api.getPanel(filePanelId(path));
  if (panel) api.removePanel(panel);
}

/**
 * Scroll the group's tab strip so `path`'s tab chip is fully visible.
 *
 * Dockview's own `setActivePanel` does try to scroll, but it runs before the
 * React `fileTab` content has laid out (width ≈ 0), so the new tab often stays
 * clipped behind the overflow control. Re-scroll after paint; for a newly
 * appended tab this lands at the end of the strip.
 */
export function revealFileTab(api: DockviewApi, path: string) {
  const attempt = (remaining: number) => {
    const panel = api.getPanel(filePanelId(path));
    if (!panel) {
      if (remaining > 0) requestAnimationFrame(() => attempt(remaining - 1));
      return;
    }

    const tabsList = panel.group.element.querySelector<HTMLElement>('.dv-tabs-container');
    const tab =
      tabsList?.querySelector<HTMLElement>('.dv-tab.dv-active-tab') ??
      tabsList?.querySelector<HTMLElement>('.dv-tab[aria-selected="true"]');
    if (!tabsList || !tab || tab.offsetWidth === 0) {
      if (remaining > 0) requestAnimationFrame(() => attempt(remaining - 1));
      return;
    }

    const tabs = tabsList.querySelectorAll<HTMLElement>('.dv-tab');
    const isLast = tabs.length > 0 && tabs[tabs.length - 1] === tab;
    // New files always append — jump to the end so the chip is fully visible.
    if (isLast) {
      tabsList.scrollLeft = tabsList.scrollWidth - tabsList.clientWidth;
      return;
    }

    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    const viewLeft = tabsList.scrollLeft;
    const viewRight = viewLeft + tabsList.clientWidth;
    if (left < viewLeft) {
      tabsList.scrollLeft = left;
    } else if (right > viewRight) {
      tabsList.scrollLeft = right - tabsList.clientWidth;
    }
  };

  // Double-rAF: first frame commits the tab node, second lets React paint the
  // icon/label so offsetWidth is real. Extra frames cover deferred openFile
  // retries and slow custom-tab mounts.
  requestAnimationFrame(() => requestAnimationFrame(() => attempt(12)));
}
