// ACCP v1 Ed25519 envelope sealing and verification.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import {
  EnvelopeSchema,
  buildSigningInput,
  computePayloadDigest,
  isExpired,
  isWithinClockSkew,
  type Envelope,
} from "./envelope.js";
import { isAccpMessageType, parsePayload } from "./messages.js";

export interface Ed25519KeyPair {
  publicKeyPem: string;
  privateKey: KeyObject;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
}

export type UnsignedEnvelope = Omit<Envelope, "signature" | "payloadDigest">;

/** Compute payloadDigest, sign the JCS input, and return a full envelope. */
export function sealEnvelope(
  unsigned: UnsignedEnvelope,
  privateKey: KeyObject,
): Envelope {
  const withDigest = {
    ...unsigned,
    payloadDigest: computePayloadDigest(unsigned.payload),
  };
  const signature = edSign(
    null,
    Buffer.from(buildSigningInput(withDigest as Envelope), "utf8"),
    privateKey,
  );
  return { ...withDigest, signature: `ed25519:${signature.toString("base64url")}` };
}

export type VerifyFailureCode =
  | "SCHEMA_VIOLATION"
  | "UNKNOWN_TYPE"
  | "SIGNATURE_INVALID"
  | "CLOCK_SKEW_EXCEEDED"
  | "EXPIRED";

export type VerifyResult =
  | { ok: true; envelope: Envelope; payload: unknown }
  | { ok: false; code: VerifyFailureCode; detail?: string };

/**
 * Full inbound verification in the §2.1 order: shape, type, signature,
 * payload digest, clock skew, expiry, then the per-type payload schema.
 * Fail closed: any failure means the message must not be processed.
 */
export function verifySealedEnvelope(
  raw: unknown,
  senderPublicKeyPem: string,
  nowMs: number,
): VerifyResult {
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "SCHEMA_VIOLATION", detail: "envelope shape" };
  }
  const envelope = parsed.data;
  if (!isAccpMessageType(envelope.type)) {
    return { ok: false, code: "UNKNOWN_TYPE", detail: envelope.type };
  }
  const signatureB64 = envelope.signature.slice("ed25519:".length);
  const valid = edVerify(
    null,
    Buffer.from(buildSigningInput(envelope), "utf8"),
    createPublicKey(senderPublicKeyPem),
    Buffer.from(signatureB64, "base64url"),
  );
  if (!valid) return { ok: false, code: "SIGNATURE_INVALID" };
  if (computePayloadDigest(envelope.payload) !== envelope.payloadDigest) {
    return { ok: false, code: "SIGNATURE_INVALID", detail: "payload digest" };
  }
  if (!isWithinClockSkew(envelope.sentAt, nowMs)) {
    return { ok: false, code: "CLOCK_SKEW_EXCEEDED" };
  }
  if (isExpired(envelope.expiresAt, nowMs)) {
    return { ok: false, code: "EXPIRED" };
  }
  try {
    const payload = parsePayload(envelope.type, envelope.payload);
    return { ok: true, envelope, payload };
  } catch (error) {
    return {
      ok: false,
      code: "SCHEMA_VIOLATION",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Re-export for callers that only need key material typing. */
export { createPrivateKey, type KeyObject };
