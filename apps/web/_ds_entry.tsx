// Design-system barrel for /design-sync (claude.ai/design).
// Named re-exports of the presentational atoms so the bundle assigns each to
// window.Tandem.<Name>. These are the components with no API / context coupling
// — the rest of apps/web is app-wired and not part of the design system.
export { default as TandemLogo } from "./src/components/TandemLogo";
export { default as EmptyState } from "./src/components/EmptyState";
export { default as AgentToasts } from "./src/components/AgentToasts";
export { default as AgentPresence } from "./src/components/AgentPresence";
