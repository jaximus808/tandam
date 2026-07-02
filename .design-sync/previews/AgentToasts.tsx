import { AgentToasts } from "web";

// Live op-feed popups: cards that announce what an agent just did, styled as
// worksurface objects with a hard terracotta offset shadow, a mono action
// label, and an accent timer bar in the mode's colour. The component renders a
// `position: fixed` bottom-right stack; a `transform` on the Stage wrapper
// makes it the containing block, so the fixed stack anchors inside the card
// instead of the viewport. `onDismiss` is a no-op in previews.

const noop = () => {};

// The transform (translateZ) turns this box into the containing block for the
// component's fixed-position stack, and the paper background reads as the
// worksurface the toasts float over.
function Stage({ children, height = 150 }: { children: React.ReactNode; height?: number }) {
  return (
    <div
      style={{
        position: "relative",
        transform: "translateZ(0)",
        height,
        width: 340,
        background: "#FBFAF8",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

export function ClaudeCreatedDoc() {
  return (
    <Stage>
      <AgentToasts
        onDismiss={noop}
        toasts={[
          {
            id: 1,
            at: Date.now(),
            nonce: 1,
            op: "created",
            kind: "doc",
            mode: "docs",
            agentName: "Claude",
            isClaude: true,
          },
        ]}
      />
    </Stage>
  );
}

export function Stack() {
  return (
    <Stage height={230}>
      <AgentToasts
        onDismiss={noop}
        toasts={[
          {
            id: 3,
            at: Date.now(),
            nonce: 3,
            op: "removed",
            kind: "map pin",
            mode: "map",
            agentName: "Claude",
            isClaude: true,
          },
          {
            id: 2,
            at: Date.now(),
            nonce: 2,
            op: "updated",
            kind: "spreadsheet",
            mode: "sheets",
            agentName: "Ops bot",
            isClaude: false,
          },
          {
            id: 1,
            at: Date.now(),
            nonce: 1,
            op: "created",
            kind: "itinerary event",
            mode: "itinerary",
            agentName: "Claude",
            isClaude: true,
          },
        ]}
      />
    </Stage>
  );
}
