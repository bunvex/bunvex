// The acting identity of an admin's Authenticate (STUDY-188 R5): its refusals in serde's words, as Convex's binary
// (precompiled-2026-10-24-bb31399) sent them after "Received Invalid JSON on websocket: ".
import { expect, test } from "bun:test";
import { ActingIdentityError, ProtocolError, parseActingIdentity, parseClientMessage } from "../src/v1.ts";

const STRUCT = "expected struct UserIdentityAttributesJson";
const refusal = (json: string) => {
  try {
    parseActingIdentity(JSON.parse(json));
  } catch (e) {
    expect(e).toBeInstanceOf(ActingIdentityError);
    return (e as Error).message;
  }
  throw new Error(`${json} was accepted`);
};

test("the texts Convex's binary sent, one per JSON value", () => {
  const cases: [string, string][] = [
    ["{}", 'Either "tokenIdentifier" or "issuer" and "subject" must be set'],
    ['{"subject":"s"}', 'Either "tokenIdentifier" or "issuer" and "subject" must be set'],
    ['"x"', `invalid type: string "x", ${STRUCT}`],
    ["[]", `invalid type: sequence, ${STRUCT}`],
    ["true", `invalid type: boolean \`true\`, ${STRUCT}`],
    ["-5", `invalid type: integer \`-5\`, ${STRUCT}`],
    ["-9223372036854775808", `invalid type: integer \`-9223372036854775808\`, ${STRUCT}`],
    ["-0", `invalid type: floating point \`-0.0\`, ${STRUCT}`],
    ["1.5", `invalid type: floating point \`1.5\`, ${STRUCT}`],
    ["0.1", `invalid type: floating point \`0.1\`, ${STRUCT}`],
    // Integral, so an integer here; `floating point \`1000000000000000.0\`` on Convex (not an integer literal).
    ["1e15", `invalid type: integer \`1000000000000000\`, ${STRUCT}`],
    ["1e21", `invalid type: floating point \`1e+21\`, ${STRUCT}`],
    ["123456789012345680000", `invalid type: floating point \`1.2345678901234568e+20\`, ${STRUCT}`],
    // JSON.parse rounds it to -2^63: an integer here, `floating point \`-9.223372036854776e+18\`` on Convex.
    ["-9223372036854775809", `invalid type: integer \`-9223372036854775808\`, ${STRUCT}`],
    ["-1.5e300", `invalid type: floating point \`-1.5e+300\`, ${STRUCT}`],
    ["1.7976931348623157e308", `invalid type: floating point \`1.7976931348623157e+308\`, ${STRUCT}`],
    ["1e-5", `invalid type: floating point \`0.00001\`, ${STRUCT}`],
    ["1e-6", `invalid type: floating point \`1e-6\`, ${STRUCT}`],
    ["1.5e-6", `invalid type: floating point \`1.5e-6\`, ${STRUCT}`],
    ["0.000123", `invalid type: floating point \`0.000123\`, ${STRUCT}`],
    ["5e-324", `invalid type: floating point \`5e-324\`, ${STRUCT}`],
    ["123456789012345.6", `invalid type: floating point \`123456789012345.6\`, ${STRUCT}`],
    ["1234567890123456.7", `invalid type: floating point \`1234567890123456.8\`, ${STRUCT}`],
    [
      String.raw`"a\"b\\c\n\t\r\u0000\u0001\u007f\u0085\u00a0\u200b\u2028\u0301x\u0301\ud83d\ude00'"`,
      // Printed characters as themselves, outside String.raw (Bun's transpiler escapes its non-ASCII).
      String.raw`invalid type: string "a\"b\\c\n\t\r\0\u{1}\u{7f}\u{85}\u{a0}\u{200b}\u{2028}\u{301}x\u{301}` +
        `\u{1f600}'", ${STRUCT}`,
    ],
    [
      String.raw`"\u3000 \u200d\u200c\u0378\ud83c\udffb\u0488\u00e9e\u0301\ud800\udc00\udb40\udc01\u061c\u180e\u2060\u2062\ufff9\ud834\udd73\u1abe\u0e33\u093f"`,
      String.raw`invalid type: string "\u{3000} \u{200d}\u{200c}\u{378}` +
        "\u{1f3fb}" +
        String.raw`\u{488}` +
        "ée" +
        String.raw`\u{301}` +
        "\u{10000}" +
        String.raw`\u{e0001}\u{61c}\u{180e}\u{2060}\u{2062}\u{fff9}\u{1d173}\u{1abe}` +
        `ำि", ${STRUCT}`,
    ],
    [
      String.raw`"\ufeff\ue000\uffff\u00ad"`,
      String.raw`invalid type: string "\u{feff}\u{e000}\u{ffff}\u{ad}", ${STRUCT}`,
    ],
    ['{"issuer":1,"subject":"s"}', "invalid type: integer `1`, expected a string"],
    ['{"subject":"s","issuer":{}}', "invalid type: map, expected a string"],
    ['{"issuer":[1]}', "invalid type: sequence, expected a string"],
    ['{"tokenIdentifier":2}', "invalid type: integer `2`, expected a string"],
    ['{"name":false,"issuer":"i"}', "invalid type: boolean `false`, expected a string"],
    // The first bad field in the object's order.
    ['{"emailVerified":"yes","issuer":1}', 'invalid type: string "yes", expected a boolean'],
    ['{"issuer":"i","subject":"s","emailVerified":1}', "invalid type: integer `1`, expected a boolean"],
  ];
  for (const [json, text] of cases) expect([json, refusal(json)]).toEqual([json, text]);
});

test("an identity: tokenIdentifier, or issuer|subject; null fields dropped, custom claims kept", () => {
  expect(parseActingIdentity({ tokenIdentifier: null, issuer: "i", subject: "s", x: 1, y: null })).toEqual({
    tokenIdentifier: "i|s",
    issuer: "i",
    subject: "s",
    x: 1,
  });
  expect(parseActingIdentity({ tokenIdentifier: "t", emailVerified: true, x: [1] })).toEqual({
    tokenIdentifier: "t",
    emailVerified: true,
    x: [1],
  });
});

test("Authenticate: a bad acting identity fails the message, before any key is looked at", () => {
  const frame = (imp: string) =>
    `{"type":"Authenticate","tokenType":"Admin","value":"k","baseVersion":0,"impersonating":${imp}}`;
  expect(() => parseClientMessage(frame("{}"))).toThrow(
    new ProtocolError(
      'Received Invalid JSON on websocket: Either "tokenIdentifier" or "issuer" and "subject" must be set',
    ),
  );
  expect(() => parseClientMessage(frame('{"issuer":"i","subject":1}').replace("impersonating", "actingAs"))).toThrow(
    "Received Invalid JSON on websocket: invalid type: integer `1`, expected a string",
  );
  expect(parseClientMessage(frame("null"))).toEqual({
    type: "Authenticate",
    tokenType: "Admin",
    value: "k",
    baseVersion: 0,
  });
  expect(parseClientMessage(frame('{"issuer":"i","subject":"s"}'))).toMatchObject({
    impersonating: { issuer: "i", subject: "s" },
  });
});
