import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { executionImageMetadata, MAX_EXECUTION_IMAGE_BYTES, sanitizeExecutionImage } from "../src/execution/image.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = makeTmpDir("image");
  outside = makeTmpDir("image-outside");
});
afterEach(() => {
  cleanup(root);
  cleanup(outside);
});

function png(width = 4, height = 3): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 3] = 255;
  }
  return PNG.sync.write({ width, height, data });
}

function jpg(): Buffer {
  return Buffer.from(jpeg.encode({ width: 4, height: 3, data: Buffer.alloc(4 * 3 * 4, 255) }, 90).data);
}

function put(name: string, bytes: Buffer, where = root): string {
  const target = path.join(where, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function read(file: string) {
  return sanitizeExecutionImage({ artifactRoot: root, file });
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(name), data]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typeAndData), chunk.length - 4);
  return chunk;
}

describe("local execution image publication", () => {
  it("decodes/re-encodes PNG and returns only bytes plus path-free image metadata", () => {
    const file = put("diagram.png", png());
    const result = read(file);
    expect(result.mimeType).toBe("image/png");
    expect(result.width).toBe(4);
    expect(result.height).toBe(3);
    expect(result.sha256).toBe(createHash("sha256").update(result.bytes).digest("hex"));
    expect(result.sizeBytes).toBe(result.bytes.length);
    expect(executionImageMetadata(result)).toEqual({ mimeType: "image/png", width: 4, height: 3, sha256: result.sha256, sizeBytes: result.sizeBytes });
    expect(PNG.sync.read(result.bytes).data).toEqual(PNG.sync.read(png()).data);
    expect(JSON.stringify(executionImageMetadata(result))).not.toContain(root);
  });

  it.each(["photo.jpg", "photo.jpeg", "photo.JPG"])("accepts a real JPEG: %s", (name) => {
    put(name, jpg());
    const result = read(name);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBe(4);
    expect(result.height).toBe(3);
    expect(jpeg.decode(result.bytes).width).toBe(4);
  });

  it("strips PNG text metadata", () => {
    const source = png();
    const secret = "metadata-only-secret-marker";
    const data = Buffer.concat([source.subarray(0, 33), pngChunk("tEXt", Buffer.from(`Comment\0${secret}`)), source.subarray(33)]);
    put("with-metadata.png", data);
    const result = read("with-metadata.png");
    expect(result.bytes.includes(Buffer.from(secret))).toBe(false);
    expect(result.bytes.includes(Buffer.from("tEXt"))).toBe(false);
  });

  it("rejects PNG data appended after IEND", () => {
    put("appended.png", Buffer.concat([png(), Buffer.from("appended-secret-marker")]));
    expect(() => read("appended.png")).toThrow(/complete, valid PNG/);
  });

  it.each([0, 1])("bounds PNG inflation for interlace=%s before pixel decoding", (interlace) => {
    const header = png(1, 1).subarray(16, 29);
    header[12] = interlace;
    const oversizedScanlines = Buffer.alloc(1024 * 1024);
    put("inflate-bomb.png", Buffer.concat([
      png().subarray(0, 8), pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(oversizedScanlines)), pngChunk("IEND", Buffer.alloc(0)),
    ]));
    expect(() => read("inflate-bomb.png")).toThrow(/complete, valid PNG/);
  });

  it("accepts a valid interlaced PNG with bounded preflight", () => {
    const header = png(1, 1).subarray(16, 29);
    header[12] = 1;
    put("interlaced.png", Buffer.concat([
      png().subarray(0, 8), pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), pngChunk("IEND", Buffer.alloc(0)),
    ]));
    const result = read("interlaced.png");
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(PNG.sync.read(result.bytes).data).toEqual(Buffer.from([255, 0, 0, 255]));
  });

  it("strips JPEG comments/EXIF and appended payloads", () => {
    const source = jpg();
    const comment = Buffer.from("metadata-only-secret-marker");
    const segment = Buffer.alloc(comment.length + 4);
    segment.writeUInt16BE(0xfffe, 0);
    segment.writeUInt16BE(comment.length + 2, 2);
    comment.copy(segment, 4);
    const exif = Buffer.from("Exif\0\0metadata-only-exif-marker");
    const app1 = Buffer.alloc(exif.length + 4);
    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(exif.length + 2, 2);
    exif.copy(app1, 4);
    put("with-metadata.jpg", Buffer.concat([source.subarray(0, 2), segment, app1, source.subarray(2), Buffer.from("appended-secret-marker")]));
    const result = read("with-metadata.jpg");
    expect(result.bytes.includes(comment)).toBe(false);
    expect(result.bytes.includes(Buffer.from("metadata-only-exif-marker"))).toBe(false);
    expect(result.bytes.includes(Buffer.from("appended-secret-marker"))).toBe(false);
  });

  it.each(["https://example.com/a.png", "http://127.0.0.1/a.png", "file:///tmp/a.png", "data:image/png;base64,AAAA", "\\\\host\\share\\a.png"])("rejects URLs/network paths: %s", (file) => {
    expect(() => read(file)).toThrow(/URLs and network paths/);
  });

  it("requires an absolute local artifact root", () => {
    expect(() => sanitizeExecutionImage({ artifactRoot: "relative", file: "a.png" })).toThrow(/local artifact root/);
    expect(() => sanitizeExecutionImage({ artifactRoot: "\\\\host\\share", file: "a.png" })).toThrow(/local artifact root/);
  });

  it("rejects outside paths and parent traversal", () => {
    const target = put("private.png", png(), outside);
    expect(() => read(target)).toThrow(/containment/);
    expect(() => read(path.relative(root, target))).toThrow(/containment/);
  });

  it.each([".env.png", ".ssh/image.png", ".aws/image.png", ".git/image.png", "id_rsa.png"])("denies sensitive/internal paths: %s", (name) => {
    put(name, png());
    expect(() => read(name)).toThrow(/sensitive-file/);
  });

  it("honors artifact-root .c2cignore", () => {
    fs.writeFileSync(path.join(root, ".c2cignore"), "private/\n");
    put("private/diagram.png", png());
    expect(() => read("private/diagram.png")).toThrow(/sensitive-file/);
  });

  it("rejects non-files and missing files without publishing local paths", () => {
    fs.mkdirSync(path.join(root, "directory.png"));
    expect(() => read("directory.png")).toThrow(/regular/);
    try {
      read("missing.png");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain("missing.png");
    }
  });

  it("denies directory links even if their targets are inside the authorized root", () => {
    put("real/image.png", png());
    fs.symlinkSync(path.join(root, "real"), path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => read("linked/image.png")).toThrow(/link policy/);
  });

  it("denies directory links escaping the authorized root", () => {
    put("image.png", png(), outside);
    fs.symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => read("linked/image.png")).toThrow(/containment/);
  });

  it("denies hardlinked files", () => {
    const source = put("source.png", png());
    fs.linkSync(source, path.join(root, "hardlink.png"));
    expect(() => read("hardlink.png")).toThrow(/non-linked/);
  });

  it.each(["a.svg", "a.gif", "a.txt", "a"])("rejects an unsupported extension: %s", (name) => {
    put(name, png());
    expect(() => read(name)).toThrow(/matching extension/);
  });

  it("rejects mismatched PNG and JPEG signatures", () => {
    put("jpeg.png", jpg());
    put("png.jpg", png());
    expect(() => read("jpeg.png")).toThrow(/matching extension/);
    expect(() => read("png.jpg")).toThrow(/matching extension/);
  });

  it("rejects invalid CRC and truncated PNG", () => {
    const bad = png();
    bad[29] ^= 0xff;
    put("corrupt.png", bad);
    put("truncated.png", png().subarray(0, 33));
    expect(() => read("corrupt.png")).toThrow(/complete, valid PNG/);
    expect(() => read("truncated.png")).toThrow(/complete, valid PNG/);
  });

  it("rejects malformed and truncated JPEG", () => {
    put("corrupt.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]));
    put("truncated.jpg", jpg().subarray(0, 100));
    expect(() => read("corrupt.jpg")).toThrow(/complete, valid PNG/);
    expect(() => read("truncated.jpg")).toThrow(/complete, valid PNG/);
  });

  it("rejects an empty or oversize compressed input before decoding", () => {
    put("empty.png", Buffer.alloc(0));
    put("large.png", Buffer.alloc(MAX_EXECUTION_IMAGE_BYTES + 1));
    expect(() => read("empty.png")).toThrow(/4 MiB/);
    expect(() => read("large.png")).toThrow(/4 MiB/);
  });

  it("rejects huge PNG dimensions before a decode allocation", () => {
    const source = png();
    source.writeUInt32BE(4097, 16);
    put("huge.png", source);
    expect(() => read("huge.png")).toThrow(/4096-pixel/);
  });

  it("rejects huge JPEG dimensions before a decode allocation", () => {
    const source = jpg();
    const sof = source.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    source.writeUInt16BE(4097, sof + 7);
    put("huge.jpg", source);
    expect(() => read("huge.jpg")).toThrow(/4096-pixel/);
  });

  it("does not modify source bytes or create artifacts", () => {
    const source = png();
    const file = put("diagram.png", source);
    const before = fs.readdirSync(root);
    read("diagram.png");
    expect(fs.readFileSync(file)).toEqual(source);
    expect(fs.readdirSync(root)).toEqual(before);
  });
});
