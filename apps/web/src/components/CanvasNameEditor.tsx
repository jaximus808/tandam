import { useEffect, useRef, useState } from "react";

// The canvas name in the header. For a non-owner it's a plain label; for the
// owner it's click-to-rename in place — click the name, edit, Enter/blur saves,
// Escape cancels. The parent owns the optimistic update + revert (onSubmit
// resolves on success and rejects on failure), so a failed save snaps back to
// the old name and the live WS broadcast reconciles every other viewer.
const MAX_LEN = 120;

export default function CanvasNameEditor({
  name,
  canEdit,
  onSubmit,
}: {
  name: string;
  canEdit: boolean;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the draft in sync with the source name whenever we're not actively
  // editing (a live rename from another viewer, or a revert, updates the label).
  useEffect(() => {
    if (!editing) setValue(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (!canEdit) {
    return (
      <span className="font-display text-[15px] font-medium leading-tight text-ink truncate">
        {name}
      </span>
    );
  }

  const commit = async () => {
    const next = value.trim();
    if (saving) return;
    if (next === "" || next === name) {
      setEditing(false);
      setValue(name);
      return;
    }
    setSaving(true);
    try {
      await onSubmit(next);
      setEditing(false);
    } catch {
      // Parent reverted its state; snap the field back to the old name.
      setValue(name);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        maxLength={MAX_LEN}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setValue(name);
            setEditing(false);
          }
        }}
        className="font-display text-[15px] font-medium leading-tight text-ink bg-surface rounded-[3px] border border-ink/15 px-1 py-px outline-none focus:border-ink/30 min-w-0 max-w-[40vw]"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename this canvas"
      className="font-display text-[15px] font-medium leading-tight text-ink truncate rounded-[3px] px-1 -mx-1 transition-colors hover:bg-ink/5"
    >
      {name}
    </button>
  );
}
