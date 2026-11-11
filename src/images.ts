import { fail } from './http';

// Image formats are detected from file structure only. Client MIME types and
// file names are never trusted. No decoding or re-encoding happens here.
export const IMAGE_TYPES = {
  png: { mimeType: 'image/png', extension: 'png' },
  jpeg: { mimeType: 'image/jpeg', extension: 'jpg' },
  webp: { mimeType: 'image/webp', extension: 'webp' },
  gif: { mimeType: 'image/gif', extension: 'gif' },
} as const;
export type ImageFormat = keyof typeof IMAGE_TYPES;
export const IMAGE_MIME_TYPES = Object.values(IMAGE_TYPES).map(t => t.mimeType);
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 16384;

export interface InspectedImage {
  format: ImageFormat; mimeType: string; extension: string; width: number; height: number;
}

const invalid = (): never => fail(400, 'invalid_image');
const starts = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map(c => c.charCodeAt(0));
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function png(b: Uint8Array): [number, number] {
  let o = 8, width = 0, height = 0, data = false;
  for (let first = true; ; first = false) {
    if (o + 12 > b.length) invalid();
    const length = u32be(b, o), type = tag(b, o + 4);
    if (length > b.length - o - 12) invalid();
    if (first) {
      if (type !== 'IHDR' || length !== 13) invalid();
      width = u32be(b, o + 8); height = u32be(b, o + 12);
    } else if (type === 'IHDR') invalid();
    if (type === 'IDAT') data = true;
    o += 12 + length;
    if (type === 'IEND') break;
  }
  if (!data || o !== b.length) invalid();
  return [width, height];
}

function jpeg(b: Uint8Array): [number, number] {
  let o = 2, width = 0, height = 0, scan = false;
  while (o < b.length) {
    if (b[o] !== 0xff) invalid();
    let marker = b[o + 1]; o += 2;
    while (marker === 0xff) { if (o >= b.length) invalid(); marker = b[o++]; } // fill bytes
    if (marker === 0xd8 || marker === 0xd9) invalid();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone markers
    if (o + 2 > b.length) invalid();
    const length = u16be(b, o);
    if (length < 2 || o + length > b.length) invalid();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) invalid();
      height = u16be(b, o + 3); width = u16be(b, o + 5);
    }
    if (marker === 0xda) { scan = true; break; }
    o += length;
  }
  if (!scan || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) invalid();
  return [width, height];
}

function gif(b: Uint8Array): [number, number] {
  if (b.length < 14 || b[b.length - 1] !== 0x3b) invalid();
  return [u16le(b, 6), u16le(b, 8)];
}

function webp(b: Uint8Array): [number, number] {
  if (b.length < 30 || u32le(b, 4) + 8 !== b.length) invalid();
  const chunk = tag(b, 12), size = u32le(b, 16);
  if (size > b.length - 20) invalid();
  if (chunk === 'VP8 ') {
    if (size < 10 || !starts(b, [0x9d, 0x01, 0x2a], 23)) invalid();
    return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  }
  if (chunk === 'VP8L') {
    if (size < 5 || b[20] !== 0x2f) invalid();
    const bits = u32le(b, 21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === 'VP8X') {
    if (size < 10) invalid();
    return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  }
  return invalid();
}

export function inspectImage(b: Uint8Array): InspectedImage {
  if (b.length === 0) invalid();
  let format: ImageFormat;
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) format = 'png';
  else if (starts(b, [0xff, 0xd8, 0xff])) format = 'jpeg';
  else if (starts(b, ascii('GIF87a')) || starts(b, ascii('GIF89a'))) format = 'gif';
  else if (starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8)) format = 'webp';
  else return fail(415, 'unsupported_image_type');
  const [width, height] = { png, jpeg, gif, webp }[format](b);
  if (width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) invalid();
  return { format, ...IMAGE_TYPES[format], width, height };
}
