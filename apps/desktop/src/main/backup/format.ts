import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { z } from 'zod';
import { WrappedKeySchema } from './keys';

/**
 * NexoDesk backup file (.ndbak), format 1.
 *
 *   MAGIC (7 bytes "NDBAK1\n")
 *   header length (uint32, big endian)
 *   header (UTF-8 JSON, readable without any key)
 *   payload: AES-256-GCM( gzip( manifest length (uint32) | manifest JSON | database bytes ) )
 *   GCM tag (16 bytes)
 *
 * The magic, length and header are authenticated as additional data, so the
 * header cannot be altered without the restore detecting it.
 */

export const BACKUP_EXTENSION = '.ndbak';
const MAGIC = Buffer.from('NDBAK1\n', 'ascii');
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export const BackupKindSchema = z.enum(['manual', 'scheduled', 'pre-restore', 'pre-update']);
export type BackupKind = z.infer<typeof BackupKindSchema>;

export const BackupHeaderSchema = z.object({
  format: z.literal(1),
  product: z.literal('NexoDesk'),
  createdAt: z.string(),
  appVersion: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  installId: z.string(),
  kind: BackupKindSchema,
  cipher: z.literal('aes-256-gcm'),
  compression: z.literal('gzip'),
  nonce: z.string(),
  keyId: z.string(),
  recovery: WrappedKeySchema,
});
export type BackupHeader = z.infer<typeof BackupHeaderSchema>;

export const PayloadManifestSchema = z.object({
  databaseKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  databaseSha256: z.string().regex(/^[0-9a-f]{64}$/),
  databaseSizeBytes: z.number().int().nonnegative(),
  tableCounts: z.record(z.string(), z.number().int().nonnegative()),
});
export type PayloadManifest = z.infer<typeof PayloadManifestSchema>;

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

export class BackupDamagedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'BackupDamagedError';
  }
}

function headerPrefix(header: BackupHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json]);
}

function writeAll(stream: WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Writes a complete backup file. The target must not exist. On any error the
 * partial file is removed before the error is re-thrown.
 */
export async function writeBackupFile(options: {
  target: string;
  header: Omit<BackupHeader, 'nonce' | 'format' | 'product' | 'cipher' | 'compression'>;
  manifest: PayloadManifest;
  databasePath: string;
  backupKey: Buffer;
}): Promise<{ sizeBytes: number }> {
  const nonce = randomBytes(12);
  const header: BackupHeader = {
    format: 1,
    product: 'NexoDesk',
    cipher: 'aes-256-gcm',
    compression: 'gzip',
    ...options.header,
    nonce: nonce.toString('base64'),
  };
  const prefix = headerPrefix(header);
  const manifestJson = Buffer.from(JSON.stringify(options.manifest), 'utf8');
  const manifestLength = Buffer.alloc(4);
  manifestLength.writeUInt32BE(manifestJson.length);

  const cipher = createCipheriv('aes-256-gcm', options.backupKey, nonce);
  cipher.setAAD(prefix);

  async function* plaintext() {
    yield manifestLength;
    yield manifestJson;
    for await (const chunk of createReadStream(options.databasePath)) yield chunk as Buffer;
  }

  const out = createWriteStream(options.target, { flags: 'wx' });
  // Fails with EEXIST when the target already exists; nothing is touched in that case.
  await new Promise<void>((resolve, reject) => {
    out.once('open', () => resolve());
    out.once('error', reject);
  });
  try {
    await writeAll(out, prefix);
    await pipeline(Readable.from(plaintext()), createGzip({ level: 6 }), cipher, async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) await writeAll(out, chunk);
    });
    await writeAll(out, cipher.getAuthTag());
    await endStream(out);

    // Force the bytes onto the disk before the file is trusted.
    const handle = await open(options.target, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { sizeBytes: (await stat(options.target)).size };
  } catch (error) {
    out.destroy();
    await rm(options.target, { force: true });
    throw error;
  }
}

/** Reads only the plain header. Needs no key and no password. */
export async function readBackupHeader(path: string): Promise<{ header: BackupHeader; prefix: Buffer }> {
  const handle = await open(path, 'r');
  try {
    const start = Buffer.alloc(MAGIC.length + 4);
    const { bytesRead } = await handle.read(start, 0, start.length, 0);
    if (bytesRead < start.length || !start.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupFormatError('This file is not a NexoDesk backup.');
    }
    const length = start.readUInt32BE(MAGIC.length);
    if (length === 0 || length > MAX_HEADER_BYTES) throw new BackupFormatError('The backup header is damaged.');
    const json = Buffer.alloc(length);
    const headerRead = await handle.read(json, 0, length, start.length);
    if (headerRead.bytesRead < length) throw new BackupFormatError('The backup file is incomplete.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(json.toString('utf8'));
    } catch {
      throw new BackupFormatError('The backup header is damaged.');
    }
    const header = BackupHeaderSchema.safeParse(parsed);
    if (!header.success) {
      throw new BackupFormatError('This backup was made by an unsupported version of NexoDesk.');
    }
    return { header: header.data, prefix: Buffer.concat([start, json]) };
  } finally {
    await handle.close();
  }
}

/** Splits the decrypted stream into the manifest and the database bytes. */
class PayloadSplitter extends Transform {
  private buffered = Buffer.alloc(0);
  private manifestLength: number | null = null;
  manifest: unknown = null;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.manifest !== null) {
      callback(null, chunk);
      return;
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.manifestLength === null && this.buffered.length >= 4) {
      this.manifestLength = this.buffered.readUInt32BE(0);
      if (this.manifestLength > MAX_MANIFEST_BYTES) {
        callback(new BackupDamagedError('The backup contents are damaged.'));
        return;
      }
    }
    if (this.manifestLength !== null && this.buffered.length >= 4 + this.manifestLength) {
      try {
        this.manifest = JSON.parse(this.buffered.subarray(4, 4 + this.manifestLength).toString('utf8'));
      } catch {
        callback(new BackupDamagedError('The backup contents are damaged.'));
        return;
      }
      const rest = this.buffered.subarray(4 + this.manifestLength);
      this.buffered = Buffer.alloc(0);
      callback(null, rest.length > 0 ? rest : undefined);
      return;
    }
    callback();
  }
}

/**
 * Decrypts a backup into a database file and proves it matches the manifest.
 * The output must not exist. The output is removed if anything fails, including
 * a wrong key or a single changed byte anywhere in the file.
 */
export async function extractBackupFile(options: {
  path: string;
  backupKey: Buffer;
  outputDatabasePath: string;
}): Promise<{ header: BackupHeader; manifest: PayloadManifest }> {
  if (existsSync(options.outputDatabasePath)) {
    // Never overwrite or clean up a file this call did not create.
    throw new Error(`The extraction target already exists: ${options.outputDatabasePath}`);
  }
  const { header, prefix } = await readBackupHeader(options.path);
  const size = (await stat(options.path)).size;
  if (size < prefix.length + TAG_BYTES + 1) throw new BackupDamagedError('The backup file is incomplete.');

  const tag = Buffer.alloc(TAG_BYTES);
  const handle = await open(options.path, 'r');
  try {
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }

  const decipher = createDecipheriv('aes-256-gcm', options.backupKey, Buffer.from(header.nonce, 'base64'));
  decipher.setAAD(prefix);
  decipher.setAuthTag(tag);

  const splitter = new PayloadSplitter();
  const hash = createHash('sha256');
  let written = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      written += chunk.length;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      createReadStream(options.path, { start: prefix.length, end: size - TAG_BYTES - 1 }),
      decipher,
      createGunzip(),
      splitter,
      hashing,
      createWriteStream(options.outputDatabasePath, { flags: 'wx' }),
    );
  } catch (error) {
    await rm(options.outputDatabasePath, { force: true });
    throw new BackupDamagedError('The backup is damaged or the key is wrong. It cannot be restored.', error);
  }

  const manifest = PayloadManifestSchema.safeParse(splitter.manifest);
  const digest = hash.digest('hex');
  if (!manifest.success || manifest.data.databaseSha256 !== digest || manifest.data.databaseSizeBytes !== written) {
    await rm(options.outputDatabasePath, { force: true });
    throw new BackupDamagedError('The backup contents do not match their checksum.');
  }
  return { header, manifest: manifest.data };
}
