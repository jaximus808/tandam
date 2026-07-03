import { ChevronsLeft } from "lucide-react";

/* SettingsPanel — a placeholder side-dock view for now. It reserves the slot in
   the activity bar so settings / future "extension" panels have a home; the body
   fills in later. Matches the Documents/Tasks panel frame so switching between
   them is seamless. */
export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-ink/10 px-3 py-3 pl-4">
        <span className="text-sm font-semibold text-ink">Settings</span>
        <button
          onClick={onClose}
          title="Hide settings"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink/35 transition-colors hover:bg-ink/5 hover:text-ink/60"
        >
          <ChevronsLeft size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="text-[12px] leading-relaxed text-ink/45">
          Nothing here yet. This panel is a placeholder — canvas settings and future
          extensions will live here.
        </p>
      </div>
    </>
  );
}
