import { useEffect, useRef } from 'react'
import {
  Map,
  NavigationControl,
  AttributionControl,
  ScaleControl,
  FullscreenControl,
  setWorkerUrl,
  Popup,
} from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'

setWorkerUrl(maplibreWorkerUrl)

const TOPO_TILES = 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png'
const TERRAIN_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'

const OVERPASS_QUERY = `
[out:json][timeout:30];
(
  way["piste:type"](46.85,10.75,47.10,11.05);
  relation["piste:type"](46.85,10.75,47.10,11.05);
  way["aerialway"](46.85,10.75,47.10,11.05);
);
out body geom;
`

const DIFFICULTY_COLORS = {
  novice: '#22c55e',
  easy: '#3b82f6',
  intermediate: '#ef4444',
  advanced: '#111827',
  expert: '#f97316',
  freeride: '#eab308',
}

const DIFFICULTY_MATCH = [
  'match',
  ['get', 'difficulty'],
  ...Object.entries(DIFFICULTY_COLORS).flat(),
  '#888888',
]

const WARNING_COLOR_MATCH = [
  'match',
  ['get', 'difficulty'],
  'advanced', '#e5e7eb',
  '#374151',
]
const WARNING_DASH = [2, 10]

const GEOM_LINE = ['==', ['geometry-type'], 'LineString']
const GEOM_POLYGON = ['==', ['geometry-type'], 'Polygon']

const DIFFICULTY_LABELS = {
  novice: 'zielona (bardzo łatwa)',
  easy: 'niebieska (łatwa)',
  intermediate: 'czerwona (średnia)',
  advanced: 'czarna (trudna)',
  expert: 'czarna (ekspert)',
  freeride: 'freeride (nieoznaczona)',
}

const AERIALWAY_LABELS = {
  chair_lift: 'krzesełkowy',
  gondola: 'gondolowy',
  cable_car: 'kolejka linowa',
  drag_lift: 'orczyk',
  't-bar': 'orczyk (T)',
  'j-bar': 'orczyk (J)',
  platter: 'talerczyk',
  rope_tow: 'wyrwirączka',
  magic_carpet: 'taśma',
  mixed_lift: 'gondola+krzesełka',
  zip_line: 'tyrolka',
}

function toLineString(el) {
  return { type: 'LineString', coordinates: el.geometry.map((n) => [n.lon, n.lat]) }
}

function toPisteGeometry(el) {
  const coords = el.geometry.map((n) => [n.lon, n.lat])
  if (coords.length >= 4) {
    const first = coords[0]
    const last = coords[coords.length - 1]
    if (first[0] === last[0] && first[1] === last[1]) {
      return { type: 'Polygon', coordinates: [coords] }
    }
  }
  return { type: 'LineString', coordinates: coords }
}

function overpassToLayers(data) {
  const pistes = []
  const lifts = []
  for (const el of data.elements) {
    if (!el.geometry || el.geometry.length < 2) continue
    const tags = el.tags ?? {}
    if (tags.aerialway) {
      lifts.push({
        type: 'Feature',
        properties: {
          osmId: el.id,
          name: tags.name || tags.ref || null,
          aerialway: tags.aerialway,
        },
        geometry: toLineString(el),
      })
      continue
    }

    const pisteType = tags['piste:type'] || ''
    const types = pisteType.split(';').map((t) => t.trim())
    if (!types.includes('downhill')) continue

    const difficulty = tags['piste:difficulty'] || null
    const grooming = tags['piste:grooming'] || null

    if (grooming === 'no') continue
    if (difficulty === 'freeride') continue

    pistes.push({
      type: 'Feature',
      properties: {
        uid: `${el.type}/${el.id}`,
        osmId: el.id,
        osmType: el.type,
        name: tags.name || tags['piste:name'] || tags.ref || null,
        ref: tags.ref || null,
        label: tags.ref || tags.name || tags['piste:name'] || null,
        difficulty,
        pisteType,
        grooming,
        warning: grooming === 'backcountry' || grooming === 'mogul',
      },
      geometry: toPisteGeometry(el),
    })
  }
  return {
    pistes: { type: 'FeatureCollection', features: pistes },
    lifts: { type: 'FeatureCollection', features: lifts },
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function buildPopupHTML(fields) {
  return fields
    .map(
      ([key, value]) =>
        `<div class="popup-row"><span class="popup-key">${key}</span>` +
        `<span class="popup-val">${escapeHtml(value ?? '—')}</span></div>`,
    )
    .join('')
}

const SKI_CACHE_KEY = 'maptest:ski-data:v1'
const SKI_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function readCachedSkiData() {
  try {
    const raw = localStorage.getItem(SKI_CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeCachedSkiData(data) {
  try {
    localStorage.setItem(
      SKI_CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), data }),
    )
  } catch (err) {
    console.warn('Nie udało się zapisać cache', err)
  }
}

const RUN_WAYPOINTS = [
  [10.958, 46.9458],
  [10.955, 46.9468],
  [10.952, 46.9482],
  [10.949, 46.9498],
  [10.946, 46.9518],
  [10.9435, 46.954],
  [10.941, 46.9562],
  [10.9385, 46.9585],
  [10.936, 46.9608],
  [10.933, 46.963],
  [10.9295, 46.965],
  [10.9255, 46.9668],
  [10.921, 46.9683],
  [10.916, 46.9695],
  [10.911, 46.9705],
  [10.906, 46.9712],
  [10.9, 46.971],
  [10.894, 46.9703],
  [10.889, 46.97],
]

const RUN_SAMPLES = 4

const runTrack = RUN_WAYPOINTS.reduce((acc, wp, i) => {
  if (i === RUN_WAYPOINTS.length - 1) {
    acc.push(wp)
    return acc
  }
  const next = RUN_WAYPOINTS[i + 1]
  for (let s = 0; s < RUN_SAMPLES; s++) {
    const t = s / RUN_SAMPLES
    acc.push([wp[0] + (next[0] - wp[0]) * t, wp[1] + (next[1] - wp[1]) * t])
  }
  return acc
}, [])

const TRACK_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Gaislachkogl → Sölden' },
      geometry: { type: 'LineString', coordinates: runTrack },
    },
    {
      type: 'Feature',
      properties: { kind: 'start' },
      geometry: { type: 'Point', coordinates: runTrack[0] },
    },
    {
      type: 'Feature',
      properties: { kind: 'end' },
      geometry: { type: 'Point', coordinates: runTrack[runTrack.length - 1] },
    },
  ],
}

function App() {
  const mapContainer = useRef(null)
  const mapRef = useRef(null)

  useEffect(() => {
    if (mapRef.current) return

    const map = new Map({
      container: mapContainer.current,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          topo: {
            type: 'raster',
            tiles: [TOPO_TILES],
            tileSize: 256,
            maxzoom: 17,
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
          },
          terrain: {
            type: 'raster-dem',
            tiles: [TERRAIN_TILES],
            tileSize: 256,
            encoding: 'terrarium',
            maxzoom: 15,
            attribution:
              '&copy; <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
          },
          track: {
            type: 'geojson',
            data: TRACK_GEOJSON,
            lineMetrics: true,
          },
        },
        layers: [
          { id: 'topo', type: 'raster', source: 'topo' },
          {
            id: 'track-casing',
            type: 'line',
            source: 'track',
            filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': '#ffffff', 'line-width': 7 },
          },
          {
            id: 'track-line',
            type: 'line',
            source: 'track',
            filter: ['==', ['geometry-type'], 'LineString'],
            layout: {
              'line-cap': 'round',
              'line-join': 'round',
            },
            paint: {
              'line-color': '#2a9d8f',
              'line-width': 4.5,
              'line-gradient': [
                'interpolate',
                ['linear'],
                ['line-progress'],
                0, '#e63946',
                0.17, '#f4a261',
                0.33, '#e9c46a',
                0.5, '#2a9d8f',
                0.67, '#457b9d',
                0.83, '#5a67d8',
                1, '#6a4c93',
              ],
            },
          },
          {
            id: 'track-start',
            type: 'circle',
            source: 'track',
            filter: ['==', ['get', 'kind'], 'start'],
            paint: {
              'circle-radius': 7,
              'circle-color': '#2a9d8f',
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2.5,
            },
          },
          {
            id: 'track-end',
            type: 'circle',
            source: 'track',
            filter: ['==', ['get', 'kind'], 'end'],
            paint: {
              'circle-radius': 7,
              'circle-color': '#e63946',
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2.5,
            },
          },
        ],
        terrain: {
          source: 'terrain',
          exaggeration: 0.6,
        },
        sky: {
          'sky-color': '#a5d6f5',
          'horizon-color': '#f0f6fa',
          'fog-color': '#e8eef2',
          'horizon-fog-blend': 0.4,
          'fog-ground-blend': 0.4,
          'atmosphere-blend': 1,
        },
      },
      center: [10.887, 46.97],
      zoom: 12.5,
      pitch: 60,
      bearing: -20,
      maxPitch: 85,
      maxZoom: 19,
      attributionControl: false,
    })

    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right')
    map.addControl(new FullscreenControl(), 'top-right')
    map.addControl(new ScaleControl(), 'bottom-left')
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right')

    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadSkiData() {
      const map = mapRef.current
      if (!map) return
      if (!map.loaded()) {
        await new Promise((resolve) => map.once('load', resolve))
      }
      if (cancelled) return

      const cached = readCachedSkiData()
      const isFresh =
        cached && Date.now() - cached.fetchedAt < SKI_CACHE_TTL_MS

      let data
      if (isFresh) {
        data = cached.data
      } else {
        try {
          const res = await fetch(
            `${OVERPASS_ENDPOINT}?data=${encodeURIComponent(OVERPASS_QUERY)}`,
          )
          if (!res.ok) throw new Error(`Overpass ${res.status}`)
          data = await res.json()
          writeCachedSkiData(data)
        } catch (err) {
          if (cached) {
            console.warn('Pobieranie nieudane, używam zapisanego cache', err)
            data = cached.data
          } else {
            throw err
          }
        }
      }
      if (cancelled) return

      try {
        const { pistes, lifts } = overpassToLayers(data)

        map.addSource('pistes', {
          type: 'geojson',
          data: pistes,
          promoteId: 'uid',
        })
        map.addSource('lifts', { type: 'geojson', data: lifts })

        map.addLayer(
          {
            id: 'pistes-area-fill',
            type: 'fill',
            source: 'pistes',
            filter: GEOM_POLYGON,
            paint: {
              'fill-color': DIFFICULTY_MATCH,
              'fill-opacity': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                0.5,
                0.26,
              ],
            },
          },
          'track-casing',
        )
        map.addLayer(
          {
            id: 'pistes-area-outline',
            type: 'line',
            source: 'pistes',
            filter: GEOM_POLYGON,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                '#facc15',
                DIFFICULTY_MATCH,
              ],
              'line-width': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                3,
                1.5,
              ],
            },
          },
          'track-casing',
        )
        map.addLayer(
          {
            id: 'pistes-area-warning',
            type: 'line',
            source: 'pistes',
            filter: ['all', GEOM_POLYGON, ['get', 'warning']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': WARNING_COLOR_MATCH,
              'line-width': 2.5,
              'line-dasharray': WARNING_DASH,
            },
          },
          'track-casing',
        )
        map.addLayer(
          {
            id: 'pistes-casing',
            type: 'line',
            source: 'pistes',
            filter: GEOM_LINE,
            paint: {
              'line-color': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                '#facc15',
                '#ffffff',
              ],
              'line-width': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                10,
                6,
              ],
            },
          },
          'track-casing',
        )
        map.addLayer(
          {
            id: 'pistes-line',
            type: 'line',
            source: 'pistes',
            filter: GEOM_LINE,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': DIFFICULTY_MATCH,
              'line-width': 3,
              'line-opacity': 0.95,
            },
          },
          'track-casing',
        )
        map.addLayer(
          {
            id: 'pistes-warning-stripe',
            type: 'line',
            source: 'pistes',
            filter: ['all', GEOM_LINE, ['get', 'warning']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': WARNING_COLOR_MATCH,
              'line-width': 3,
              'line-dasharray': WARNING_DASH,
            },
          },
          'track-casing',
        )
        map.addLayer(
          {
            id: 'pistes-labels',
            type: 'symbol',
            source: 'pistes',
            filter: ['all', GEOM_LINE, ['has', 'label']],
            layout: {
              'symbol-placement': 'line',
              'symbol-spacing': 150,
              'text-field': ['get', 'label'],
              'text-font': ['Noto Sans Bold'],
              'text-size': 11,
              'text-letter-spacing': 0.08,
              'text-allow-overlap': true,
              'text-optional': true,
            },
            paint: {
              'text-color': '#0f172a',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.5,
            },
          },
          'track-casing',
        )
        map.addLayer(
          {
            id: 'pistes-hit-line',
            type: 'line',
            source: 'pistes',
            filter: GEOM_LINE,
            paint: { 'line-color': 'rgba(0, 0, 0, 0)', 'line-width': 18 },
          },
          'track-casing',
        )
        map.addLayer(
          {
            id: 'pistes-hit-area',
            type: 'fill',
            source: 'pistes',
            filter: GEOM_POLYGON,
            paint: { 'fill-color': 'rgba(0, 0, 0, 0)' },
          },
          'track-casing',
        )

        map.addLayer(
          {
            id: 'lifts-line',
            type: 'line',
            source: 'lifts',
            layout: { 'line-cap': 'round' },
            paint: {
              'line-color': '#dc2626',
              'line-width': 2.5,
              'line-dasharray': [2, 1.5],
            },
          },
          'track-casing',
        )
        map.addLayer(
          {
            id: 'lifts-hit',
            type: 'line',
            source: 'lifts',
            paint: { 'line-color': 'rgba(0, 0, 0, 0)', 'line-width': 18 },
          },
          'track-casing',
        )

        let selectedPisteId = null

        const handlePisteClick = (e) => {
          const feature = e.features[0]
          if (selectedPisteId !== null) {
            map.setFeatureState(
              { source: 'pistes', id: selectedPisteId },
              { selected: false },
            )
          }
          selectedPisteId = feature.id
          map.setFeatureState(
            { source: 'pistes', id: selectedPisteId },
            { selected: true },
          )

          const p = feature.properties
          const groomingLabel =
            p.grooming === 'backcountry'
              ? 'nieratrakowana (backcountry)'
              : p.grooming === 'mogul'
                ? 'muldy'
                : p.grooming || 'ratrakowana'
          new Popup()
            .setLngLat(e.lngLat)
            .setHTML(
              buildPopupHTML([
                ['Nazwa', p.name],
                ['Trudność', DIFFICULTY_LABELS[p.difficulty] ?? p.difficulty],
                ['Grooming', groomingLabel],
              ]),
            )
            .addTo(map)
        }

        map.on('click', 'pistes-hit-line', handlePisteClick)
        map.on('click', 'pistes-hit-area', handlePisteClick)

        map.on('click', 'lifts-hit', (e) => {
          const p = e.features[0].properties
          new Popup()
            .setLngLat(e.lngLat)
            .setHTML(
              buildPopupHTML([
                ['Nazwa', p.name],
                ['Rodzaj', AERIALWAY_LABELS[p.aerialway] ?? p.aerialway],
              ]),
            )
            .addTo(map)
        })

        map.on('click', (e) => {
          const hit = map.queryRenderedFeatures(e.point, {
            layers: ['pistes-hit-line', 'pistes-hit-area', 'lifts-hit'],
          })
          if (hit.length === 0 && selectedPisteId !== null) {
            map.setFeatureState(
              { source: 'pistes', id: selectedPisteId },
              { selected: false },
            )
            selectedPisteId = null
          }
        })

        for (const layerId of [
          'pistes-hit-line',
          'pistes-hit-area',
          'lifts-hit',
        ]) {
          map.on('mouseenter', layerId, () => {
            map.getCanvas().style.cursor = 'pointer'
          })
          map.on('mouseleave', layerId, () => {
            map.getCanvas().style.cursor = ''
          })
        }
      } catch (err) {
        console.error('Nie udało się pobrać danych z Overpass', err)
      }
    }

    loadSkiData()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="map-wrap">
      <div ref={mapContainer} className="map" />
    </div>
  )
}

export default App
