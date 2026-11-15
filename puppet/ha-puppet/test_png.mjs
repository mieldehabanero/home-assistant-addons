import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { Browser } from "./screenshot.js";

for (const width of [256, 257]) {
  test(`4-bit grayscale PNG rounds gray values without wrapping at width ${width}`, async () => {
    const height = 3;
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3;
        data.fill((x + y * 19) % 256, offset, offset + 3);
      }
    }
    const source = await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const browser = new Browser();
    browser.page = { screenshot: async () => source };
    const { image } = await browser.screenshotPage({
      viewport: { width, height }, zoom: 1, format: "png", pngMode: "grayscale",
    });

    assert.equal(image[24], 4, "PNG bit depth");
    assert.equal(image[25], 0, "PNG color type is grayscale without alpha");
    const { data: pixels, info } = await sharp(image).toColourspace("b-w").raw().toBuffer({
      resolveWithObject: true,
    });
    assert.equal(info.width, width);
    assert.equal(info.height, height);
    assert.equal(info.channels, 1);
    for (let offset = 0; offset < pixels.length; offset++) {
      const gray = data[offset * 3];
      assert.equal(pixels[offset], Math.round(gray / 17) * 17, `pixel ${offset}, gray ${gray}`);
    }
  });
}

test("4-bit grayscale PNG preserves palette processing, inversion, and rotation", async () => {
  const width = 3;
  const height = 2;
  const data = Buffer.from([0, 255, 0, 255, 0, 255].flatMap((gray) => [gray, gray, gray]));
  const source = await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const browser = new Browser();
  browser.page = { screenshot: async () => source };
  const { image } = await browser.screenshotPage({
    viewport: { width, height }, zoom: 1, format: "png", pngMode: "grayscale",
    colors: ["#101010", "#EFEFEF"], paletteColors: ["#000000", "#FFFFFF"],
    dithering: "none", invert: true, rotate: 90,
  });
  const { data: pixels, info } = await sharp(image).toColourspace("b-w").raw().toBuffer({
    resolveWithObject: true,
  });
  assert.equal(info.width, height);
  assert.equal(info.height, width);
  assert.deepEqual([...pixels], [17, 238, 238, 17, 17, 238]);
});
