import { useState } from "react";
import type { PendingEdit } from "../types";
import { sendOp } from "../lib/ws";

interface Props {
  entityId: string;
  pendingEdits: PendingEdit[];
  children: React.ReactNode;
}

export default function ScopedEdit({ entityId, pendingEdits, children }: Props) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const pending = pendingEdits.some((e) => e.entityId === entityId);

  function submit() {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    sendOp({ op: "scoped_edit_request", entityId, instruction: trimmed });
    setInstruction("");
    setOpen(false);
  }

  return (
    <div className="relative group">
      <div
        onClick={() => setOpen((o) => !o)}
        className={[
          "cursor-pointer rounded transition-all",
          pending
            ? "ring-2 ring-yellow-400 bg-yellow-50"
            : "hover:ring-2 hover:ring-blue-300",
        ].join(" ")}
      >
        {children}
        {pending && (
          <span className="inline-block ml-2 text-xs bg-yellow-100 text-yellow-700 rounded px-1.5 py-0.5">
            queued for Claude
          </span>
        )}
      </div>

      {open && (
        <div className="mt-1.5 flex gap-1.5">
          <input
            autoFocus
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Tell Claude what to change…"
            className="flex-1 text-sm border border-gray-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            onClick={submit}
            className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            →
          </button>
          <button
            onClick={() => setOpen(false)}
            className="text-sm px-2 text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
