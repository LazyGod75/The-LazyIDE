/* Browser-domain tool handlers: open/navigate/click/fill/screenshot/
   snapshot/close, all delegating to browserController.ts.
   Extracted verbatim from toolRuntime.ts's executeTool switch. */

import type { ToolExecutionContext } from './types.js';

export async function browserOpen(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const headless = args.headless === true;
  try {
    const { getBrowserController } = await import('../../browser/browserController.js');
    const ctrl = getBrowserController();
    await ctrl.open({ headless });
    return 'Browser opened (visible window). Use browser_navigate to go to a URL.';
  } catch (err) {
    return `ERROR: browser_open failed: ${String(err)}`;
  }
}

export async function browserNavigate(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const url = String(args.url ?? '');
  if (!url) return 'ERROR: No URL provided';
  try {
    const { getBrowserController } = await import('../../browser/browserController.js');
    const ctrl = getBrowserController();
    const info = await ctrl.navigate(url);
    return `Navigated to ${url} — title: ${info.title}`;
  } catch (err) {
    return `ERROR: browser_navigate failed: ${String(err)}`;
  }
}

export async function browserClick(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const selector = args.selector ? String(args.selector) : '';
  const text = args.text ? String(args.text) : '';
  const ref = args.ref ? String(args.ref) : '';
  if (!selector && !text && !ref) return 'ERROR: Provide selector, text, or ref';
  try {
    const { getBrowserController } = await import('../../browser/browserController.js');
    const ctrl = getBrowserController();
    await ctrl.click({ selector, text, ref });
    return `Clicked ${selector || text || ref}`;
  } catch (err) {
    return `ERROR: browser_click failed: ${String(err)}`;
  }
}

export async function browserFill(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const selector = String(args.selector ?? '');
  const value = String(args.value ?? '');
  if (!selector) return 'ERROR: No selector provided';
  if (!value) return 'ERROR: No value provided';
  try {
    const { getBrowserController } = await import('../../browser/browserController.js');
    const ctrl = getBrowserController();
    await ctrl.fill(selector, value);
    return `Filled ${selector} with "${value}"`;
  } catch (err) {
    return `ERROR: browser_fill failed: ${String(err)}`;
  }
}

export async function browserScreenshot(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const fullPage = args.full_page === true;
  try {
    const { getBrowserController } = await import('../../browser/browserController.js');
    const ctrl = getBrowserController();
    const desc = await ctrl.screenshot(fullPage);
    return desc;
  } catch (err) {
    return `ERROR: browser_screenshot failed: ${String(err)}`;
  }
}

export async function browserSnapshot(_args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  try {
    const { getBrowserController } = await import('../../browser/browserController.js');
    const ctrl = getBrowserController();
    const snapshot = await ctrl.snapshot();
    return snapshot.slice(0, 2000);
  } catch (err) {
    return `ERROR: browser_snapshot failed: ${String(err)}`;
  }
}

export async function browserClose(_args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  try {
    const { getBrowserController } = await import('../../browser/browserController.js');
    const ctrl = getBrowserController();
    await ctrl.close();
    return 'Browser closed';
  } catch (err) {
    return `ERROR: browser_close failed: ${String(err)}`;
  }
}
