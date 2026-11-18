import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { PushCapture, getPushScreenshotConfig } from "./push-capture.js";
import { RequestHandler } from "./http.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for capture");
}

function harness(t, takeScreenshot = (number) => Buffer.from(`image-${number}`)) {
  const pages = [];
  const errors = [];
  let captures = 0;
  const cache = new PushCapture({
    async open(push, close) {
      pages.push({ push, close });
    },
    async capture() {
      return takeScreenshot(++captures);
    },
    contentType: "image/png",
    settleMs: 5,
    reopenMs: 5,
    logger: { error: (...args) => errors.push(args) },
  });
  t.after(() => cache.stop());
  return { cache, pages, errors, captures: () => captures };
}

async function request(handler, url, etag) {
  const response = {
    statusCode: 200,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(body) {
      this.body = body;
    },
    end(body) {
      if (body !== undefined) this.body = body;
    },
  };
  await handler.handleRequest(
    { method: "GET", url, headers: { "if-none-match": etag } },
    response,
  );
  return response;
}

function pushHandler(cache) {
  return new RequestHandler({}, { push: { pathname: "/screenshots/kitchen", cache } });
}

test("push mode requires keep_browser_open and accepts a relative dashboard URL", () => {
  const options = {
    push_screenshot_url: "/dashboard/kitchen?viewport=800x480&next=60",
    push_screenshot_name: "kitchen",
  };
  assert.equal(getPushScreenshotConfig({ keep_browser_open: true }), undefined);
  assert.throws(() => getPushScreenshotConfig(options), /keep_browser_open/);
  assert.throws(() => getPushScreenshotConfig({
    ...options,
    keep_browser_open: true,
    push_screenshot_url: "//another-host.example/dashboard?viewport=800x480",
  }), /relative/);
  const config = getPushScreenshotConfig({ ...options, keep_browser_open: true });
  assert.equal(config.pathname, "/screenshots/kitchen");
  assert.equal(config.sourceUrl.pathname, "/dashboard/kitchen");
});

test("startup captures after readiness and reopening refreshes a populated cache", async (t) => {
  const ready = deferred();
  const pages = [];
  let captures = 0;
  const cache = new PushCapture({
    async open(push, close) {
      pages.push({ push, close });
      await ready.promise;
    },
    capture: async () => Buffer.from(`image-${++captures}`),
    contentType: "image/png",
    reopenMs: 5,
  });
  t.after(() => cache.stop());

  const startup = cache.start();
  const firstGet = request(pushHandler(cache), "/screenshots/kitchen");
  assert.equal(captures, 0);
  ready.resolve();
  const [, response] = await Promise.all([startup, firstGet]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString(), "image-1");
  assert.equal(captures, 1);
  assert.equal((await cache.getImage()).image.toString(), "image-1");

  pages[0].close();
  assert.equal((await cache.getImage()).image.toString(), "image-1");
  await until(() => captures === 2);
  assert.equal(pages.length, 2);
  assert.equal((await cache.getImage()).image.toString(), "image-2");
});

test("a dashboard push can prefill an empty cache after a failed startup capture", async (t) => {
  const { cache, pages, captures, errors } = harness(t, (number) => {
    if (number === 1) throw new Error("Startup capture failed");
    return Buffer.from("recovered");
  });
  await cache.start();
  assert.equal(errors.length, 1);
  pages[0].push();
  await until(() => captures() === 2);

  const response = await request(pushHandler(cache), "/screenshots/kitchen");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString(), "recovered");
  assert.equal(captures(), 2);
});

test("push bursts share a refresh and a push during capture queues one follow-up", async (t) => {
  const refresh = deferred();
  const { cache, pages, captures } = harness(t, (number) => {
    if (number === 2) return refresh.promise;
    return Buffer.from(`image-${number}`);
  });
  await cache.start();
  const { push } = pages[0];
  push();
  push();
  push();
  await until(() => captures() === 2);
  push();
  push();

  assert.equal((await cache.getImage()).image.toString(), "image-1");
  refresh.resolve(Buffer.from("image-2"));
  await until(() => captures() === 3);
  await delay(15);
  assert.equal(captures(), 3);
  assert.equal((await cache.getImage()).image.toString(), "image-3");
});

test("GETs share an empty-cache capture, return 503 on failure, and can retry", async (t) => {
  const retry = deferred();
  const { cache, captures } = harness(t, (number) => {
    if (number === 1) throw new Error("Capture failed");
    return retry.promise;
  });
  const handler = pushHandler(cache);
  const url = "/screenshots/kitchen?next=120";
  assert.equal((await request(handler, url)).statusCode, 503);

  const requests = [request(handler, url), request(handler, url)];
  await until(() => captures() === 2);
  retry.resolve(Buffer.from("recovered"));
  for (const response of await Promise.all(requests)) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.toString(), "recovered");
  }
  assert.equal(captures(), 2);
  assert.equal(handler.nextRequests.length, 0);
});

test("push GETs return conditional responses and ignore next during a refresh", async (t) => {
  const refresh = deferred();
  const { cache, pages, captures, errors } = harness(t, (number) => {
    if (number === 2) return refresh.promise.then(() => {
      throw new Error("Refresh failed");
    });
    return Buffer.from("same image");
  });
  const handler = pushHandler(cache);
  await cache.start();
  const first = await request(handler, "/screenshots/kitchen");
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["Content-Type"], "image/png");
  const etag = first.headers.ETag;
  assert.match(etag, /^"[^"]+"$/);

  pages[0].push();
  await until(() => captures() === 2);
  const url = "/screenshots/kitchen?next=120&next=invalid";
  const matching = await request(handler, url, `"older", W/${etag}`);
  assert.equal(matching.statusCode, 304);
  assert.equal(matching.headers.ETag, etag);
  assert.equal(matching.body, undefined);
  const stale = await request(handler, url, '"different"');
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.body.toString(), "same image");

  refresh.resolve();
  await until(() => errors.length === 1);
  assert.equal((await request(handler, url, etag)).statusCode, 304);
  pages[0].push();
  await until(() => captures() === 3);
  assert.equal((await request(handler, url, etag)).statusCode, 304);
  assert.equal(captures(), 3);
  assert.equal(handler.nextRequests.length, 0);
});

test("normal GETs capture on demand and continue scheduling next preloads", async (t) => {
  const calls = [];
  const handler = new RequestHandler({
    async navigatePage(params) {
      calls.push(["navigate", params.pagePath]);
      return { time: 0 };
    },
    async screenshotPage() {
      calls.push(["capture"]);
      return { image: Buffer.from("normal"), time: 0 };
    },
  });
  t.after(() => {
    clearTimeout(handler.browserCleanupTimer);
    handler.nextRequests.forEach(clearTimeout);
  });

  const response = await request(handler, "/dashboard/kitchen?viewport=800x480&next=60");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString(), "normal");
  assert.deepEqual(calls, [["navigate", "/dashboard/kitchen"], ["capture"]]);
  assert.equal(handler.nextRequests.length, 1);
});
