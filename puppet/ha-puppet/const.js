import { readFileSync, existsSync } from "fs";

// load first file that exists
const optionsFile = ["./options-dev.json", "/data/options.json"].find(
  existsSync,
);
if (!optionsFile) {
  console.error(
    "No options file found. Please copy options-dev.json.sample to options-dev.json",
  );
  process.exit(1);
}
export const isAddOn = optionsFile === "/data/options.json";
const options = JSON.parse(readFileSync(optionsFile));

export const hassUrl = isAddOn
  ? (options.home_assistant_url || "http://homeassistant:8123")
  : (options.home_assistant_url || "http://localhost:8123");
export const hassToken = options.access_token;
export const debug = false;

export const chromiumExecutable = isAddOn ? "/usr/bin/chromium" : (options.chromium_executable || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

export const keepBrowserOpen = options.keep_browser_open || false;
export const legacyOptions = {
  push_screenshot_url: options.push_screenshot_url,
  push_screenshot_name: options.push_screenshot_name,
};

if (!hassToken) {
  console.warn("No access token configured. UI will show configuration instructions.");
}

export function getPushScreenshotConfig(options) {
  const url = options.push_screenshot_url;
  if (!url) return undefined;
  if (!options.keep_browser_open) {
    throw new Error("push_screenshot_url requires keep_browser_open");
  }

  const name = options.push_screenshot_name || "dashboard";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error("push_screenshot_name must use lowercase letters, digits, hyphens or underscores");
  }

  const baseUrl = "http://localhost";
  const sourceUrl = new URL(url, baseUrl);
  if (!url.startsWith("/") || url.startsWith("//") || sourceUrl.origin !== baseUrl ||
      sourceUrl.pathname.startsWith("//")) {
    throw new Error("push_screenshot_url must be a relative screenshot URL starting with /");
  }
  return { sourceUrl, pathname: `/screenshots/${name}` };
}
