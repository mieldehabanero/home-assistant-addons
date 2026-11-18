import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { getPushScreenshotConfig } from "./const.js";
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

function harness(t, takeScreenshot = (number) => Buffer.from(`image-${number}`), ready) {
  const pages = [];
  const errors = [];
  let captures = 0;
  const handler = new RequestHandler({
    homeAssistantUrl: "http://ha.test",
    async cleanup() {},
    async navigatePage(_params, { configurePage }) {
      const page = new EventEmitter();
      const chromium = new EventEmitter();
      page.browser = () => chromium;
      page.url = () => "http://ha.test/dashboard/kitchen";
      page.exposeFunction = async (name, push) => {
        assert.equal(name, "puppetRefreshScreenshot");
        pages.push({ push, close: () => page.emit("close") });
      };
      await configurePage(page);
      await ready;
    },
    async screenshotPage() {
      return { image: await takeScreenshot(++captures), time: 0 };
    },
  }, {
    push: {
      pathname: "/screenshots/kitchen",
      sourceUrl: new URL("http://localhost/dashboard/kitchen?viewport=800x480"),
      settleMs: 5,
      reopenMs: 5,
    },
    logger: { error: (...args) => errors.push(args) },
  });
  t.after(() => handler.stopPushCapture());
  return { handler, pages, errors, captures: () => captures };
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
  const { handler, pages, captures } = harness(
    t, (number) => Buffer.from(`image-${number}`), ready.promise,
  );
  const url = "/screenshots/kitchen";
  const startup = handler.requestScreenshot({ refresh: true });
  const firstGet = request(handler, url);
  assert.equal(captures(), 0);
  ready.resolve();
  const [, response] = await Promise.all([startup, firstGet]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString(), "image-1");
  assert.equal(captures(), 1);

  pages[0].close();
  assert.equal((await request(handler, url)).body.toString(), "image-1");
  await until(() => captures() === 2);
  assert.equal(pages.length, 2);
  assert.equal((await request(handler, url)).body.toString(), "image-2");
});

test("a dashboard push can prefill an empty cache after a failed startup capture", async (t) => {
  const { handler, pages, captures, errors } = harness(t, (number) => {
    if (number === 1) throw new Error("Startup capture failed");
    return Buffer.from("recovered");
  });
  await handler.requestScreenshot({ refresh: true });
  assert.equal(errors.length, 1);
  pages[0].push();
  await until(() => captures() === 2);

  const response = await request(handler, "/screenshots/kitchen");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString(), "recovered");
  assert.equal(captures(), 2);
});

test("push bursts share a refresh and a push during capture queues one follow-up", async (t) => {
  const refresh = deferred();
  const { handler, pages, captures } = harness(t, (number) => {
    if (number === 2) return refresh.promise;
    return Buffer.from(`image-${number}`);
  });
  await handler.requestScreenshot({ refresh: true });
  const { push } = pages[0];
  push();
  push();
  push();
  await until(() => captures() === 2);
  push();
  push();

  assert.equal((await request(handler, "/screenshots/kitchen")).body.toString(), "image-1");
  refresh.resolve(Buffer.from("image-2"));
  await until(() => captures() === 3);
  await delay(15);
  assert.equal(captures(), 3);
  assert.equal((await request(handler, "/screenshots/kitchen")).body.toString(), "image-3");
});

test("GETs share an empty-cache capture, return 503 on failure, and can retry", async (t) => {
  const retry = deferred();
  const { handler, captures } = harness(t, (number) => {
    if (number === 1) throw new Error("Capture failed");
    return retry.promise;
  });
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
  const { handler, pages, captures, errors } = harness(t, (number) => {
    if (number === 2) return refresh.promise.then(() => {
      throw new Error("Refresh failed");
    });
    return Buffer.from("same image");
  });
  const decision = t.mock.method(handler, "requestScreenshot");
  const queue = t.mock.method(handler, "runBrowserTask");
  await handler.requestScreenshot({ refresh: true });
  const first = await request(handler, "/screenshots/kitchen");
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["Content-Type"], "image/png");
  const etag = first.headers.ETag;
  assert.match(etag, /^"[^"]+"$/);

  pages[0].push();
  await until(() => captures() === 2);
  const url = "/screenshots/kitchen?next=120&next=invalid";
  const matching = await request(handler, url, `"older", W/${etag}`);
  assert.equal(decision.mock.calls.length, 4);
  assert.equal(queue.mock.calls.length, 2);
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

test("concurrent normal GETs use the shared decision in arrival order and schedule next", async (t) => {
  const calls = [];
  const firstCapture = deferred();
  let captures = 0;
  const handler = new RequestHandler({
    async navigatePage(params) {
      calls.push(["navigate", params.pagePath]);
      return { time: 0 };
    },
    async screenshotPage(params) {
      calls.push(["capture", params.pagePath]);
      if (++captures === 1) await firstCapture.promise;
      return { image: Buffer.from(params.pagePath), time: 0 };
    },
  });
  t.after(() => {
    clearTimeout(handler.browserCleanupTimer);
    handler.nextRequests.forEach(clearTimeout);
  });

  const decision = t.mock.method(handler, "requestScreenshot");
  const queue = t.mock.method(handler, "runBrowserTask");
  const first = request(handler, "/dashboard/first?viewport=800x480&next=60");
  const second = request(handler, "/dashboard/second?viewport=800x480&next=60");
  await until(() => captures === 1);
  assert.deepEqual(calls, [
    ["navigate", "/dashboard/first"], ["capture", "/dashboard/first"],
  ]);
  firstCapture.resolve();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
  assert.deepEqual(responses.map((response) => response.body.toString()), [
    "/dashboard/first", "/dashboard/second",
  ]);
  assert.deepEqual(calls, [
    ["navigate", "/dashboard/first"], ["capture", "/dashboard/first"],
    ["navigate", "/dashboard/second"], ["capture", "/dashboard/second"],
  ]);
  assert.equal(decision.mock.calls.length, 2);
  assert.equal(queue.mock.calls.length, 2);
  assert.equal(handler.nextRequests.length, 2);
});
