// Reading .env files as dotenv reads them. Convex's CLI parses `.env`, `.env.local` and
// `env set --from-file` with dotenv 16 (npm-packages/convex/src/cli/lib/env.ts), and its
// formatEnvValueForDotfile tests check that what `env list` prints reads back through dotenv. The expected
// values below are dotenv 16.4's answers.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { formatEnvValueForDotfile } from "../src/env.ts";
import { parseEnvFile } from "../src/target.ts";

const runs = (base: number) => base * Math.max(1, Number(process.env.BUNVEX_PROPERTY_MULTIPLIER ?? 1));

describe("parseEnvFile reads what dotenv reads", () => {
  test.each([
    ["A=1", { A: "1" }],
    ["export B=two words", { B: "two words" }],
    ["C = spaced  ", { C: "spaced" }],
    ["D=abc#def", { D: "abc" }], // an unquoted '#' starts a comment, even without a space
    ["E=#tag", { E: "" }],
    ["F='a#b' # c", { F: "a#b" }],
    ["G=`tick`", { G: "tick" }],
    ['H="a\\nb"', { H: "a\nb" }], // \n expanded in double quotes only
    ["I='a\\nb'", { I: "a\\nb" }],
    ["J='first\nsecond'", { J: "first\nsecond" }], // a quoted value may span lines
    ['K="one\ntwo"\nL=3', { K: "one\ntwo", L: "3" }],
    ["M='it's'", { M: "it's" }],
    ["N.dotted-name=1", { "N.dotted-name": "1" }],
    ["O: colon", { O: "colon" }],
    ["P=", { P: "" }],
    ["P=1\nP=2", { P: "2" }],
    ["Q='unclosed\nR=2", { Q: "'unclosed", R: "2" }],
    ["S=a\r\nT='x\r\ny'", { S: "a", T: "x\ny" }],
    ["# comment\nbad line\n  U=indented", { U: "indented" }],
  ] as const)("%j", (text, expected) => {
    expect(parseEnvFile(text)).toEqual(expected);
  });
});

describe("what `env list` prints reads back (Convex's formatEnvValueForDotfile round trip)", () => {
  test.each([
    "plain",
    "first\nsecond",
    "-----BEGIN PRIVATE KEY-----\nMIIE\nabc==\n-----END PRIVATE KEY-----",
    "it's\nmulti",
    'say "hi"\nnow',
    "'quoted'",
    '"quoted"',
    "a#b",
    "it's #1",
    "`tick`",
    "C:\\path\\n",
    '{"a":"b","n":[1,2]}',
    "postgres://u:p@h/db?x=1#frag",
    "$HOME and ${VAR}",
    "ünïcødé ✓",
  ])("%j", (value) => {
    const { formatted, warning } = formatEnvValueForDotfile(value);
    expect(warning).toBeUndefined();
    expect(parseEnvFile(`K=${formatted}`).K).toBe(value);
  });

  test("any value without a warning reads back", () => {
    const char = fc.constantFrom("a", "Z", "1", " ", "\n", "#", "'", '"', "`", "\\", "n", "=", ":", "$", "é");
    fc.assert(
      fc.property(fc.array(char, { minLength: 1, maxLength: 24 }), (chars) => {
        const value = chars.join("");
        // Leading or trailing spaces are trimmed by dotenv, and a value that starts with `"` but is printed
        // unquoted has its `\n` expanded: limits Convex shares, as the formatting is Convex's.
        fc.pre(value === value.trim() && !(value.startsWith('"') && value.includes("\\n")));
        const { formatted, warning } = formatEnvValueForDotfile(value);
        fc.pre(warning === undefined);
        expect(parseEnvFile(`K=${formatted}\nNEXT=1`)).toEqual({ K: value, NEXT: "1" });
      }),
      { numRuns: runs(2000) },
    );
  });
});
