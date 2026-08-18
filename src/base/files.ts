// Purpose: Domain-neutral file path, bounded-byte-read, and strict UTF-8 utilities.

import {accessSync, constants, readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';

export class FileError extends Error {
  constructor(
    readonly kind:
      | 'not-regular-file'
      | 'too-large'
      | 'not-readable'
      | 'invalid-utf8',
    message: string,
  ) {
    super(message);
    this.name = 'FileError';
  }
}

export function readFileBytes(
  path: string,
  label: string,
  maxBytes?: number,
): Uint8Array {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      throw new FileError(
        'not-regular-file',
        `${label} '${path}' is not a regular file`,
      );
    }
    if (maxBytes !== undefined && stat.size > maxBytes) {
      throw new FileError(
        'too-large',
        `${label} exceeds the ${maxBytes} byte limit`,
      );
    }
    const bytes = readFileSync(path);
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
      throw new FileError(
        'too-large',
        `${label} exceeds the ${maxBytes} byte limit`,
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof FileError) throw error;
    throw new FileError('not-readable', `${label} '${path}' is not readable`);
  }
}

export function resolveReadableFile(
  baseDirectory: string,
  path: string,
  label: string,
): string {
  const resolved = resolve(baseDirectory, path);
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) {
      throw new FileError(
        'not-regular-file',
        `${label} '${resolved}' is not a regular file`,
      );
    }
    accessSync(resolved, constants.R_OK);
  } catch (error) {
    if (error instanceof FileError) throw error;
    throw new FileError(
      'not-readable',
      `${label} '${resolved}' is not readable`,
    );
  }
  return resolved;
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw new FileError('invalid-utf8', 'input is not valid UTF-8');
  }
}
