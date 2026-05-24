import { useState } from "react";

interface Props {
  onJoin: (code: string) => void;
}

export default function Landing({ onJoin }: Props) {
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate() {
    const name = prompt("Canvas name (e.g. Tokyo Trip):");
    if (!name?.trim()) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/canvases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const canvas = (await res.json()) as { code: string };
      onJoin(canvas.code);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length !== 8) {
      setError("Canvas codes are 8 characters (e.g. TOKYO7X3K)");
      return;
    }
    onJoin(clean);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Tandem</h1>
          <p className="mt-1 text-sm text-gray-500">
            You and your agents, in tandem.
          </p>
        </div>

        <div className="space-y-4">
          <button
            onClick={handleCreate}
            disabled={creating}
            className="w-full py-3 px-4 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create new canvas"}
          </button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200" />
            </div>
            <div className="relative flex justify-center text-xs text-gray-400">
              <span className="bg-gray-50 px-2">or join existing</span>
            </div>
          </div>

          <form onSubmit={handleJoin} className="space-y-2">
            <input
              value={code}
              onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(""); }}
              placeholder="Canvas code (e.g. TOKYO7X3K)"
              maxLength={8}
              className="w-full px-4 py-3 border border-gray-300 rounded-xl text-sm font-mono tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <button
              type="submit"
              className="w-full py-3 px-4 bg-white border border-gray-300 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors"
            >
              Open canvas
            </button>
          </form>

          {error && (
            <p className="text-sm text-red-600 text-center">{error}</p>
          )}
        </div>

        <p className="text-xs text-center text-gray-400">
          Share the 8-character code with teammates or your agents to collaborate.
        </p>
      </div>
    </div>
  );
}
