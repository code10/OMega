/**
 * Real-time headless browser / UI preview and visual verification skills (Playwright-backed).
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { SkillContext, SkillDefinition } from '../types.js';
import { resolveSafePath } from './filesystem.js';

interface BrowserSession {
  browser: any;
  context: any;
  page: any;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

let activeSession: BrowserSession | null = null;

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function isNonLoopbackPrivateIp(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(normalized)) {
    const [a, b] = normalized.split('.').map(Number);
    if (a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (net.isIPv6(normalized)) {
    const low = normalized.toLowerCase();
    if (low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80:')) {
      return true;
    }
  }
  return false;
}

export function validateBrowserUrl(rawUrl: string, context: SkillContext = {}): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported by browser tools.');
  }
  const security = context.config?.security || {};
  if (security.allowPrivateNetwork === true) {
    return parsed;
  }
  const host = parsed.hostname.toLowerCase();
  if (isLoopbackHost(host)) {
    if (security.allowLocalBrowserPreview === false) {
      throw new Error(`Browser preview of loopback host '${host}' is disabled by security.allowLocalBrowserPreview.`);
    }
    return parsed;
  }
  if (net.isIP(host.replace(/^\[|\]$/g, '')) && isNonLoopbackPrivateIp(host)) {
    throw new Error(`SSRF protection: Access to private IP '${host}' is blocked.`);
  }
  return parsed;
}

async function ensureBrowserSession(): Promise<BrowserSession> {
  if (activeSession?.page && !activeSession.page.isClosed()) {
    return activeSession;
  }
  let pw: any;
  try {
    pw = await import('playwright');
  } catch (err: any) {
    throw new Error(`Playwright is not available (${err.message}). Install playwright to use browser verification tools.`);
  }
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const session: BrowserSession = {
    browser,
    context,
    page,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: []
  };

  page.on('console', (msg: any) => {
    if (msg.type() === 'error') {
      session.consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err: any) => {
    session.pageErrors.push(String(err?.message || err));
  });
  page.on('response', (res: any) => {
    if (res.status() >= 400) {
      session.failedRequests.push(`${res.status()} ${res.url()}`);
    }
  });

  activeSession = session;
  return session;
}

async function capturePageState(session: BrowserSession) {
  const { page } = session;
  const title = await page.title().catch(() => '');
  const url = page.url();
  const snapshot = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const interactive = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"]'))
      .slice(0, 40)
      .map((el: any) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        name: el.getAttribute('name') || undefined,
        type: el.getAttribute('type') || undefined,
        text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80)
      }));
    return { text, interactive };
  });

  return {
    title,
    url,
    textSnippet: snapshot.text,
    interactiveElements: snapshot.interactive,
    consoleErrors: session.consoleErrors.slice(-20),
    pageErrors: session.pageErrors.slice(-20),
    failedRequests: session.failedRequests.slice(-20)
  };
}

export async function closeBrowserSession(): Promise<void> {
  if (activeSession) {
    try {
      await activeSession.browser.close();
    } catch (_) {
      // Ignore close errors
    }
    activeSession = null;
  }
}

export const browserSkills: SkillDefinition[] = [
  {
    name: 'browser_inspect',
    description: 'Open or inspect a web page in a real headless Chromium browser to verify rendered UI, DOM text, interactive elements, console/runtime errors, and optionally capture a screenshot.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to navigate to (e.g. http://127.0.0.1:3000). Omit to inspect the currently open page.'
        },
        waitForSelector: {
          type: 'string',
          description: 'Optional CSS selector to wait for before inspecting'
        },
        screenshot: {
          type: 'boolean',
          description: 'If true, save a PNG screenshot to .om-screenshots/ in the workspace'
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture full scrollable page when screenshot is true (default: false)'
        }
      }
    },
    execute: async ({ url, waitForSelector, screenshot = false, fullPage = false }: Record<string, any>, context: SkillContext = {}) => {
      try {
        if (url) {
          validateBrowserUrl(String(url), context);
        }
        const session = await ensureBrowserSession();
        if (url) {
          session.consoleErrors = [];
          session.pageErrors = [];
          session.failedRequests = [];
          await session.page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 20000 });
          await session.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        }
        if (waitForSelector) {
          await session.page.waitForSelector(String(waitForSelector), { timeout: 10000 });
        }

        const state = await capturePageState(session);
        let screenshotPath: string | undefined;
        if (screenshot) {
          const baseWorkspace = context.config?.workspaceDir || process.cwd();
          const shotsDir = resolveSafePath('.om-screenshots', baseWorkspace, context);
          fs.mkdirSync(shotsDir, { recursive: true });
          const filePath = path.join(shotsDir, `shot_${Date.now().toString(36)}.png`);
          await session.page.screenshot({ path: filePath, fullPage: Boolean(fullPage) });
          screenshotPath = path.relative(baseWorkspace, filePath);
        }

        return {
          success: true,
          ...state,
          ...(screenshotPath ? { screenshotPath } : {})
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  },
  {
    name: 'browser_act',
    description: 'Interact with the currently open browser page (click, fill, select, press, scroll) and return updated DOM state and console/page errors.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'fill', 'select', 'press', 'scroll'],
          description: 'Interaction to perform'
        },
        selector: {
          type: 'string',
          description: 'CSS selector for click, fill, select, or press'
        },
        value: {
          type: 'string',
          description: 'Value for fill or select'
        },
        key: {
          type: 'string',
          description: 'Key name for press (e.g. Enter, Escape)'
        },
        waitMs: {
          type: 'number',
          description: 'Optional milliseconds to wait after action (max 5000)'
        }
      },
      required: ['action']
    },
    execute: async ({ action, selector, value, key, waitMs = 250 }: Record<string, any>) => {
      try {
        const session = await ensureBrowserSession();
        const { page } = session;
        if (action === 'click') {
          if (!selector) return { success: false, error: 'selector is required for click' };
          await page.click(String(selector), { timeout: 10000 });
        } else if (action === 'fill') {
          if (!selector) return { success: false, error: 'selector is required for fill' };
          await page.fill(String(selector), String(value ?? ''), { timeout: 10000 });
        } else if (action === 'select') {
          if (!selector) return { success: false, error: 'selector is required for select' };
          await page.selectOption(String(selector), String(value ?? ''), { timeout: 10000 });
        } else if (action === 'press') {
          const target = selector ? page.locator(String(selector)) : page.keyboard;
          await target.press(String(key || 'Enter'));
        } else if (action === 'scroll') {
          await page.evaluate((px: number) => window.scrollBy(0, px), Number(value || 500));
        } else {
          return { success: false, error: `Unsupported action '${action}'` };
        }
        const boundedWait = Math.min(Math.max(0, Number(waitMs) || 0), 5000);
        if (boundedWait > 0) {
          await page.waitForTimeout(boundedWait);
        }
        const state = await capturePageState(session);
        return { success: true, action, ...state };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  },
  {
    name: 'browser_close',
    description: 'Close the active headless browser session.',
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: async () => {
      await closeBrowserSession();
      return { success: true, closed: true };
    }
  }
];
