import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { Workspace } from "../workspace/manager.js";

/** Bounds apply to both the supplied compressed image and the sanitized image. */
export const MAX_EXECUTION_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_EXECUTION_IMAGE_DIMENSION = 4096;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface ExecutionImageMetadata {
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  sha256: string;
  sizeBytes: number;
}

export interface SanitizedExecutionImage extends ExecutionImageMetadata {
  bytes: Buffer;
}

export class ExecutionImageError extends Error {
  constructor(public readonly code: "INVALID_IMAGE_PATH" | "IMAGE_ACCESS_DENIED" | "INVALID_IMAGE" | "IMAGE_TOO_LARGE", message: string) {
    super(message);
    this.name = "ExecutionImageError";
  }
}

function invalidImage(): never {
  throw new ExecutionImageError("INVALID_IMAGE", "Image must be a complete, valid PNG or JPEG with matching extension and signature.");
}

function checkDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) invalidImage();
  if (width > MAX_EXECUTION_IMAGE_DIMENSION || height > MAX_EXECUTION_IMAGE_DIMENSION) {
    throw new ExecutionImageError("IMAGE_TOO_LARGE", "Image dimensions exceed the 4096-pixel limit.");
  }
}

/** pngjs's interlaced decoder has no inflate bound, so validate IDAT first. */
function preflightPng(bytes: Buffer, width: number, height: number): void {
  const depth = bytes[24];
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(bytes[25]);
  const interlace = bytes[28];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) invalidImage();
  // PNG row bytes include one filter byte per row. Adam7 has seven passes.
  const passes = interlace === 0 ? [[0, 0, 1, 1]] : [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
  ];
  let expectedLength = 0;
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const rows = Math.max(0, Math.ceil((height - y) / dy));
    if (columns && rows) expectedLength += (Math.ceil(columns * channels * depth / 8) + 1) * rows;
  }
  const chunks: Buffer[] = [];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) invalidImage();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR" && offset !== 8) invalidImage();
    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) invalidImage();
      ended = true;
      break;
    }
  }
  if (!ended || !chunks.length) invalidImage();
  const inflated = inflateSync(Buffer.concat(chunks), { maxOutputLength: expectedLength });
  if (inflated.length !== expectedLength) invalidImage();
}

/** Read dimensions before allocating a decoder's pixel buffers. */
function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalidImage();
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) invalidImage();
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || marker === 0x00) invalidImage();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) invalidImage();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalidImage();
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) invalidImage();
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return invalidImage();
}

function sourceBytes(artifactRoot: string, file: string): { bytes: Buffer; extension: string } {
  // This function is for the local publisher only. MCP consumers select a saved
  // output ID; they cannot supply an artifact root, filesystem path, or URL.
  if (typeof artifactRoot !== "string" || !path.isAbsolute(artifactRoot) || /^[/\\]{2}/.test(artifactRoot) || typeof file !== "string" || !file || file.includes("\0") ||
      /^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file) || /^[/\\]{2}/.test(file)) {
    throw new ExecutionImageError("INVALID_IMAGE_PATH", "An explicitly authorized local artifact root and file are required; URLs and network paths are prohibited.");
  }
  let fd: number | undefined;
  try {
    const workspace = new Workspace(artifactRoot, { allowedWorktreeRoot: null });
    // Preserve the lexical path for the no-symlink component walk. Resolving to
    // a realpath first would hide a link that points to another in-root file.
    const relative = path.isAbsolute(file) ? path.relative(workspace.root, file) : file;
    const target = workspace.resolveMutationPath(relative);
    const before = fs.lstatSync(target.abs);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new ExecutionImageError("IMAGE_ACCESS_DENIED", "Only a regular, non-linked image file can be published.");
    }
    if (before.size < 1 || before.size > MAX_EXECUTION_IMAGE_BYTES) {
      throw new ExecutionImageError("IMAGE_TOO_LARGE", "Compressed image size must be between 1 byte and 4 MiB.");
    }
    fd = fs.openSync(target.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) {
      throw new ExecutionImageError("IMAGE_ACCESS_DENIED", "Image identity changed while opening.");
    }
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, null);
      count += read;
      if (read === 0 || count === buffer.length) break;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(workspace.resolveMutationPath(relative).abs);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1 || !current.isFile()) {
      throw new ExecutionImageError("IMAGE_ACCESS_DENIED", "Image identity changed while reading.");
    }
    return { bytes: buffer.subarray(0, count), extension: path.extname(target.rel).toLowerCase() };
  } catch (error) {
    if (error instanceof ExecutionImageError) throw error;
    // Workspace/native errors may contain local paths. Never expose them in
    // publication metadata or the eventual MCP response.
    throw new ExecutionImageError("IMAGE_ACCESS_DENIED", "Image is missing or fails containment, sensitive-file, or link policy.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The local harness explicitly authorizes artifactRoot. Decode and re-encode
 * pixels to remove EXIF/text/comments and appended payloads before publishing.
 * No filesystem writes occur here. Returned metadata never contains paths.
 */
export function sanitizeExecutionImage(input: { artifactRoot: string; file: string }): SanitizedExecutionImage {
  const source = sourceBytes(input.artifactRoot, input.file);
  let bytes: Buffer;
  let width: number;
  let height: number;
  let mimeType: ExecutionImageMetadata["mimeType"];
  try {
    if (source.extension === ".png" && source.bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      if (source.bytes.length < 33 || source.bytes.readUInt32BE(8) !== 13 || source.bytes.toString("ascii", 12, 16) !== "IHDR") invalidImage();
      width = source.bytes.readUInt32BE(16);
      height = source.bytes.readUInt32BE(20);
      checkDimensions(width, height);
      preflightPng(source.bytes, width, height);
      const decoded = PNG.sync.read(source.bytes, { checkCRC: true });
      if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) invalidImage();
      bytes = PNG.sync.write({ width, height, data: decoded.data }, { bitDepth: 8, colorType: 6, inputColorType: 6, inputHasAlpha: true });
      mimeType = "image/png";
    } else if ([".jpg", ".jpeg"].includes(source.extension) && source.bytes.length >= 4 && source.bytes[0] === 0xff && source.bytes[1] === 0xd8 && source.bytes[2] === 0xff) {
      ({ width, height } = jpegDimensions(source.bytes));
      checkDimensions(width, height);
      const decoded = jpeg.decode(source.bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: false,
        maxResolutionInMP: 16.8,
        maxMemoryUsageInMB: 128,
      });
      if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) invalidImage();
      bytes = Buffer.from(jpeg.encode({ width, height, data: decoded.data }, 90).data);
      mimeType = "image/jpeg";
    } else {
      return invalidImage();
    }
  } catch (error) {
    if (error instanceof ExecutionImageError) throw error;
    return invalidImage();
  }
  if (bytes.length > MAX_EXECUTION_IMAGE_BYTES) {
    throw new ExecutionImageError("IMAGE_TOO_LARGE", "Sanitized compressed image exceeds the 4 MiB limit.");
  }
  return { bytes, mimeType, width, height, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

export function executionImageMetadata(image: SanitizedExecutionImage): ExecutionImageMetadata {
  return { mimeType: image.mimeType, width: image.width, height: image.height, sha256: image.sha256, sizeBytes: image.sizeBytes };
}
