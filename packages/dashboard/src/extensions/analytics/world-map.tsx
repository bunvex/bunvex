// The Realtime page's world map (UI-01 §26): mapcn's MapLibre map with an offline basemap — Natural Earth's
// 1:110m countries, bundled (world-atlas, public-domain data) and drawn in the theme's neutrals — and one bubble
// per city with live visitors, sized by how many, named in a tooltip. Loaded with the page's chunk
// only; where WebGL is missing (tests, some VMs) the page shows its country list instead (realtime.tsx).
import {
  MapControls,
  MapGeoJSON,
  MapMarker,
  Map as MapView,
  MarkerContent,
  MarkerTooltip,
  useMap,
} from "@bunvex/ui/components/map";
import { useEffect } from "react";
import { feature } from "topojson-client";
import countries110m from "world-atlas/countries-110m.json";
import type { LiveVisitor } from "./data-source.ts";

type Atlas = Parameters<typeof feature>[0] & { objects: { countries: Parameters<typeof feature>[1] } };
const atlas = countries110m as unknown as Atlas;
type Ring = [number, number][];

/**
 * Natural Earth's polygons that cross the antimeridian (Russia's far east, Fiji) jump from +180 to −180; drawn
 * flat they streak across the map. Unwrap each ring so consecutive points never jump more than 180°.
 */
export function unwrapRing(ring: Ring): Ring {
  const out: Ring = [];
  let shift = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon, lat] = ring[i]!;
    if (i > 0) {
      const prev = ring[i - 1]![0];
      if (lon - prev > 180) shift -= 360;
      else if (prev - lon > 180) shift += 360;
    }
    out.push([lon + shift, lat]);
  }
  return out;
}

const RAW = feature(atlas, atlas.objects.countries) as unknown as GeoJSON.FeatureCollection;
const WORLD: GeoJSON.FeatureCollection = {
  ...RAW,
  // Antarctica only takes room on a visitors' map
  features: RAW.features
    .filter((f) => f.id !== "010")
    .map((f) => {
      const g = f.geometry;
      if (g.type === "Polygon")
        return { ...f, geometry: { ...g, coordinates: (g.coordinates as Ring[]).map(unwrapRing) } };
      if (g.type === "MultiPolygon")
        return { ...f, geometry: { ...g, coordinates: (g.coordinates as Ring[][]).map((p) => p.map(unwrapRing)) } };
      return f;
    }),
};

type City = { key: string; city: string; country: string; lat: number; lon: number; visitors: number };

export function citiesOf(live: LiveVisitor[]): City[] {
  const by = new Map<string, City>();
  for (const v of live) {
    const key = `${v.countryCode}:${v.city ?? "?"}`;
    const c = by.get(key);
    if (c) {
      c.visitors++;
      c.lat += (v.lat - c.lat) / c.visitors;
      c.lon += (v.lon - c.lon) / c.visitors;
    } else
      by.set(key, { key, city: v.city ?? "Unknown city", country: v.country, lat: v.lat, lon: v.lon, visitors: 1 });
  }
  return [...by.values()].sort((a, b) => b.visitors - a.visitors);
}

/** A bubble's diameter in px: area grows with the count, from 8 to 40 px. */
export const bubbleSize = (n: number, max: number) => Math.round(8 + 32 * Math.sqrt(n / Math.max(1, max)));

/** Frames the inhabited world in the map's box. */
function FitWorld() {
  const { map, isLoaded } = useMap();
  useEffect(() => {
    if (!map || !isLoaded) return;
    map.fitBounds(
      [
        [-165, -50],
        [175, 72],
      ],
      { padding: 16, animate: false },
    );
  }, [map, isLoaded]);
  return null;
}

export default function WorldMap({ live }: { live: LiveVisitor[] }) {
  const cities = citiesOf(live);
  const max = cities[0]?.visitors ?? 1;
  return (
    <MapView
      blank
      minZoom={0.3}
      maxZoom={6}
      renderWorldCopies={false}
      attributionControl={false}
      className="h-full w-full"
    >
      <FitWorld />
      <MapGeoJSON id="countries" data={WORLD as never} />
      {cities.map((c) => {
        const size = bubbleSize(c.visitors, max);
        return (
          <MapMarker key={c.key} longitude={c.lon} latitude={c.lat}>
            <MarkerContent>
              <span
                aria-hidden="true"
                className="block rounded-full border-2 border-background bg-info/70 motion-safe:animate-pulse"
                style={{ width: size, height: size }}
              />
            </MarkerContent>
            <MarkerTooltip>
              <span className="rounded border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm">
                {c.city}, {c.country} · {c.visitors} {c.visitors === 1 ? "visitor" : "visitors"}
              </span>
            </MarkerTooltip>
          </MapMarker>
        );
      })}
      <MapControls position="bottom-right" showZoom />
    </MapView>
  );
}
