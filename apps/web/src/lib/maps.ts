export type MapLayer =
  | { kind: "tile"; url: string; attribution: string; minZoom?: number; maxZoom?: number }
  | { kind: "geojson"; url: string; style?: Record<string, unknown> };

export type MapDefinition = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  center: [number, number];
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  bounds?: [[number, number], [number, number]];
  layers: MapLayer[];
  thumbnail?: string;
};

export type MapSummary = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  thumbnail?: string;
};

const defCache = new Map<string, Promise<MapDefinition>>();
let listCache: Promise<MapSummary[]> | null = null;

const MOCK_ENABLED = import.meta.env.VITE_MOCK === "1";

// The one built-in preset — the Continental US voyager map. Kept in sync with
// apps/api/internal/maps/assets/us.json. It's the only available base map (the
// old world/japan/tokyo presets were dropped), and also the fallback whenever an
// id can't be resolved — including legacy canvases that still reference a removed
// preset, so their maps render as US instead of erroring.
const CARTO_VOYAGER = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const CARTO_ATTRIBUTION = "© OpenStreetMap contributors © CARTO";
const US_PRESET: MapDefinition = {
  id: "us", name: "United States", description: "Continental US",
  center: [39.5, -98.35], zoom: 4, minZoom: 3, maxZoom: 20,
  bounds: [[24.5, -125.0], [49.5, -66.5]],
  layers: [{ kind: "tile", url: CARTO_VOYAGER, attribution: CARTO_ATTRIBUTION }],
};

export function resolveMap(id: string): Promise<MapDefinition> {
  const cached = defCache.get(id);
  if (cached) return cached;

  if (MOCK_ENABLED) {
    const p = Promise.resolve(US_PRESET);
    defCache.set(id, p);
    return p;
  }

  const p = fetch(`/api/maps/${encodeURIComponent(id)}`)
    .then(r => (r.ok ? (r.json() as Promise<MapDefinition>) : US_PRESET))
    // Network error or a removed/legacy preset → fall back to the US map rather
    // than white-screening the canvas.
    .catch(() => US_PRESET);
  defCache.set(id, p);
  return p;
}

export function listMaps(): Promise<MapSummary[]> {
  if (listCache) return listCache;
  if (MOCK_ENABLED) {
    const { id, name, description } = US_PRESET;
    listCache = Promise.resolve([{ id, name, description }]);
    return listCache;
  }
  listCache = fetch("/api/maps")
    .then(r => r.json())
    .then((j: { maps: MapSummary[] }) => j.maps)
    .catch(err => {
      listCache = null;
      throw err;
    });
  return listCache;
}
