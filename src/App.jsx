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

// Obszar Sölden + lodowce (Rettenbach/Tiefenbach) — pokrywa się z bboxem Overpass.
// Format [west, south, east, north] — używany jako `bounds` źródeł raster/DEM,
// żeby nie pobierać i nie renderować kafelków poza tym obszarem.
const SOLDEN_BOUNDS = [10.75, 46.85, 11.05, 47.1]

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
            bounds: SOLDEN_BOUNDS,
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
          },
          terrain: {
            type: 'raster-dem',
            tiles: [TERRAIN_TILES],
            tileSize: 256,
            encoding: 'terrarium',
            maxzoom: 15,
            bounds: SOLDEN_BOUNDS,
            attribution:
              '&copy; <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
          },
        },
        layers: [
          { id: 'topo', type: 'raster', source: 'topo' },
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
      center: [10.9933, 46.96],
      zoom: 12.5,
      pitch: 40,
      bearing: 0,
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
          }
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
          }
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
          }
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
          }
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
          }
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
              'text-allow-overlap': false,
              'text-optional': true,
            },
            paint: {
              'text-color': '#0f172a',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.5,
            },
          }
        )
        map.addLayer(
          {
            id: 'pistes-hit-line',
            type: 'line',
            source: 'pistes',
            filter: GEOM_LINE,
            paint: { 'line-color': 'rgba(0, 0, 0, 0)', 'line-width': 18 },
          }
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
          }
        )
        map.addLayer(
          {
            id: 'lifts-hit',
            type: 'line',
            source: 'lifts',
            paint: { 'line-color': 'rgba(0, 0, 0, 0)', 'line-width': 18 },
          }
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
        map.on('click', 'pistes-area-fill', handlePisteClick)

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
            layers: ['pistes-hit-line', 'pistes-area-fill', 'lifts-hit'],
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
          'pistes-area-fill',
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
