/**
 * TDM-1 — agent identity must survive the hosted sidecar's fresh-Gateway-per-call
 * model by riding inside the model-carried session handle. These tests exercise
 * the pure handle codec (serializeSession/parseSession) plus Gateway.claimant()
 * on a Gateway rebuilt from a handle, with no network involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Gateway,
  serializeSession,
  parseSession,
  type CanvasSession,
} from "../src/gateway.js";

const baseSession: CanvasSession = {
  token: "jwt-abc",
  canvasId: "canvas-1",
  canvasName: "Test canvas",
  canvasCode: "TESTCODE",
};

function freshGateway(): Gateway {
  return new Gateway({ apiUrl: "http://unused.invalid" });
}

test("handle round-trips all identity fields", () => {
  const session: CanvasSession = {
    ...baseSession,
    agentId: "agent-42",
    agentName: "planner-alice",
    claimantId: "session-abc123",
  };
  const parsed = parseSession(serializeSession(session));
  assert.deepEqual(parsed, session);
});

test("fresh Gateway from a handle presents the same claimant (registered agent)", () => {
  const handle = serializeSession({
    ...baseSession,
    agentId: "agent-42",
    agentName: "planner-alice",
    claimantId: "session-abc123",
  });
  const gw = freshGateway();
  gw.adoptSession(handle);
  // Preference order: agentName first.
  assert.equal(gw.claimant(), "planner-alice");
  // Re-exporting keeps the identity intact for the NEXT fresh gateway.
  const next = freshGateway();
  next.adoptSession(gw.exportSession());
  assert.equal(next.claimant(), "planner-alice");
});

test("agentId is preferred over claimantId when no agentName", () => {
  const gw = freshGateway();
  gw.adoptSession(
    serializeSession({ ...baseSession, agentId: "agent-42", claimantId: "session-abc123" })
  );
  assert.equal(gw.claimant(), "agent-42");
});

test("pre-identity handle with claimantId: fresh Gateway mints nothing new", () => {
  const handle = serializeSession({ ...baseSession, claimantId: "session-abc123" });

  const gw = freshGateway();
  gw.adoptSession(handle);
  assert.equal(gw.claimant(), "session-abc123");
  // No new mint: repeated calls and a re-exported handle keep the same id.
  assert.equal(gw.claimant(), "session-abc123");
  assert.equal(parseSession(gw.exportSession()).claimantId, "session-abc123");

  // The core TDM-1 flow: claim on one gateway, complete on another, same identity.
  const later = freshGateway();
  later.adoptSession(handle);
  assert.equal(later.claimant(), gw.claimant());
});

test("setAgentId then export: registered identity rides the refreshed handle", () => {
  const gw = freshGateway();
  gw.adoptSession(serializeSession({ ...baseSession, claimantId: "session-abc123" }));
  gw.setAgentId("agent-42", "executor-bob");

  const next = freshGateway();
  next.adoptSession(gw.exportSession());
  assert.equal(next.claimant(), "executor-bob");
  // The pre-registration claimantId is still carried (fallback continuity).
  assert.equal(parseSession(next.exportSession()).claimantId, "session-abc123");
});

test("legacy handle without claimantId still yields a stable per-gateway mint", () => {
  const gw = freshGateway();
  gw.adoptSession(serializeSession(baseSession));
  const first = gw.claimant();
  assert.match(first, /^session-[a-z0-9]+$/);
  // Stable within the gateway, and persisted into the next handle.
  assert.equal(gw.claimant(), first);
  assert.equal(parseSession(gw.exportSession()).claimantId, first);
});

test("parseSession rejects garbage and incomplete handles", () => {
  assert.throws(() => parseSession("not-base64-json!!"), /Invalid session handle/);
  const noToken = Buffer.from(JSON.stringify({ canvasId: "x" })).toString("base64url");
  assert.throws(() => parseSession(noToken), /Invalid session handle/);
});

/*
 * TDM-200 — the handle is tamper-evident: serializeSession MACs the envelope so
 * a character mangled in transit fails loudly at parse instead of half-working.
 * (Corruption detection, not anti-forgery: the key rides in the handle.)
 */

const signedSession: CanvasSession = {
  ...baseSession,
  agentId: "cb780b7a-3d56-4703-936b-e692d97ee2d4",
  agentName: "planner-alice",
  claimantId: "session-abc123",
  claimGeneration: 7,
};

test("signed handle carries a sig and round-trips to the identical session", () => {
  const handle = serializeSession(signedSession);
  const envelope = JSON.parse(Buffer.from(handle, "base64url").toString("utf8"));
  assert.equal(typeof envelope.sig, "string");
  assert.ok(envelope.sig.length > 0);

  // parseSession verifies then strips: the caller gets its session back, no sig.
  assert.deepEqual(parseSession(handle), signedSession);
  // Serializing is deterministic, so a re-export is byte-identical.
  assert.equal(serializeSession(parseSession(handle)), handle);
});

test("a single flipped character anywhere in a signed handle is rejected", () => {
  const handle = serializeSession(signedSession);
  const original = Buffer.from(handle, "base64url");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  let tested = 0;
  let skippedSameBytes = 0;
  for (let i = 0; i < handle.length; i++) {
    for (const ch of alphabet) {
      if (ch === handle[i]) continue;
      const mutated = handle.slice(0, i) + ch + handle.slice(i + 1);
      // Trailing base64url characters carry unused bits: some flips decode to
      // the very same bytes, which is not tampering — nothing changed.
      if (Buffer.from(mutated, "base64url").equals(original)) {
        skippedSameBytes++;
        continue;
      }
      tested++;
      assert.throws(
        () => parseSession(mutated),
        /Invalid session handle/,
        `flip at index ${i} -> '${ch}' parsed instead of being rejected`
      );
    }
  }
  // Sanity: the sweep actually exercised the MAC rather than trivially passing.
  assert.ok(tested > 1000, `expected a broad sweep, only tested ${tested}`);
  assert.ok(skippedSameBytes < tested);
});

test("legacy sig-less handles minted by an older gateway still parse", () => {
  // Exactly what the pre-TDM-200 codec emitted: bare base64url JSON, no sig.
  const legacy = Buffer.from(JSON.stringify(signedSession)).toString("base64url");
  assert.deepEqual(parseSession(legacy), signedSession);

  const gw = freshGateway();
  gw.adoptSession(legacy);
  assert.equal(gw.claimant(), "planner-alice");
  // Re-exporting upgrades it in place: the next handle is signed.
  const upgraded = JSON.parse(
    Buffer.from(gw.exportSession(), "base64url").toString("utf8")
  );
  assert.equal(typeof upgraded.sig, "string");
});

test("a present-but-unusable sig fails closed", () => {
  const withNonStringSig = Buffer.from(
    JSON.stringify({ ...signedSession, sig: 12345 })
  ).toString("base64url");
  assert.throws(() => parseSession(withNonStringSig), /Invalid session handle/);

  const withNullSig = Buffer.from(
    JSON.stringify({ ...signedSession, sig: null })
  ).toString("base64url");
  assert.throws(() => parseSession(withNullSig), /Invalid session handle/);
});

test("corruption that mangles the sig KEY does not downgrade to legacy", () => {
  // The one way a flip can hide the tag: it lands in the field name itself.
  // A legacy handle only ever carried known session fields, so an unknown one
  // on the sig-less path is corruption, not an old gateway's output.
  const mangled = Buffer.from(
    JSON.stringify({ ...signedSession, "#ig": "2bBWWDK-lO262" })
  ).toString("base64url");
  assert.throws(() => parseSession(mangled), /Invalid session handle/);
});

test("a sig valid for a DIFFERENT session does not validate this one", () => {
  const other = serializeSession({ ...signedSession, agentId: "agent-other" });
  const otherSig = JSON.parse(Buffer.from(other, "base64url").toString("utf8")).sig;
  const spliced = Buffer.from(
    JSON.stringify({ ...signedSession, sig: otherSig })
  ).toString("base64url");
  assert.throws(() => parseSession(spliced), /Invalid session handle/);
});
