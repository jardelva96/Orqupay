import { describe, expect, it } from "vitest";
import { AppError } from "../src/infra/app-error.js";
import { CursorTokenService } from "../src/infra/cursor-token.js";

describe("CursorTokenService", () => {
  const service = new CursorTokenService("test_cursor_secret_123456");

  it("encodes and decodes a cursor", () => {
    const token = service.encode("we_123456");
    const decoded = service.decode(token);

    expect(token).toContain(".");
    expect(decoded).toBe("we_123456");
  });

  it("rejects tampered token signature", () => {
    const token = service.encode("wd_abcdef");
    const [payload, signature] = token.split(".");
    if (!payload || !signature) {
      throw new Error("Encoded token must contain payload and signature.");
    }
    const tamperedSignature = `${signature.slice(0, -1)}A`;
    const tamperedToken = `${payload}.${tamperedSignature}`;

    expect(() => service.decode(tamperedToken)).toThrowError(AppError);
  });

  it("rejects malformed token", () => {
    expect(() => service.decode("not-a-token")).toThrowError(AppError);
  });

  it("rejects invalid internal cursor characters on encode", () => {
    expect(() => service.encode("we invalid")).toThrowError(AppError);
  });

  it("supports secret rotation while decoding old tokens", () => {
    const oldService = new CursorTokenService("old_cursor_secret_123456");
    const rotatingService = new CursorTokenService("new_cursor_secret_123456", [
      "new_cursor_secret_123456",
      "old_cursor_secret_123456",
    ]);

    const token = oldService.encode("we_rotate_123");
    expect(rotatingService.decode(token)).toBe("we_rotate_123");
  });
});
