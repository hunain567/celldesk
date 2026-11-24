import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

/**
 * Signed licence documents shared by NexoDesk and the License Manager.
 *
 * Both documents travel as text ("NDREQ1." / "NDLIC1." + base64url JSON) so
 * they can be saved as a file (.ndreq / .ndlic) or pasted into WhatsApp.
 * The signed bytes are the exact base64url-encoded payload, so no JSON
 * canonicalisation is needed.
 */

export const REQUEST_PREFIX = 'NDREQ1.';
export const LICENSE_PREFIX = 'NDLIC1.';
export const REQUEST_EXTENSION = '.ndreq';
export const LICENSE_EXTENSION = '.ndlic';

export class LicenseCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseCodeError';
  }
}

const EnvelopeSchema = z.object({ payload: z.string().min(1), signature: z.string().min(1) });

export const PlanSchema = z.enum(['monthly', 'six-months', 'yearly', 'custom']);
export type Plan = z.infer<typeof PlanSchema>;

export const ActivationRequestSchema = z.object({
  format: z.literal(1),
  kind: z.literal('activation-request'),
  deviceId: z.string().regex(/^[0-9a-f]{64}$/),
  devicePublicKey: z.string().min(40),
  installId: z.string(),
  machineName: z.string().max(200),
  appVersion: z.string(),
  /** The newest time this installation has ever seen; lets the issuer spot a clock moved back. */
  latestTimeSeen: z.string(),
  createdAt: z.string(),
});
export type ActivationRequest = z.infer<typeof ActivationRequestSchema>;

export const LicenseCertificateSchema = z.object({
  format: z.literal(1),
  kind: z.literal('license'),
  licenseId: z.string().min(1),
  /** Increases with every file issued for the same licence; an older file never replaces a newer one. */
  serial: z.number().int().positive(),
  shopName: z.string().min(1).max(200),
  ownerName: z.string().max(200),
  plan: PlanSchema,
  issuedAt: z.string(),
  validFrom: z.string(),
  validUntil: z.string(),
  graceDays: z.number().int().min(0).max(60),
  deviceId: z.string().regex(/^[0-9a-f]{64}$/),
  devicePublicKey: z.string().min(40),
});
export type LicenseCertificate = z.infer<typeof LicenseCertificateSchema>;

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const fromB64url = (value: string) => Buffer.from(value, 'base64url');

function encode(prefix: string, payload: object, privateKey: KeyObject): string {
  const encodedPayload = b64url(JSON.stringify(payload));
  const signature = sign(null, Buffer.from(encodedPayload, 'utf8'), privateKey).toString('base64url');
  return prefix + b64url(JSON.stringify({ payload: encodedPayload, signature }));
}

function decodeEnvelope(prefix: string, text: string, what: string): { payload: string; signature: Buffer } {
  const compact = text.replace(/\s+/g, '');
  if (!compact.startsWith(prefix)) throw new LicenseCodeError(`This is not a NexoDesk ${what}.`);
  try {
    const envelope = EnvelopeSchema.parse(JSON.parse(fromB64url(compact.slice(prefix.length)).toString('utf8')));
    return { payload: envelope.payload, signature: fromB64url(envelope.signature) };
  } catch {
    throw new LicenseCodeError(`The ${what} is incomplete or damaged. Copy it again in full.`);
  }
}

// ---------- Keys ----------

export interface SigningKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}

/** Public key as compact base64 (SPKI DER), the form stored inside requests and licences. */
export function publicKeyToText(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function publicKeyFromText(text: string): KeyObject {
  return createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
}

// ---------- Activation request (made by the shop PC, signed by its device key) ----------

export function encodeActivationRequest(request: ActivationRequest, devicePrivateKey: KeyObject): string {
  return encode(REQUEST_PREFIX, ActivationRequestSchema.parse(request), devicePrivateKey);
}

/** Decodes a request and proves it was made by the holder of the device key it names. */
export function decodeActivationRequest(text: string): ActivationRequest {
  const { payload, signature } = decodeEnvelope(REQUEST_PREFIX, text, 'activation request');
  let request: ActivationRequest;
  try {
    request = ActivationRequestSchema.parse(JSON.parse(fromB64url(payload).toString('utf8')));
  } catch {
    throw new LicenseCodeError('The activation request is damaged.');
  }
  let valid = false;
  try {
    valid = verify(null, Buffer.from(payload, 'utf8'), publicKeyFromText(request.devicePublicKey), signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new LicenseCodeError('The activation request was changed after it was made.');
  return request;
}

// ---------- Licence (made by the License Manager, signed by the vendor key) ----------

export function encodeLicense(certificate: LicenseCertificate, vendorPrivateKey: KeyObject): string {
  return encode(LICENSE_PREFIX, LicenseCertificateSchema.parse(certificate), vendorPrivateKey);
}

/** Decodes a licence and checks the vendor signature. Throws if the file was changed in any way. */
export function decodeLicense(text: string, vendorPublicKey: KeyObject): LicenseCertificate {
  const { payload, signature } = decodeEnvelope(LICENSE_PREFIX, text, 'licence');
  let valid = false;
  try {
    valid = verify(null, Buffer.from(payload, 'utf8'), vendorPublicKey, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new LicenseCodeError('This licence is not genuine or was changed after it was issued.');
  try {
    return LicenseCertificateSchema.parse(JSON.parse(fromB64url(payload).toString('utf8')));
  } catch {
    throw new LicenseCodeError('This licence was made for a different version of NexoDesk.');
  }
}
