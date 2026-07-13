// Node enrollment: the node mints an Ed25519 identity locally and exchanges
// a single-use, short-lived enrollment code for node credentials. The
// private key never leaves the node. Enrollment uses short-lived single-use
// codes and node-local keys.
// Precedent: Kubernetes bootstrap tokens; SSH host-key enrollment.
import { generateEd25519KeyPair, type Ed25519KeyPair } from "../accp/seal.js";

export interface EnrollmentRequest {
  enrollmentCode: string;
  nodeName: string;
  publicKeyPem: string;
  requestedAt: string;
}

export interface NodeCredentials {
  nodeId: string;
  workspaceId: string;
  cloudPublicKeyPem: string;
}

export interface EnrollmentBundle {
  request: EnrollmentRequest;
  keys: Ed25519KeyPair;
}

/**
 * Node-side half of enrollment: generate the identity keypair and the
 * request to present to cloud. The caller persists `keys.privateKey`
 * material in a user-only local file; it is never serialized into the request.
 * An OS-keychain provider is a future hardening option, not current behavior.
 */
export function createEnrollmentRequest(
  enrollmentCode: string,
  nodeName: string,
  now: Date,
): EnrollmentBundle {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(enrollmentCode)) {
    throw new Error("enrollment code has an invalid shape");
  }
  const keys = generateEd25519KeyPair();
  return {
    keys,
    request: {
      enrollmentCode,
      nodeName,
      publicKeyPem: keys.publicKeyPem,
      requestedAt: now.toISOString(),
    },
  };
}
