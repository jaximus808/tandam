import { useEffect, useState } from "react";
import { resolveMap, type MapDefinition } from "./maps";

interface State {
  map?: MapDefinition;
  error?: Error;
  loading: boolean;
}

export function useMapDefinition(id: string): State {
  const [state, setState] = useState<State>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    resolveMap(id)
      .then((map) => { if (!cancelled) setState({ map, loading: false }); })
      .catch((error: Error) => { if (!cancelled) setState({ error, loading: false }); });
    return () => { cancelled = true; };
  }, [id]);

  return state;
}
