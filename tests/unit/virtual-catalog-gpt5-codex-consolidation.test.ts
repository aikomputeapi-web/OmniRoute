import test from "node:test";
import assert from "node:assert/strict";

// Regression guard: the virtual catalog was splitting the gpt-5 / gpt-5.1 / gpt-5.2 /
// codex family into duplicate combos whenever a provider (e.g. j3/vip.j3gb.com) returned
// a raw model id with a sub-server label baked in — "server1/gpt-5.1-codex" and
// "15/gpt-5.2" grouped separately from the plain "gpt-5.1-codex" / "gpt-5.2" ids instead
// of merging with them and with other providers' (fk, freemodel-dev/fmd, cx, ...)
// variants of the same model. getCanonicalRootId() already handled this correctly for
// gpt-5.4/gpt-5.5 via substring checks; it was missing equivalent rules for gpt-5,
// gpt-5.1, gpt-5.2, their -codex/-codex-mini/-codex-max variants, and gpt-image-2.
//
// src/app/api/v1/models/catalog.ts previously duplicated this function inline (with the
// same gap) to filter raw duplicates out of the public /v1/models listing; it now imports
// the shared, fixed implementation instead of carrying its own stale copy.

import { getCanonicalRootId } from "../../src/lib/catalog/generateVirtualCatalog.ts";

const FAMILY_CASES: Array<{ canonical: string; variants: string[] }> = [
  { canonical: "gpt-5", variants: ["gpt-5", "server1/gpt-5", "15/gpt-5"] },
  { canonical: "gpt-5-codex", variants: ["gpt-5-codex", "server1/gpt-5-codex", "15/gpt-5-codex"] },
  {
    canonical: "gpt-5-codex-mini",
    variants: ["gpt-5-codex-mini", "server1/gpt-5-codex-mini"],
  },
  { canonical: "gpt-5.1", variants: ["gpt-5.1", "server1/gpt-5.1", "15/gpt-5.1"] },
  {
    canonical: "gpt-5.1-codex",
    variants: ["gpt-5.1-codex", "server1/gpt-5.1-codex", "j3/server1/gpt-5.1-codex"],
  },
  {
    canonical: "gpt-5.1-codex-max",
    variants: ["gpt-5.1-codex-max", "server1/gpt-5.1-codex-max"],
  },
  {
    canonical: "gpt-5.1-codex-mini",
    variants: ["gpt-5.1-codex-mini", "server1/gpt-5.1-codex-mini"],
  },
  { canonical: "gpt-5.2", variants: ["gpt-5.2", "server1/gpt-5.2", "15/gpt-5.2"] },
  {
    canonical: "gpt-5.2-codex",
    variants: ["gpt-5.2-codex", "server1/gpt-5.2-codex"],
  },
  { canonical: "gpt-image-2", variants: ["gpt-image-2", "server1/gpt-image-2"] },
  { canonical: "gpt-image-1", variants: ["gpt-image-1", "15/gpt-image-1"] },
  { canonical: "gpt-image-1.5", variants: ["gpt-image-1.5", "15/gpt-image-1.5"] },
  {
    canonical: "gpt-5-4-nano",
    variants: ["gpt-5.4-nano", "gpt-5-4-nano", "fk/gpt-5.4-nano"],
  },
  {
    canonical: "gpt-4.1",
    variants: ["gpt-4.1", "fk/gpt-4.1"],
  },
  {
    canonical: "gpt-4.1-mini",
    variants: ["gpt-4.1-mini", "fk/gpt-4.1-mini"],
  },
  { canonical: "gpt-5.6-luna", variants: ["gpt-5.6-luna", "j3/gpt-5.6-luna"] },
  { canonical: "gpt-5.6-sol", variants: ["gpt-5.6-sol", "j3/gpt-5.6-sol"] },
  { canonical: "gpt-5.6-terra", variants: ["gpt-5.6-terra", "j3/gpt-5.6-terra"] },
  // FlatKey (fk) appends a "-fk-cx" custom-variant suffix to some ids — must still
  // collapse into the same bucket as the clean id via substring matching.
  { canonical: "gpt-5-4", variants: ["gpt-5.4-fk-cx"] },
  { canonical: "gpt-5-4-mini", variants: ["gpt-5.4-mini-fk-cx"] },
  { canonical: "gpt-5-5", variants: ["gpt-5.5-fk-cx"] },
];

for (const { canonical, variants } of FAMILY_CASES) {
  test(`getCanonicalRootId collapses all "${canonical}" variants into one bucket`, () => {
    for (const variant of variants) {
      assert.equal(
        getCanonicalRootId(variant),
        canonical,
        `expected "${variant}" to canonicalize to "${canonical}"`
      );
    }
  });
}

test("gpt-5.1-codex-max and gpt-5.1-codex-mini do not collapse into the bare gpt-5.1-codex bucket", () => {
  assert.equal(getCanonicalRootId("gpt-5.1-codex-max"), "gpt-5.1-codex-max");
  assert.equal(getCanonicalRootId("gpt-5.1-codex-mini"), "gpt-5.1-codex-mini");
  assert.notEqual(getCanonicalRootId("gpt-5.1-codex-max"), "gpt-5.1-codex");
  assert.notEqual(getCanonicalRootId("gpt-5.1-codex-mini"), "gpt-5.1-codex");
});

test("gpt-5.2-codex does not collapse into the bare gpt-5.2 bucket", () => {
  assert.equal(getCanonicalRootId("gpt-5.2-codex"), "gpt-5.2-codex");
  assert.notEqual(getCanonicalRootId("gpt-5.2-codex"), "gpt-5.2");
});

test("gpt-5-codex-mini does not collapse into the bare gpt-5-codex bucket", () => {
  assert.equal(getCanonicalRootId("gpt-5-codex-mini"), "gpt-5-codex-mini");
  assert.notEqual(getCanonicalRootId("gpt-5-codex-mini"), "gpt-5-codex");
});

test("pre-existing gpt-5.3/gpt-5.4/gpt-5.5/gpt-4o/gpt-oss families are unaffected", () => {
  assert.equal(getCanonicalRootId("gpt-5.3"), "gpt-5-3");
  assert.equal(getCanonicalRootId("gpt-5.4"), "gpt-5-4");
  assert.equal(getCanonicalRootId("gpt-5.4-mini"), "gpt-5-4-mini");
  assert.equal(getCanonicalRootId("gpt-5.5-high"), "gpt-5-5-high");
  assert.equal(getCanonicalRootId("gpt-4o"), "gpt-4o");
  assert.equal(getCanonicalRootId("gpt-oss-120b"), "gpt-oss-120b");
});

test("gpt-5.4-nano does not collapse into the bare gpt-5.4 bucket", () => {
  assert.equal(getCanonicalRootId("gpt-5.4-nano"), "gpt-5-4-nano");
  assert.notEqual(getCanonicalRootId("gpt-5.4-nano"), "gpt-5-4");
});

test("gpt-4.1-mini does not collapse into the bare gpt-4.1 bucket, and neither collapses into gpt-4o/gpt-5.4-mini", () => {
  assert.equal(getCanonicalRootId("gpt-4.1-mini"), "gpt-4.1-mini");
  assert.equal(getCanonicalRootId("gpt-4.1"), "gpt-4.1");
  assert.notEqual(getCanonicalRootId("gpt-4.1-mini"), "gpt-4.1");
  assert.notEqual(getCanonicalRootId("gpt-4.1"), "gpt-4o");
  assert.notEqual(getCanonicalRootId("gpt-4.1-mini"), "gpt-5-4-mini");
});

test("gpt-5.6 preview codenames (luna/sol/terra) stay distinct from each other and from bare gpt-5", () => {
  assert.equal(getCanonicalRootId("gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(getCanonicalRootId("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(getCanonicalRootId("gpt-5.6-terra"), "gpt-5.6-terra");
  assert.notEqual(getCanonicalRootId("gpt-5.6-luna"), "gpt-5");
  assert.notEqual(getCanonicalRootId("gpt-5.6-luna"), getCanonicalRootId("gpt-5.6-sol"));
});

test("gpt-image-1 and gpt-image-1.5 stay distinct from gpt-image-2 and each other", () => {
  assert.equal(getCanonicalRootId("gpt-image-1"), "gpt-image-1");
  assert.equal(getCanonicalRootId("gpt-image-1.5"), "gpt-image-1.5");
  assert.equal(getCanonicalRootId("gpt-image-2"), "gpt-image-2");
});
