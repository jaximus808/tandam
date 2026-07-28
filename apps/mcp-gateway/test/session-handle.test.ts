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
