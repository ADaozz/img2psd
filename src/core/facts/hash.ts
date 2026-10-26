import { createHash } from 'node:crypto';

// SVG 哈希兼容 LF/CRLF 签出；字节哈希仅用于兼容历史记录。
export const svgHash = (bytes: Buffer | string): string => createHash('sha256')
  .update(bytes.toString().replace(/\r\n/g, '\n')).digest('hex');

// 二进制（PNG 等）用字节哈希，不做换行归一化。
export const bytesHash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export function matchesHash(bytes: Buffer, value: unknown): boolean {
  return typeof value === 'string' && (value === svgHash(bytes) ||
    value === createHash('sha256').update(bytes).digest('hex'));
}
