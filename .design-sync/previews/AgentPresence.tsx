import { AgentPresence } from "web";

// Header presence: who's in the room (agents as square chips — terracotta for
// Claude, ink for others) plus a live status chip. Priority: editing (a
// clickable chip in the mode's colour) → reading (a scanning equaliser) → idle
// ("here"). The component is `hidden sm:flex`, so it only shows at >=640px —
// captured in a wide card (see cfg.overrides.AgentPresence). `onJump` is a
// no-op in previews.

const noop = () => {};

export function Editing() {
  return (
    <AgentPresence
      agents={[{ name: "Claude", isClaude: true }]}
      edit={{ entityId: "row-4", mode: "sheets" }}
      reading={false}
      onJump={noop}
    />
  );
}

export function Reading() {
  return (
    <AgentPresence
      agents={[{ name: "Claude", isClaude: true }]}
      edit={null}
      reading={true}
      onJump={noop}
    />
  );
}

export function Idle() {
  return (
    <AgentPresence
      agents={[
        { name: "Claude", isClaude: true },
        { name: "Ops bot", isClaude: false },
      ]}
      edit={null}
      reading={false}
      onJump={noop}
    />
  );
}
