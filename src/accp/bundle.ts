import { z } from "zod";
import { canonicalJson, computePayloadDigest } from "./envelope.js";
import { MESSAGE_SCHEMAS, MESSAGE_TYPES } from "./messages.js";

export const ACCP_PROTOCOL_VERSION = "accp/1.0";

export function createAccpSchemaBundle(): Record<string, unknown> {
  return {
    protocol: ACCP_PROTOCOL_VERSION,
    generatedFrom: "agent-control-center-core",
    messages: Object.fromEntries(
      MESSAGE_TYPES.map((type) => [
        type,
        z.toJSONSchema(MESSAGE_SCHEMAS[type], {
          target: "draft-2020-12",
          unrepresentable: "any",
        }),
      ]),
    ),
  };
}

export const ACCP_SCHEMA_BUNDLE = createAccpSchemaBundle();
export const ACCP_SCHEMA_BUNDLE_CANONICAL_JSON = canonicalJson(ACCP_SCHEMA_BUNDLE);
export const ACCP_SCHEMA_BUNDLE_DIGEST = computePayloadDigest(ACCP_SCHEMA_BUNDLE);
