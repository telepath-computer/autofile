/**
 * A blob's media type, derived from its extension — a folder of files has
 * nowhere to record one.
 *
 * The table is what a vault is likely to hold: what agents file, and what a
 * browser is asked to render from a vault served over HTTP. An extension that
 * is not here says nothing about its bytes, and `application/octet-stream` is
 * what "no claim" means.
 */

import { extname } from 'node:path';

const GENERAL = 'application/octet-stream';

const MEDIA_TYPES: { [extension: string]: string } = {
  // Text and data
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  csv: 'text/csv',
  xml: 'application/xml',
  ics: 'text/calendar',
  vcf: 'text/vcard',

  // Documents
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  ico: 'image/vnd.microsoft.icon',

  // Audio and video
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',

  // Archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',

  // Fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/**
 * The media type a key's extension claims. What counts as an extension is
 * `extname`'s reading of it, so a name whose only dot opens it — `.gitignore` —
 * is a name rather than a suffix.
 */
export function mediaType(key: string): string {
  const extension = extname(key).slice(1).toLowerCase();
  return MEDIA_TYPES[extension] ?? GENERAL;
}
