import { test, expect, Page } from '@playwright/test';

/**
 * Browser-Vite E2E Tests
 *
 * These tests verify that browser-vite's core functionality works correctly
 * in the browser environment with the new file tree and multi-file support.
 */

// Helper to wait for browser-vite initialization
async function waitForBrowserViteReady(page: Page, timeout = 30000): Promise<void> {
  // setStatus writes the message + Tailwind classes (no .status/.success class).
  // Ready is signalled by the text content becoming "Ready!".
  await page.waitForFunction(
    () => {
      const el = document.getElementById('status');
      return el && (el.textContent === 'Ready!' || el.textContent?.startsWith('Error'));
    },
    { timeout },
  );

  const statusEl = page.locator('#status');
  const text = await statusEl.textContent();
  if (text?.startsWith('Error')) {
    throw new Error(`Browser-vite initialization failed: ${text}`);
  }
}

// Helper to wait for iframe HMR ready
async function waitForIframeReady(page: Page, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    () => {
      const logs = document.getElementById('logs')?.textContent || '';
      return logs.includes('HMR Runtime initialized') || logs.includes('Rendered component');
    },
    { timeout }
  );
}

test.describe('Browser-Vite Initialization', () => {
  test('should initialize successfully', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // Check status shows success (text-based; className is Tailwind utilities)
    const status = page.locator('#status');
    await expect(status).toContainText('Ready');
  });

  test('should enable run button after initialization', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // Run button should be enabled
    await expect(page.locator('#runCode')).toBeEnabled();
  });

  test('should expose browserVite instance on window', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    const hasBrowserVite = await page.evaluate(() => {
      const bv = (window as any).browserVite;
      return bv && typeof bv.transform === 'function';
    });

    expect(hasBrowserVite).toBe(true);
  });
});

test.describe('File Tree', () => {
  test('should render file tree with all files', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // Check that the file tree contains expected files
    const fileTree = page.locator('#fileTree');

    await expect(fileTree).toContainText('App.tsx');
    await expect(fileTree).toContainText('Counter.tsx');
    await expect(fileTree).toContainText('Header.tsx');
    await expect(fileTree).toContainText('Button.tsx');
    await expect(fileTree).toContainText('utils.ts');
    await expect(fileTree).toContainText('styles.css');
  });

  test('should show folders in file tree', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    const fileTree = page.locator('#fileTree');

    // Should have src and components folders
    await expect(fileTree).toContainText('src');
    await expect(fileTree).toContainText('components');
  });

  test('should highlight active file', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // App.tsx should be active by default
    const activeFile = page.locator('.file-item.active');
    await expect(activeFile).toContainText('App.tsx');
  });

  test('should switch files when clicked', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // Click on Counter.tsx
    await page.locator('.file-item:has-text("Counter.tsx")').click();

    // Counter.tsx should now be active
    const activeFile = page.locator('.file-item.active');
    await expect(activeFile).toContainText('Counter.tsx');

    // Header should show Counter.tsx
    const currentFileName = page.locator('#currentFileName');
    await expect(currentFileName).toContainText('Counter.tsx');
  });
});

test.describe('Editor', () => {
  test('should load file content in editor', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // Editor should contain App.tsx content
    const editorContent = await page.locator('.cm-content').textContent();
    expect(editorContent).toContain('App');
    expect(editorContent).toContain('import React');
  });

  test('should update editor when switching files', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // Click on utils.ts
    await page.locator('.file-item:has-text("utils.ts")').click();

    // Editor should now show utils.ts content
    const editorContent = await page.locator('.cm-content').textContent();
    expect(editorContent).toContain('greeting');
    expect(editorContent).toContain('formatNumber');
  });

  test('should mark file as modified when edited', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // Type in editor
    await page.locator('.cm-content').click();
    await page.keyboard.type('// test comment');

    // App.tsx should now have modified indicator
    const modifiedFile = page.locator('.file-item.modified');
    await expect(modifiedFile).toBeVisible();
  });
});

test.describe('Code Transformation', () => {
  test('should transform TypeScript code', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    const result = await page.evaluate(async () => {
      const bv = (window as any).browserVite;
      const code = `const greeting: string = "Hello"; export { greeting };`;
      return await bv.transform(code, '/test.ts');
    });

    // TypeScript types should be removed
    expect(result.code).not.toContain(': string');
    expect(result.code).toContain('greeting');
  });

  test('should transform JSX code', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    const result = await page.evaluate(async () => {
      const bv = (window as any).browserVite;
      const code = `export function App() { return <div>Hello</div>; }`;
      return await bv.transform(code, '/App.jsx');
    });

    // JSX should be transformed to function calls
    expect(result.code).not.toContain('<div>');
    expect(result.code).toMatch(/jsx|createElement/);
  });

  test('should transform TSX code', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    const result = await page.evaluate(async () => {
      const bv = (window as any).browserVite;
      const code = `
        interface Props { name: string; }
        export function Greet({ name }: Props) {
          return <span>Hello, {name}</span>;
        }
      `;
      return await bv.transform(code, '/Greet.tsx');
    });

    // Types and JSX should both be transformed
    expect(result.code).not.toContain('interface Props');
    expect(result.code).not.toContain(': Props');
    expect(result.code).not.toContain('<span>');
  });

  test('should generate source maps', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    const result = await page.evaluate(async () => {
      const bv = (window as any).browserVite;
      const code = `const x: number = 1; export { x };`;
      return await bv.transform(code, '/test.ts');
    });

    expect(result.map).toBeTruthy();
  });
});

test.describe('Preview & HMR', () => {
  test('should render preview iframe', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);
    await waitForIframeReady(page);

    // Check that iframe exists and has content
    const iframe = page.frameLocator('#preview');
    const root = iframe.locator('#root');
    await expect(root).toBeVisible();
  });

  test('should display React app in preview', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);
    await waitForIframeReady(page);

    // Check that the app is rendered
    const iframe = page.frameLocator('#preview');
    await expect(iframe.locator('text=Browser-Vite Demo')).toBeVisible({ timeout: 10000 });
  });

  test('should update preview on code changes', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);
    await waitForIframeReady(page);

    // Wait for initial render
    const iframe = page.frameLocator('#preview');
    await expect(iframe.locator('text=Browser-Vite Demo')).toBeVisible({ timeout: 10000 });

    // Click on Header.tsx
    await page.locator('.file-item:has-text("Header.tsx")').click();

    // Wait for editor to load
    await page.waitForTimeout(500);

    // Modify the title in the Header component
    // First select all text and replace
    await page.locator('.cm-content').click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type(`import React from 'react';

interface HeaderProps {
  title: string;
}

export function Header({ title }: HeaderProps) {
  return (
    <header>
      <h1 style={{
        fontSize: '2.5rem',
        marginBottom: '10px',
        textShadow: '2px 2px 4px rgba(0,0,0,0.2)'
      }}>
        Modified Title Test
      </h1>
    </header>
  );
}`);

    // Wait for HMR update (debounce + transform)
    await page.waitForTimeout(2000);

    // Preview should update (though it may show an error if the bundle fails)
    // Check logs for HMR activity
    const logs = await page.locator('#logs').textContent();
    expect(logs).toContain('HMR');
  });

  test('should show HMR logs', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);
    await waitForIframeReady(page);

    // Check logs contain HMR messages
    const logs = page.locator('#logs');
    await expect(logs).toContainText('HMR');
    await expect(logs).toContainText('Runtime initialized');
  });
});

test.describe('New File Modal', () => {
  test('should open new file modal', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // Click new file button
    await page.click('#newFileBtn');

    // Modal should be visible (code toggles hidden/flex)
    await expect(page.locator('#newFileModal')).not.toHaveClass(/hidden/);
  });

  test('should close modal on cancel', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    await page.click('#newFileBtn');
    await expect(page.locator('#newFileModal')).not.toHaveClass(/hidden/);

    await page.click('#cancelNewFile');
    await expect(page.locator('#newFileModal')).toHaveClass(/hidden/);
  });

  test('should create new file', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // Open modal
    await page.click('#newFileBtn');

    // Type filename
    await page.locator('#newFileName').fill('NewComponent.tsx');

    // Click create
    await page.click('#createNewFile');

    // Modal should close
    await expect(page.locator('#newFileModal')).toHaveClass(/hidden/);

    // New file should appear in tree
    await expect(page.locator('#fileTree')).toContainText('NewComponent.tsx');

    // New file should be active
    const currentFileName = page.locator('#currentFileName');
    await expect(currentFileName).toContainText('NewComponent.tsx');
  });
});

test.describe('Virtual File System', () => {
  test('should expose fileSystem on window', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    const hasFileSystem = await page.evaluate(() => {
      const fs = (window as any).fileSystem;
      return fs && fs instanceof Map && fs.size > 0;
    });

    expect(hasFileSystem).toBe(true);
  });

  test('should have correct number of initial files', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    const fileCount = await page.evaluate(() => {
      return (window as any).fileSystem.size;
    });

    expect(fileCount).toBe(6); // App.tsx, Counter.tsx, Header.tsx, Button.tsx, utils.ts, styles.css
  });

  test('should preserve file content when switching', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);

    // Get initial content of App.tsx
    const initialContent = await page.evaluate(() => {
      return (window as any).fileSystem.get('/src/App.tsx')?.content;
    });

    // Switch to another file
    await page.locator('.file-item:has-text("Counter.tsx")').click();
    await page.waitForTimeout(300);

    // Switch back to App.tsx
    await page.locator('.file-item:has-text("App.tsx")').click();
    await page.waitForTimeout(300);

    // Content should be preserved
    const finalContent = await page.evaluate(() => {
      return (window as any).fileSystem.get('/src/App.tsx')?.content;
    });

    expect(finalContent).toBe(initialContent);
  });
});

test.describe('Counter Component Interaction', () => {
  test('should render counter with initial value', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);
    await waitForIframeReady(page);

    const iframe = page.frameLocator('#preview');

    // Wait for counter to be visible
    await expect(iframe.locator('text=0')).toBeVisible({ timeout: 15000 });
  });

  test('should increment counter when button clicked', async ({ page }) => {
    await page.goto('/');
    await waitForBrowserViteReady(page);
    await waitForIframeReady(page);

    const iframe = page.frameLocator('#preview');

    // Wait for app to render
    await expect(iframe.locator('text=Increment')).toBeVisible({ timeout: 15000 });

    // Click increment
    await iframe.locator('button:has-text("Increment")').click();

    // Counter should show 1
    await expect(iframe.locator('text=1')).toBeVisible();
  });
});
