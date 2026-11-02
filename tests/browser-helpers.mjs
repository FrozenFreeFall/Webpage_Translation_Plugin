import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch (error) {
  const bundled = path.join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  if (!existsSync(bundled)) throw error;
  playwright = require(bundled);
}
export const chromium = playwright.chromium;
export function browserOptions() {
  const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  return { headless: true, ...(process.env.IT_BROWSER_PATH ? { executablePath: process.env.IT_BROWSER_PATH } : existsSync(edge) ? { executablePath: edge } : {}) };
}
export async function createPage() {
  const browser = await chromium.launch(browserOptions());
  const page = await browser.newPage();
  return { browser, page };
}
