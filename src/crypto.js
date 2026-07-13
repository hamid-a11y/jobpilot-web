// Encrypt each workspace's Anthropic API key at rest (AES-256-GCM). The server
// key comes from JOBPILOT_SECRET (hex/base64, 32 bytes) or, if unset, a random
// key persisted once to <data>/.secret. Values are only decrypted in memory at
// the moment of an API call — never stored or rendered in plaintext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.JOBPILOT_DATA_DIR || path.join(ROOT, 'data');

function serverKey() {
  const env = process.env.JOBPILOT_SECRET;
  if (env) {
    const buf = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, 'hex') : Buffer.from(env, 'base64');
    if (buf.length === 32) return buf;
    throw new Error('JOBPILOT_SECRET must be 32 bytes (64 hex chars or base64).');
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, '.secret');
  if (existsSync(f)) return Buffer.from(readFileSync(f, 'utf8').trim(), 'hex');
  const k = randomBytes(32);
  writeFileSync(f, k.toString('hex'), { mode: 0o600 });
  return k;
}
const KEY = serverKey();

export function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob) {
  if (!blob) return null;
  if (!blob.startsWith('v1:')) return blob; // tolerate pre-encryption plaintext
  const [, ivB, tagB, dataB] = blob.split(':');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}
