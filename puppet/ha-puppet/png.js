import { crc32, deflateSync } from "node:zlib";

function chunk(type, data) {
  const buffer = Buffer.alloc(data.length + 12);
  buffer.writeUInt32BE(data.length, 0);
  buffer.write(type, 4, 4, "ascii");
  data.copy(buffer, 8);
  buffer.writeUInt32BE(crc32(buffer.subarray(4, data.length + 8)), data.length + 8);
  return buffer;
}

// Encode one 8-bit gray sample per pixel, quantized to sixteen shades.
export function encodeGrayscalePng4(data, width, height) {
  if (data.length !== width * height) {
    throw new Error("Expected one grayscale sample per pixel");
  }

  const rowBytes = Math.ceil(width / 2);
  const scanlines = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    // Each row starts with filter 0; an odd final pixel uses the high nibble.
    const rowStart = y * (rowBytes + 1) + 1;
    for (let x = 0; x < width; x++) {
      scanlines[rowStart + (x >> 1)] |=
        (data[y * width + x] >> 4) << (x & 1 ? 0 : 4);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 4; // Bit depth; remaining fields specify non-interlaced grayscale.

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
