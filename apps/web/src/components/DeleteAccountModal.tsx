import { useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Trash2 } from "lucide-react";

// The word the user must type to arm the delete button. Account deletion is a
// step beyond canvas deletion (which uses a plain confirm — DeleteCanvasModal):
// it takes the account AND every owned canvas with it, so we require
// type-to-confirm.
const CONFIRM_WORD = "DELETE";

/* Type-to-confirm modal for permanently deleting the signed-in account and
   every canvas it owns. Styled after DeleteCanvasModal; portalled to <body>
   for the same containing-block reasons. The confirm button stays disabled
   until the user types DELETE, and everything locks while the request is in
   flight so a double-click can't race. */
export default function DeleteAccountModal({
  email,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  email: string;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const armed = typed.trim() === CONFIRM_WORD;

  return createPortal(
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4">
      <button
        aria-label="Cancel"
        onClick={() => {
          if (!deleting) onCancel();
        }}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        className="relative w-full max-w-md rounded-[10px] border border-ink/10 bg-surface p-6 shadow-lg"
      >
        <div className="flex items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 id="delete-account-title" className="text-lg font-semibold tracking-tight">
              Delete your account?
            </h2>
            <p className="mt-1.5 text-sm text-ink/60">
              <span className="font-medium text-ink">{email}</span> and every canvas you own will
              be permanently deleted — including canvases you’ve shared with others. Canvases other
              people shared with you are unaffected. This can’t be undone.
            </p>
          </div>
        </div>

        <label className="mt-5 block">
          <span className="text-xs font-medium text-ink/60">
            Type <span className="font-code font-semibold text-rose-600 dark:text-rose-400">{CONFIRM_WORD}</span> to
            confirm
          </span>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && armed && !deleting) onConfirm();
            }}
            disabled={deleting}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={CONFIRM_WORD}
            className="mt-1.5 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-code text-sm text-ink placeholder:text-ink/25 focus:border-rose-500/50 focus:outline-none focus:ring-2 focus:ring-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        {error && (
          <p className="mt-4 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="rounded-md border border-ink/15 bg-surface px-4 py-2 text-sm font-medium text-ink/70 transition-colors hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!armed || deleting}
            className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting…" : "Delete account"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
