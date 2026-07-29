/**
 * `tandem-mcp listen` (TDM-56) — approval-triggered orchestration.
 *
 * A local HTTP listener for Tandem outbound webhooks. A human approves tasks on
 * the board, Tandem POSTs a signed `task.approved` here, and this runs the
 * command you gave it (`claude -p …`, a script, whatever) with the approved
 * tickets in its environment. That is the whole bridge between "a human said
 * yes" and "an agent starts working".
 *
 *   tandem-mcp listen --exec 'claude -p "Connect to canvas $TANDEM_CANVAS_CODE, \
 *     run queue_next, claim and complete the approved tasks"'
 *
 * Modules: args (flags), verify (HMAC, mirrors apps/api/internal/webhooks/
 * sign.go), dedupe (Tandem-Delivery-Id), payload (the event body), trigger
 * (debounce + single-flight), server (HTTP + child process).
 */

export * from "./args.js";
export * from "./dedupe.js";
export * from "./payload.js";
export * from "./server.js";
export * from "./trigger.js";
export * from "./verify.js";
