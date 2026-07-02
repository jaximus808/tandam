import { EmptyState } from "web";

// A mode with nothing in it yet: a dashed placeholder frame with corner
// selection handles, styled like an unplaced object on the worksurface.
// Wrapped in a sized flex parent because EmptyState uses `flex-1` and fills
// its container.

function Frame({ children }: { children: React.ReactNode }) {
  return <div style={{ height: 300, display: "flex" }}>{children}</div>;
}

export function WithHint() {
  return (
    <Frame>
      <EmptyState
        title="No events yet"
        hint="Add your first itinerary stop, or ask an agent to draft a day plan."
      />
    </Frame>
  );
}

export function TitleOnly() {
  return (
    <Frame>
      <EmptyState title="This roadmap is empty" />
    </Frame>
  );
}

export function Sheets() {
  return (
    <Frame>
      <EmptyState
        title="No rows in this sheet"
        hint="Add a column and a row to start, or hand it to Claude to fill in."
      />
    </Frame>
  );
}
