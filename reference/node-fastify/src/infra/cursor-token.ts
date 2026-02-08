import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./app-error.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const INTERNAL_CURSOR_PATTERN = /^[A-Za-z0-9._:-]+$/;

interface CursorPayloadV1 {
  v: 1;
  c: string;
}

function invalidCursor(message: string): AppError {
  return new AppError(422, "invalid_cursor", message);
}

function assertInternalCursor(cursor: string): void {
  if (!INTERNAL_CURSOR_PATTERN.test(cursor)) {
    throw invalidCursor("cursor payload contains invalid characters.");
  }
}

export class CursorTokenService {
  private readonly verificationSecrets: string[];

  constructor(
    private readonly signingSecret: string,
    verificationSecrets: string[] = [signingSecret],
  ) {
    this.verificationSecrets = [...new Set([signingSecret, ...verificationSecrets])];
  }

  encode(cursor: string): string {
    assertInternalCursor(cursor);
    const payload: CursorPayloadV1 = {
      v: 1,
      c: cursor,
    };
    const payloadBase64Url = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signatureBase64Url = this.sign(payloadBase64Url, this.signingSecret);
    return `${payloadBase64Url}.${signatureBase64Url}`;
  }

  decode(token: string): string {
    const parts = token.split(".");
    if (parts.length !== 2) {
      throw invalidCursor("cursor token format is invalid.");
    }
    const [payloadBase64Url, signatureBase64Url] = parts;
    if (!payloadBase64Url || !signatureBase64Url) {
      throw invalidCursor("cursor token format is invalid.");
    }
    if (!BASE64URL_PATTERN.test(payloadBase64Url) || !BASE64URL_PATTERN.test(signatureBase64Url)) {
      throw invalidCursor("cursor token contains invalid characters.");
    }

    const providedSignatureBuffer = Buffer.from(signatureBase64Url, "utf8");
    let isValidSignature = false;
    for (const secret of this.verificationSecrets) {
      const expectedSignature = this.sign(payloadBase64Url, secret);
      const expectedSignatureBuffer = Buffer.from(expectedSignature, "utf8");
      if (
        providedSignatureBuffer.length === expectedSignatureBuffer.length &&
        timingSafeEqual(providedSignatureBuffer, expectedSignatureBuffer)
      ) {
        isValidSignature = true;
        break;
      }
    }
    if (!isValidSignature) {
      throw invalidCursor("cursor token signature is invalid.");
    }

    try {
      const raw = Buffer.from(payloadBase64Url, "base64url").toString("utf8");
      const payload = JSON.parse(raw) as Partial<CursorPayloadV1>;
      if (payload.v !== 1 || typeof payload.c !== "string") {
        throw invalidCursor("cursor token payload is invalid.");
      }
      assertInternalCursor(payload.c);
      return payload.c;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw invalidCursor("cursor token payload is invalid.");
    }
  }

  private sign(payloadBase64Url: string, secret: string): string {
    return createHmac("sha256", secret).update(payloadBase64Url).digest("base64url");
  }
}
