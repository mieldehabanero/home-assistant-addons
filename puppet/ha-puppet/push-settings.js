import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAddOn, legacyOptions } from "./const.js";

const settingsFile = isAddOn ? "/data/push-settings.json" : "./push-settings-dev.json";

export function writePushSettings(settings) {
  const temporaryFile = `${settingsFile}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(settings) + "\n", { mode: 0o600 });
  renameSync(temporaryFile, settingsFile);
}

export async function loadPushSettings() {
  try {
    return { settings: JSON.parse(readFileSync(settingsFile, "utf8")), shouldSave: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // Supervisor strips removed schema entries from options.json before startup.
  // Its self-info endpoint can still return the previously saved options.
  let options = legacyOptions;
  const token = process.env.SUPERVISOR_TOKEN;
  if (!options.push_screenshot_url && isAddOn && token) {
    const response = await fetch("http://supervisor/addons/self/info", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`Supervisor returned HTTP ${response.status}`);
    options = (await response.json()).data.options;
  }

  const source = options.push_screenshot_url;
  return {
    settings: source
      ? { enabled: true, name: options.push_screenshot_name || "dashboard", source }
      : { enabled: false },
    shouldSave: Boolean(source || (isAddOn && token)),
  };
}
