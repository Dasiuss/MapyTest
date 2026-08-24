import { useEffect, useRef } from 'react'
import {
  Map,
  NavigationControl,
  AttributionControl,
  ScaleControl,
  FullscreenControl,
  setWorkerUrl,
} from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'

setWorkerUrl(maplibreWorkerUrl)

const TOPO_TILES = 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png'
const OPENSNOWMAP_PISTES_TILES =
  'https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png'
const TERRAIN_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

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
        sources: {
          topo: {
            type: 'raster',
            tiles: [TOPO_TILES],
            tileSize: 256,
            maxzoom: 17,
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
          },
          pistes: {
            type: 'raster',
            tiles: [OPENSNOWMAP_PISTES_TILES],
            tileSize: 256,
            maxzoom: 18,
            attribution:
              '&copy; <a href="https://www.opensnowmap.org">OpenSnowMap</a>',
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
          },
        },
        layers: [
          { id: 'topo', type: 'raster', source: 'topo' },
          { id: 'pistes', type: 'raster', source: 'pistes' },
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
              'line-color': '#e63946',
              'line-width': 4.5,
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
          exaggeration: 1.5,
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

  return (
    <div className="map-wrap">
      <div ref={mapContainer} className="map" />
    </div>
  )
}

export default App
