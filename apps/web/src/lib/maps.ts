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

// Built-in fallback presets used when running without a backend (VITE_MOCK=1).
// Keep these in sync with apps/api/internal/maps/assets/*.json.
const CARTO_VOYAGER = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const CARTO_ATTRIBUTION = "© OpenStreetMap contributors © CARTO";
const BUILTIN_PRESETS: Record<string, MapDefinition> = {
  world: {
    id: "world", name: "World", description: "Global view",
    center: [20, 0], zoom: 2, minZoom: 1, maxZoom: 20,
    layers: [{ kind: "tile", url: CARTO_VOYAGER, attribution: CARTO_ATTRIBUTION }],
  },
  us: {
    id: "us", name: "United States", description: "Continental US",
    center: [39.5, -98.35], zoom: 4, minZoom: 3, maxZoom: 20,
    bounds: [[24.5, -125.0], [49.5, -66.5]],
    layers: [{ kind: "tile", url: CARTO_VOYAGER, attribution: CARTO_ATTRIBUTION }],
  },
  tokyo: {
    id: "tokyo", name: "Tokyo", description: "Greater Tokyo area",
    center: [35.6762, 139.6503], zoom: 12, minZoom: 8, maxZoom: 20,
    layers: [{ kind: "tile", url: CARTO_VOYAGER, attribution: CARTO_ATTRIBUTION }],
  },
  japan: {
    id: "japan", name: "Japan", description: "All of Japan",
    center: [36.5, 138.0], zoom: 5, minZoom: 4, maxZoom: 20,
    layers: [{ kind: "tile", url: CARTO_VOYAGER, attribution: CARTO_ATTRIBUTION }],
  },
};

export function resolveMap(id: string): Promise<MapDefinition> {
  const cached = defCache.get(id);
  if (cached) return cached;

  if (MOCK_ENABLED) {
    const preset = BUILTIN_PRESETS[id] ?? BUILTIN_PRESETS.world;
    const p = Promise.resolve(preset);
    defCache.set(id, p);
    return p;
  }

  const p = fetch(`/api/maps/${encodeURIComponent(id)}`).then(r => {
    if (!r.ok) {
      defCache.delete(id);
      throw new Error(`map ${id} not found`);
    }
    return r.json() as Promise<MapDefinition>;
  });
  defCache.set(id, p);
  return p;
}

export function listMaps(): Promise<MapSummary[]> {
  if (listCache) return listCache;
  if (MOCK_ENABLED) {
    listCache = Promise.resolve(
      Object.values(BUILTIN_PRESETS).map(({ id, name, description }) => ({ id, name, description }))
    );
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
