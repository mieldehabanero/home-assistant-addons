import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Browser } from "./screenshot.js";
import { isAddOn, hassUrl, hassToken, keepBrowserOpen, getPushScreenshotConfig } from "./const.js";
import { CannotOpenPageError } from "./error.js";
import { handleUIRequest } from "./ui.js";
import { loadDevicesConfig, getDeviceConfig } from "./devices.js";
import { installShutdownHandlers } from "./shutdown.js";
import { loadPushSettings, writePushSettings } from "./push-settings.js";

// Maximum number of next requests to keep in memory
const MAX_NEXT_REQUESTS = 100;
// Initial viewport height (px) used to render a "WIDTHxauto" request before the
// full page height is measured. Kept modest so short pages don't gain trailing
// whitespace; taller content still renders and is captured via the clip.
const AUTO_RENDER_HEIGHT = 800;
const BROWSER_TIMEOUT = 30_000; // Timeout for browser inactivity in milliseconds

// Static Tailwind build used by the UI and error pages (vendored so the UI
// works without internet access)
const tailwindCss = readFileSync(
  new URL("./html/tailwind.css", import.meta.url),
);
// Viewport bounds (px). An unbounded viewport lets a single request OOM
// Chromium on small hosts.
const MIN_VIEWPORT_DIM = 10;
const MAX_VIEWPORT_DIM = 4000;
const MAX_ZOOM = 10;
const MAX_PUSH_SETTINGS_BYTES = 16_384;

class InvalidScreenshotRequest extends Error {}

function screenshotContentType(format) {
  return `image/${format}`;
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function parsePushSettings(settings) {
  if (typeof settings?.enabled !== "boolean") {
    throw new InvalidScreenshotRequest("Choose whether to enable push mode");
  }
  if (!settings.enabled) return;
  if (typeof settings.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(settings.name)) {
    throw new InvalidScreenshotRequest("Use lowercase letters, digits, hyphens or underscores for the screenshot name");
  }
  if (typeof settings.source !== "string" || !settings.source.startsWith("/")) {
    throw new InvalidScreenshotRequest("Enter a Home Assistant dashboard path starting with /");
  }
  try {
    const push = getPushScreenshotConfig({
      keep_browser_open: true,
      push_screenshot_url: settings.source,
      push_screenshot_name: settings.name,
    });
    push.sourceUrl.searchParams.delete("next");
    push.sourceUrl.hash = "";
    return push;
  } catch {
    throw new InvalidScreenshotRequest("Enter a Home Assistant dashboard path starting with a single /");
  }
}

export class RequestHandler {
  constructor(browser, { push, logger = console } = {}) {
    this.browser = browser;
    this.logger = logger;
    if (push) {
      const { pathname, sourceUrl, settleMs = 250, reopenMs = 1000 } = push;
      const { requestParams, error } = RequestHandler.parseScreenshotRequest(sourceUrl);
      if (error) throw new InvalidScreenshotRequest(error.message || "Enter a valid screenshot viewport");
      this.push = {
        pathname,
        requestParams,
        origin: new URL(browser.homeAssistantUrl).origin,
        settleMs,
        reopenMs,
      };
      this.pushPageGeneration = 0;
    }
    this.busy = false;

    // Pending browser tasks
    this.pending = [];

    // Request counter to identify requests
    this.requestCount = 0;

    // Timeout identifiers for next requests
    this.nextRequests = [];

    // Time it takes to navigate to a page
    this.navigationTime = 0;

    // Last time the browser was accessed
    this.lastAccess = new Date();
  }

  _runBrowserCleanupCheck = async () => {
    if (this.busy) {
      return;
    }

    const idleTime = Date.now() - this.lastAccess.getTime();

    if (idleTime < BROWSER_TIMEOUT) {
      // Not time to clean up yet. Reschedule for the remaining time.
      const remainingTime = BROWSER_TIMEOUT - idleTime;
      this.browserCleanupTimer = setTimeout(
        this._runBrowserCleanupCheck,
        remainingTime + 100,
      );
      return;
    }

    await this.browser.cleanup();
  };

  _markBrowserAccessed() {
    clearTimeout(this.browserCleanupTimer);
    this.lastAccess = new Date();
    if (keepBrowserOpen || this.push || this.retired) {
      return;
    }
    this.browserCleanupTimer = setTimeout(
      this._runBrowserCleanupCheck,
      BROWSER_TIMEOUT + 100,
    );
  }

  async handleRequest(request, response, pushSettings) {
    const requestUrl = new URL(request.url, "http://localhost");

    if (requestUrl.pathname === "/favicon.ico") {
      response.statusCode = 404;
      response.end();
      return;
    }

    if (requestUrl.pathname === "/tailwind.css") {
      response.writeHead(200, {
        "Content-Type": "text/css",
        "Content-Length": tailwindCss.length,
      });
      response.end(tailwindCss);
      return;
    }

    if (requestUrl.pathname === "/") {
      await handleUIRequest(response, pushSettings);
      return;
    }

    if (this.push) {
      if (requestUrl.pathname !== this.push.pathname) {
        response.statusCode = 404;
        response.end();
      } else if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
      } else {
        await this.servePushScreenshot(request, response);
      }
      return;
    }

    await this.handleOnDemandRequest(request, response, requestUrl);
  }

  static parseScreenshotRequest(requestUrl) {
    try {
      // Load device configurations
      const devicesData = loadDevicesConfig();

      // Check for device parameter and apply device configuration
      const deviceParam = requestUrl.searchParams.get("device");
      let deviceConfig = null;
      if (deviceParam) {
        deviceConfig = getDeviceConfig(deviceParam, devicesData);
        if (!deviceConfig) {
          throw new InvalidScreenshotRequest(`Unknown device: ${deviceParam}`);
        }
      }

      let extraWait = parseInt(requestUrl.searchParams.get("wait"));
      if (isNaN(extraWait)) {
        extraWait = undefined;
      }

      // Get viewport - use device config as default if device is specified.
      // The height may be the literal "auto" (e.g. "1000xauto") to capture the
      // whole scrollable page; the captured height is then derived from the
      // rendered content and capped (see MAX_AUTO_HEIGHT in screenshot.js).
      let autoHeight = false;
      let viewportParams;
      const viewportQuery = requestUrl.searchParams.get("viewport");
      if (viewportQuery) {
        const [widthStr, heightStr] = viewportQuery.split("x");
        autoHeight = (heightStr || "").toLowerCase() === "auto";
        viewportParams = [
          parseInt(widthStr),
          autoHeight ? AUTO_RENDER_HEIGHT : parseInt(heightStr),
        ];
      } else if (deviceConfig) {
        viewportParams = [deviceConfig.width, deviceConfig.height];
      } else {
        viewportParams = [];
      }

      if (
        viewportParams.length != 2 ||
        !viewportParams.every((x) => !isNaN(x))
      ) {
        throw new InvalidScreenshotRequest();
      }

      if (
        !viewportParams.every(
          (x) => x >= MIN_VIEWPORT_DIM && x <= MAX_VIEWPORT_DIM,
        )
      ) {
        throw new InvalidScreenshotRequest(
          `Viewport dimensions must be between ${MIN_VIEWPORT_DIM} and ${MAX_VIEWPORT_DIM} pixels`,
        );
      }

      let einkColors = parseInt(requestUrl.searchParams.get("eink"));
      if (isNaN(einkColors) || einkColors < 2) {
        einkColors = undefined;
      }

      // Supported colours as hex: colors=FF0000,00FF00,0000FF,... or colors=#FF0000,#00FF00,#0000FF,...
      // Use device config as default if available
      const colorsQuery = requestUrl.searchParams.get("colors");
      const colorsString = colorsQuery !== null ? colorsQuery : (deviceConfig?.colors || "");
      let colors = colorsString
        .split(",")
        .map((color) => color.trim())
        .map((color) => color.startsWith("#") ? color : `#${color}`)
        .filter((color) => /^#[0-9A-F]{6}$/i.test(color));

      // Palette colours for quantization (pixels matched to these, then mapped to colors)
      // Use device config as default if available
      const paletteColorsQuery = requestUrl.searchParams.get("palette_colors");
      const paletteColorsString = paletteColorsQuery !== null ? paletteColorsQuery : (deviceConfig?.palette_colors || "");
      let paletteColors = paletteColorsString
        .split(",")
        .map((color) => color.trim())
        .map((color) => color.startsWith("#") ? color : `#${color}`)
        .filter((color) => /^#[0-9A-F]{6}$/i.test(color));

      // Validate that colors and paletteColors have the same length if both are provided
      if (colors.length > 0 && paletteColors.length > 0 && colors.length !== paletteColors.length) {
        // Mismatch - clear paletteColors to ignore it
        paletteColors = [];
      }

      // Handle eink parameter deprecation and mutual exclusivity with colors
      if (einkColors !== undefined) {
        console.warn('[DEPRECATED] The "eink" query parameter is deprecated. Please use "colors" instead. Example: colors=000000,FFFFFF for black and white.');

        // Convert eink=2 to black and white colors for backward compatibility
        if (einkColors === 2 && colors.length === 0) {
          colors = ["#000000", "#FFFFFF"];
          console.log('[eink migration] Converted eink=2 to colors=000000,FFFFFF');
          einkColors = undefined;
        } else if (colors.length > 0) {
          // colors parameter takes precedence - ignore eink
          console.warn('[eink ignored] Both "eink" and "colors" parameters provided. Using "colors" and ignoring "eink".');
          einkColors = undefined;
        } else {
          // Other palette sizes are no longer supported; fail loudly instead
          // of silently returning a full-color screenshot.
          throw new InvalidScreenshotRequest(
            `The "eink=${einkColors}" parameter is no longer supported. Use "colors" with a comma-separated list of hex colors instead, e.g. colors=000000,555555,AAAAAA,FFFFFF`,
          );
        }
      }

      // If palette_colors is empty, use colors as the palette
      if (paletteColors.length === 0 && colors.length > 0) {
        paletteColors = colors;
      }

      let zoom = parseFloat(requestUrl.searchParams.get("zoom"));
      if (isNaN(zoom) || zoom <= 0 || zoom > MAX_ZOOM) {
        zoom = 1;
      }

      const invert = requestUrl.searchParams.has("invert");

      let format = requestUrl.searchParams.get("format") || "png";
      if (!["png", "jpeg", "webp", "bmp"].includes(format)) {
        format = "png";
      }

      let pngMode = requestUrl.searchParams.get("png_mode") || "color";
      if (!["color", "grayscale"].includes(pngMode)) {
        pngMode = "color";
      }

      // BMP mode: 'color' (24-bit), 'grayscale' (8-bit), 'binary' (1-bit)
      let bmpMode = requestUrl.searchParams.get("bmp_mode") || "color";
      if (!["color", "grayscale", "binary"].includes(bmpMode)) {
        bmpMode = "color";
      }

      let rotate = parseInt(requestUrl.searchParams.get("rotate"));
      if (isNaN(rotate) || ![90, 180, 270].includes(rotate)) {
        rotate = undefined;
      }

      const lang = requestUrl.searchParams.get("lang") || undefined;
      const theme = requestUrl.searchParams.get("theme") || undefined;
      // undefined means "not requested": when neither dark nor theme is given
      const dark = requestUrl.searchParams.has("dark") ? true : undefined;

      // Dithering algorithm
      // Use device config as default if available
      const ditheringQuery = requestUrl.searchParams.get("dithering");
      let dithering = ditheringQuery !== null ? ditheringQuery : (deviceConfig?.dithering || "none");
      const validDitheringAlgorithms = [
        "none",
        "floyd-steinberg",
        "atkinson",
        "jarvis-judice-ninke",
        "stucki",
        "burkes",
        "sierra",
        "sierra-lite"
      ];
      if (!validDitheringAlgorithms.includes(dithering)) {
        dithering = "none";
      }

      const requestParams = {
        pagePath: requestUrl.pathname,
        viewport: { width: viewportParams[0], height: viewportParams[1] },
        extraWait,
        colors,
        paletteColors,
        dithering,
        invert,
        autoHeight,
        zoom,
        format,
        pngMode,
        bmpMode,
        rotate,
        lang,
        theme,
        dark,
      };

      return { requestParams };
    } catch (error) {
      if (!(error instanceof InvalidScreenshotRequest)) throw error;
      return { error };
    }
  }

  async handleOnDemandRequest(request, response, requestUrl) {
    const requestId = ++this.requestCount;
    console.debug(requestId, "Request", request.url);

    const start = new Date();

    try {
      console.debug(requestId, "Handling", request.url);

      const { requestParams, error } =
        RequestHandler.parseScreenshotRequest(requestUrl);
      if (error) {
        response.statusCode = 400;
        response.end(error.message);
        return;
      }

      // Extract next param and schedule if necessary
      const nextParam = requestUrl.searchParams.get("next");
      let next = parseInt(nextParam);
      if (isNaN(next) || next < 0) {
        next = undefined;
      }

      let image;
      try {
        image = await this.requestScreenshot({ requestParams, requestId });
      } catch (err) {
        if (err instanceof CannotOpenPageError) {
          console.error(requestId, `Cannot open page: ${err.message}`);
          response.statusCode = err.status;
          response.end(`Cannot open page: ${err.message}`);
          return;
        }
        // Unknown error: we let it propagate so the add-on crashes and the
        // watchdog recovers, but end the response first so the client isn't
        // left hanging until a TCP timeout.
        response.statusCode = 500;
        response.end("Internal error taking screenshot");
        throw err;
      }

      response.writeHead(200, {
        "Content-Type": screenshotContentType(requestParams.format),
        "Content-Length": image.length,
      });
      response.write(image);
      response.end();

      if (!next || this.retired) {
        return;
      }

      // Adjust next based on time it took to process the request
      const end = new Date();
      const requestTime = end.getTime() - start.getTime();
      const nextWaitTime =
        // Convert to milliseconds
        next * 1000 -
        // We calculate next from the start of the request
        requestTime -
        // Start a bit earlier to account for the time browser warms up
        this.navigationTime -
        1000;

      if (nextWaitTime < 0) {
        return;
      }
      console.debug(requestId, `Next request in ${nextWaitTime} ms`);
      const timer = setTimeout(() => {
        // Remove ourselves from the pending list once fired, so the cap below
        // only ever cancels timers that are still pending.
        const idx = this.nextRequests.indexOf(timer);
        if (idx !== -1) {
          this.nextRequests.splice(idx, 1);
        }
        this.prepareNextRequest(requestId, requestParams);
      }, nextWaitTime);
      this.nextRequests.push(timer);
      if (this.nextRequests.length > MAX_NEXT_REQUESTS) {
        clearTimeout(this.nextRequests.shift());
      }
    } finally {
      this._markBrowserAccessed();
    }
  }

  async runBrowserTask(task) {
    if (this.busy) {
      await new Promise((resolve) => this.pending.push(resolve));
    } else {
      this.busy = true;
    }

    try {
      return await task();
    } finally {
      const next = this.pending.shift();
      // Keep the browser reserved while the next task resumes.
      if (next) next();
      else this.busy = false;
    }
  }

  requestScreenshot({
    requestParams = this.push?.requestParams,
    requestId,
    refresh = false,
  } = {}) {
    if (this.push) {
      if (this.pushStopped || (!refresh && this.cachedScreenshot)) {
        return Promise.resolve(this.cachedScreenshot);
      }
      if (this.pushCapture) {
        if (refresh) this.pushRefreshPending = true;
        return this.pushCapture;
      }
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }

    const capture = this.runBrowserTask(() => this.captureScreenshot(requestParams, requestId));
    if (!this.push) return capture;

    this.pushCapture = capture
      .catch((error) => {
        if (!this.pushStopped) this.logger.error("Push screenshot capture failed:", error);
      })
      .finally(() => {
        this.pushCapture = undefined;
        if (this.pushRefreshPending) {
          this.pushRefreshPending = false;
          this.schedulePushCapture(this.push.settleMs);
        }
      });
    return this.pushCapture;
  }

  async captureScreenshot(requestParams, requestId) {
    const generation = this.pushPageGeneration;
    if (this.push) {
      if (this.pushStopped) return;
      if (!this.pushPageReady) await this.openPushPage(requestParams, generation);
      if (!this.isCurrentPushPage(generation)) return;
    } else {
      const { time } = await this.browser.navigatePage(requestParams);
      console.debug(requestId, `Navigated in ${time} ms`);
      this.navigationTime = Math.max(this.navigationTime, time);
    }

    const { image, time } = await this.browser.screenshotPage(requestParams);
    if (!this.push) {
      console.debug(requestId, `Screenshot in ${time} ms`);
      return image;
    }

    if (this.isCurrentPushPage(generation)) {
      const etag = `"${createHash("sha256").update(image).digest("base64url")}"`;
      this.cachedScreenshot = { image, etag };
    }
    return this.cachedScreenshot;
  }

  isCurrentPushPage(generation) {
    // A closed page can still have a capture or a dashboard callback in flight.
    return !this.pushStopped && generation === this.pushPageGeneration;
  }

  schedulePushCapture(delay) {
    if (this.pushStopped || this.pushTimer !== undefined) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.requestScreenshot({ refresh: true });
    }, delay);
  }

  async openPushPage(requestParams, generation) {
    const onClose = () => {
      if (!this.isCurrentPushPage(generation)) return;
      this.pushPageGeneration++;
      this.pushPageReady = false;
      this.schedulePushCapture(this.push.reopenMs);
    };

    try {
      await this.browser.cleanup();
      await this.browser.navigatePage(requestParams, {
        requireReady: true,
        configurePage: async (page) => {
          const chromium = page.browser();
          const pageLost = () => {
            page.off("close", pageLost);
            page.off("error", pageLost);
            chromium.off("disconnected", pageLost);
            onClose();
          };
          page.once("close", pageLost);
          page.once("error", pageLost);
          chromium.once("disconnected", pageLost);
          await page.exposeFunction("puppetRefreshScreenshot", () => {
            if (
              this.isCurrentPushPage(generation) &&
              new URL(page.url()).origin === this.push.origin
            ) {
              this.schedulePushCapture(this.push.settleMs);
            }
          });
        },
      });
      if (this.isCurrentPushPage(generation)) this.pushPageReady = true;
    } catch (error) {
      onClose();
      throw error;
    }
  }

  stopPushCapture() {
    this.pushStopped = true;
    clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
  }

  retire(options) {
    this.retired = true;
    this.stopPushCapture();
    clearTimeout(this.browserCleanupTimer);
    for (const timer of this.nextRequests) clearTimeout(timer);
    this.nextRequests.length = 0;
    return this.runBrowserTask(() => this.browser.cleanup(options));
  }

  async servePushScreenshot(request, response) {
    const cached = await this.requestScreenshot();
    if (!cached) {
      response.writeHead(503, { "Cache-Control": "no-store" });
      response.end("Screenshot unavailable");
      return;
    }

    const { image, etag } = cached;
    const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
    const validator = request.headers["if-none-match"];
    const matches = validator?.trim() === "*" || validator?.split(",").some(
      (tag) => tag.trim().replace(/^W\//, "") === etag,
    );
    if (matches) {
      response.writeHead(304, headers);
      response.end();
      return;
    }

    response.writeHead(200, {
      ...headers,
      "Content-Type": screenshotContentType(this.push.requestParams.format),
      "Content-Length": image.length,
    });
    response.end(image);
  }

  async prepareNextRequest(requestId, requestParams) {
    if (this.busy) {
      console.log("Busy, skipping next request");
      return;
    }
    requestId = `${requestId}-next`;
    console.log(requestId, "Preparing next request");
    try {
      const { time } = await this.runBrowserTask(() => this.browser.navigatePage(requestParams));
      console.debug(requestId, `Navigated in ${time} ms`);
    } catch (err) {
      console.error(requestId, "Error preparing next request", err);
    } finally {
      this._markBrowserAccessed();
    }
  }
}

async function startServer() {
  let pushSettings = { enabled: false };
  const createHandler = (config) => new RequestHandler(new Browser(hassUrl, hassToken), { push: config });
  let requestHandler;
  try {
    const { settings, shouldSave } = await loadPushSettings();
    const push = parsePushSettings(settings);
    requestHandler = createHandler(push);
    pushSettings = settings;
    if (shouldSave) writePushSettings(settings);
  } catch (error) {
    console.error("Could not load or migrate push settings:", error.message);
    requestHandler ??= createHandler();
  }

  async function saveSettings(request, response) {
    if (request.method !== "PUT") {
      response.writeHead(405, { Allow: "PUT" });
      response.end();
      return;
    }
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      sendJson(response, 415, { error: "Send settings as JSON" });
      return;
    }

    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > MAX_PUSH_SETTINGS_BYTES) {
          request.resume();
          sendJson(response, 413, { error: "Screenshot settings are too large" });
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      return;
    }

    let settings;
    let nextHandler;
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const config = parsePushSettings(input);
      settings = config
        ? { enabled: true, name: input.name, source: config.sourceUrl.pathname + config.sourceUrl.search }
        : { ...pushSettings, enabled: false };
      if (JSON.stringify(settings) !== JSON.stringify(pushSettings)) {
        nextHandler = createHandler(config);
      }
    } catch (error) {
      const message = error instanceof InvalidScreenshotRequest ? error.message : "Invalid screenshot settings";
      sendJson(response, 400, { error: message });
      return;
    }

    try {
      writePushSettings(settings);
    } catch (error) {
      console.error("Could not save push settings:", error.message);
      sendJson(response, 500, { error: "Could not save push settings" });
      return;
    }
    if (nextHandler) {
      const previousHandler = requestHandler;
      requestHandler = nextHandler;
      pushSettings = settings;
      // Drain existing requests and close Chromium before opening the new dashboard.
      void nextHandler.runBrowserTask(() => previousHandler.retire());
    }
    if (pushSettings.enabled) void requestHandler.requestScreenshot({ refresh: true });
    sendJson(response, 200, pushSettings);
  }

  const port = 10000;
  const server = http.createServer((request, response) => {
    if (request.url === "/api/puppet/push-settings") return saveSettings(request, response);
    return requestHandler.handleRequest(request, response, pushSettings);
  });
  server.listen(port, () => {
    if (pushSettings.enabled) void requestHandler.requestScreenshot({ refresh: true });
  });
  installShutdownHandlers(server, {
    cleanup(options) {
      return requestHandler.retire(options);
    },
  });
  const now = new Date();
  const serverUrl = isAddOn
    ? `http://homeassistant.local:${port}`
    : `http://localhost:${port}`;
  console.log(`[${now.toLocaleTimeString()}] Visit server at ${serverUrl}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
