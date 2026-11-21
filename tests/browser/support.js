/**
 * Shared by the real-browser tests: find a Chromium-based browser on this machine.
 */

import fs from 'node:fs';
import path from 'node:path';

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/opt/microsoft/msedge/msedge',
];
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

/** @returns {{ channel: 'msedge' | 'chromium', chromiumPath: string | null } | null} */
export function chooseBrowser() {
  if (process.env.AUTODEV_CHROMIUM_PATH) return { channel: 'chromium', chromiumPath: process.env.AUTODEV_CHROMIUM_PATH };
  if (EDGE_PATHS.some((candidate) => fs.existsSync(candidate))) return { channel: 'msedge', chromiumPath: null };
  const chrome = CHROME_PATHS.find((candidate) => fs.existsSync(candidate));
  if (chrome) return { channel: 'chromium', chromiumPath: chrome };
  return null;
}
