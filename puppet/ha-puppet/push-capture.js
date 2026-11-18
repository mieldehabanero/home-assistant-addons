import { createHash } from "node:crypto";

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
  if (!url.startsWith("/") || url.startsWith("//") || sourceUrl.origin !== baseUrl) {
    throw new Error("push_screenshot_url must be a relative screenshot URL starting with /");
  }
  return { sourceUrl, pathname: `/screenshots/${name}` };
}

export class PushCapture {
  constructor({ open, capture, contentType, settleMs = 250, reopenMs = 1000, logger = console }) {
    this.open = open;
    this.capture = capture;
    this.contentType = contentType;
    this.settleMs = settleMs;
    this.reopenMs = reopenMs;
    this.logger = logger;
    this.pageGeneration = 0;
    this.ready = false;
    this.stopped = false;
    this.pending = false;
  }

  start() {
    return this.refresh();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  async getImage() {
    if (!this.cached) await this.refresh();
    return this.cached;
  }

  scheduleRefresh(delay) {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.inFlight) {
        this.pending = true;
      } else {
        void this.refresh();
      }
    }, delay);
  }

  refresh() {
    if (this.stopped) return;
    if (!this.inFlight) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.inFlight = this.captureImage()
        .catch((error) => {
          if (!this.stopped) this.logger.error("Push screenshot capture failed:", error);
        })
        .finally(() => {
          this.inFlight = undefined;
          if (this.pending) {
            this.pending = false;
            this.scheduleRefresh(this.settleMs);
          }
        });
    }
    return this.inFlight;
  }

  async captureImage() {
    // A closed page can still have a capture or a dashboard callback in flight.
    const generation = this.pageGeneration;
    const isCurrent = () => !this.stopped && generation === this.pageGeneration;

    if (!this.ready) {
      const onClose = () => {
        if (!isCurrent()) return;
        this.pageGeneration++;
        this.ready = false;
        this.scheduleRefresh(this.reopenMs);
      };
      try {
        await this.open(
          () => {
            if (isCurrent()) this.scheduleRefresh(this.settleMs);
          },
          onClose,
        );
      } catch (error) {
        onClose();
        throw error;
      }
      if (!isCurrent()) return;
      this.ready = true;
    }

    const image = await this.capture();
    if (!isCurrent()) return;
    const etag = `"${createHash("sha256").update(image).digest("hex")}"`;
    this.cached = { image, etag };
  }

  async serve(request, response) {
    const cached = await this.getImage();
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
      "Content-Type": this.contentType,
      "Content-Length": image.length,
    });
    response.end(image);
  }
}
