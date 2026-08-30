import { Fragment, useEffect, useRef, useState } from 'react'
import {
  Map as MapLibreMap,
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
  relation["site"="piste"](46.85,10.75,47.10,11.05);
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

const MENU_COLLATOR = new Intl.Collator('pl', {
  numeric: true,
  sensitivity: 'base',
})

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
  const siteRelations = []
  const routeRelations = []

  for (const el of data.elements) {
    const tags = el.tags ?? {}
    if (el.type === 'relation' && tags.site === 'piste') {
      siteRelations.push(el)
    } else if (el.type === 'relation' && tags['piste:type']) {
      routeRelations.push(el)
    }
  }

  // Członek (way/relation) -> nazwa ośrodka (z relacji site=piste).
  const memberToSite = new Map()
  for (const site of siteRelations) {
    const name = site.tags?.name || null
    for (const m of site.members ?? []) {
      if (m.type === 'node') continue
      memberToSite.set(`${m.type}/${m.ref}`, name)
    }
  }

  // Zagnieżdżenie: way -> route=piste relacja -> site.
  const wayToRoute = new Map()
  for (const route of routeRelations) {
    for (const m of route.members ?? []) {
      if (m.type === 'way') wayToRoute.set(`way/${m.ref}`, route.id)
    }
  }
  const routeToSite = new Map()
  for (const route of routeRelations) {
    const site = memberToSite.get(`relation/${route.id}`)
    if (site) routeToSite.set(route.id, site)
  }

  const siteFor = (type, id) => {
    const direct = memberToSite.get(`${type}/${id}`)
    if (direct) return direct
    if (type === 'way') {
      const routeId = wayToRoute.get(`way/${id}`)
      if (routeId != null) return routeToSite.get(routeId) ?? null
    }
    return null
  }

  const pistes = []
  const lifts = []
  for (const el of data.elements) {
    if (!el.geometry || el.geometry.length < 2) continue
    const tags = el.tags ?? {}
    if (el.type === 'relation' && tags.site === 'piste') continue

    if (tags.aerialway) {
      lifts.push({
        type: 'Feature',
        properties: {
          uid: `${el.type}/${el.id}`,
          osmId: el.id,
          name: tags.name || tags.ref || null,
          aerialway: tags.aerialway,
          site: siteFor(el.type, el.id),
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
        site: siteFor(el.type, el.id),
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

const SKI_CACHE_KEY = 'maptest:ski-data:v2'
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
  const selectedRef = useRef(null)
  const featuresRef = useRef(new Map())
  const blinkRef = useRef(0)

  const [selected, setSelected] = useState(null)
  const [items, setItems] = useState([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [search, setSearch] = useState('')

  function selectFeature(source, ids) {
    const map = mapRef.current
    if (!map) return
    blinkRef.current += 1
    const prev = selectedRef.current
    if (prev) {
      for (const id of prev.ids) {
        map.setFeatureState({ source: prev.source, id }, { selected: false })
      }
    }
    for (const id of ids) {
      map.setFeatureState({ source, id }, { selected: true })
    }
    const next = { source, ids }
    selectedRef.current = next
    setSelected(next)
  }

  function clearSelection() {
    const map = mapRef.current
    blinkRef.current += 1
    const prev = selectedRef.current
    if (prev && map) {
      for (const id of prev.ids) {
        map.setFeatureState({ source: prev.source, id }, { selected: false })
      }
    }
    selectedRef.current = null
    setSelected(null)
  }

  function blinkSelection(source, ids) {
    const map = mapRef.current
    if (!map) return
    const token = ++blinkRef.current
    const pulses = [false, true, false, true, false, true, false, true, false, true]
    pulses.forEach((on, i) => {
      setTimeout(() => {
        if (token !== blinkRef.current) return
        for (const id of ids) {
          map.setFeatureState({ source, id }, { selected: on })
        }
      }, 180 * (i + 1))
    })
  }

  function flyToItem(item) {
    const map = mapRef.current
    if (!map) return
    const coords = []
    for (const id of item.ids) {
      const f = featuresRef.current.get(id)
      if (!f || !f.geometry) continue
      const c =
        f.geometry.type === 'Polygon'
          ? f.geometry.coordinates[0]
          : f.geometry.coordinates
      for (const p of c) coords.push(p)
    }
    if (!coords.length) return
    let w = Infinity
    let s = Infinity
    let e = -Infinity
    let n = -Infinity
    for (const [lng, lat] of coords) {
      if (lng < w) w = lng
      if (lng > e) e = lng
      if (lat < s) s = lat
      if (lat > n) n = lat
    }
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      {
        padding: 80,
        maxZoom: 13,
        bearing: map.getBearing(),
        pitch: map.getPitch(),
        duration: 600,
      },
    )
  }

  useEffect(() => {
    if (mapRef.current) return

    const map = new MapLibreMap({
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
        map.addSource('lifts', {
          type: 'geojson',
          data: lifts,
          promoteId: 'uid',
        })

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
              'line-color': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                '#facc15',
                '#dc2626',
              ],
              'line-width': [
                'case',
                ['boolean', ['feature-state', 'selected'], false],
                5,
                2.5,
              ],
              'line-dasharray': [2, 1.5],
            },
          }
        )
        map.addLayer(
          {
            id: 'lifts-labels',
            type: 'symbol',
            source: 'lifts',
            filter: ['has', 'name'],
            layout: {
              'symbol-placement': 'line-center',
              'text-field': ['get', 'name'],
              'text-font': ['Noto Sans Bold'],
              'text-size': 11,
              'text-offset': [0, 0.6],
              'text-allow-overlap': false,
            },
            paint: {
              'text-color': '#7f1d1d',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.5,
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

        const uidToGroup = new Map()
        const uidToFeature = new Map()

        const groupFeatures = (features, labelFn, colorFn) => {
          const groups = new Map()
          for (const f of features) {
            const label = labelFn(f)
            const site = f.properties.site || null
            const key = `${site ?? ''}\u0000${label || f.properties.uid}`
            if (!groups.has(key)) {
              groups.set(key, {
                label,
                site,
                color: colorFn(f),
                aerialway: f.properties.aerialway,
                ids: [],
              })
            }
            groups.get(key).ids.push(f.properties.uid)
          }
          return groups
        }

        const pisteItems = Array.from(
          groupFeatures(
            pistes.features,
            (f) => f.properties.label || f.properties.name,
            (f) => DIFFICULTY_COLORS[f.properties.difficulty] || '#888888',
          ).values(),
        ).map((g) => ({
          source: 'pistes',
          ids: g.ids,
          label: g.label || 'Trasa (bez nazwy)',
          site: g.site,
          color: g.color,
          kind: 'trasa',
        }))
        const liftItems = Array.from(
          groupFeatures(
            lifts.features,
            (f) => f.properties.name,
            () => '#7c3aed',
          ).values(),
        ).map((g) => ({
          source: 'lifts',
          ids: g.ids,
          label: g.label || 'Wyciąg (bez nazwy)',
           site: g.site,
           color: g.color,
           kind: 'wyciąg',
           displayLabel: `${g.label || 'Wyciąg'} (${
             AERIALWAY_LABELS[g.aerialway] ?? g.aerialway ?? 'nieznany'
           })`,
         }))

        for (const item of [...pisteItems, ...liftItems]) {
          for (const id of item.ids) {
            uidToGroup.set(id, item)
          }
        }
        for (const f of [...pistes.features, ...lifts.features]) {
          uidToFeature.set(f.properties.uid, f)
        }
        featuresRef.current = uidToFeature

        const siteRank = (site) => {
          if (site === 'Sölden') return 0
          if (!site) return 2
          return 1
        }

        setItems(
          [...pisteItems, ...liftItems].sort(
            (a, b) =>
              siteRank(a.site) - siteRank(b.site) ||
              MENU_COLLATOR.compare(a.site || '', b.site || '') ||
              (a.kind === b.kind ? 0 : a.kind === 'trasa' ? -1 : 1) ||
              MENU_COLLATOR.compare(a.label, b.label) ||
              MENU_COLLATOR.compare(a.displayLabel || '', b.displayLabel || ''),
          ),
        )

        const handlePisteClick = (e) => {
          const feature = e.features[0]
          const group =
            uidToGroup.get(feature.id) ||
            { source: 'pistes', ids: [feature.id] }
          selectFeature(group.source, group.ids)

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
          const feature = e.features[0]
          const group =
            uidToGroup.get(feature.id) ||
            { source: 'lifts', ids: [feature.id] }
          selectFeature(group.source, group.ids)
          const p = feature.properties
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
          if (hit.length === 0) {
            clearSelection()
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

  const filteredItems = items.filter((it) =>
    (it.displayLabel || it.label)
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  )

  return (
    <div className="map-wrap">
      <div ref={mapContainer} className="map" />
      <button
        className={`menu-toggle${menuOpen ? ' open' : ''}`}
        onClick={() => setMenuOpen((o) => !o)}
        aria-label="Menu tras i wyciągów"
      >
        {menuOpen ? '✕' : '☰'}
      </button>
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <input
          className="sidebar-search"
          type="search"
          placeholder="Szukaj trasy lub wyciągu…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul className="sidebar-list">
          {filteredItems.map((it, i) => {
            const prev = filteredItems[i - 1]
            const sectionName = it.site || 'Inne'
            const sameSite = prev && (prev.site || 'Inne') === sectionName
            const showSection = i === 0 || !sameSite
            const showKind =
              !sameSite || prev.kind !== it.kind
            return (
              <Fragment key={`${it.source}/${it.ids[0]}`}>
                {showSection && (
                  <li className="sidebar-section">{sectionName}</li>
                )}
                {showKind && (
                  <li className="sidebar-subsection">
                    {it.kind === 'trasa' ? 'Trasy' : 'Wyciągi'}
                  </li>
                )}
                <li>
                  <button
                    className={`sidebar-item${
                      selected &&
                      selected.source === it.source &&
                      selected.ids[0] === it.ids[0]
                        ? ' active'
                        : ''
                    }`}
                    onClick={() => {
                      selectFeature(it.source, it.ids)
                      blinkSelection(it.source, it.ids)
                    }}
                    onDoubleClick={() => flyToItem(it)}
                  >
                    <span className="sidebar-item-label">
                      {it.displayLabel || it.label}
                    </span>
                    <span
                      className="sidebar-kind"
                      style={{ background: it.color }}
                    >
                      {it.kind}
                    </span>
                  </button>
                </li>
              </Fragment>
            )
          })}
        </ul>
      </aside>
    </div>
  )
}

export default App
