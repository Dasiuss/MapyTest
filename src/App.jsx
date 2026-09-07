import { Fragment, useEffect, useRef, useState } from 'react'
import distance from '@turf/distance'
import { point } from '@turf/helpers'
import {
  Map as MapLibreMap,
  NavigationControl,
  AttributionControl,
  ScaleControl,
  FullscreenControl,
  setWorkerUrl,
  Popup,
  Marker,
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
  easy: '#60a5fa',
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
const ROUTE_SNAP_RADIUS_M = 100
const ROUTE_CONNECT_RADIUS_M = 100
const ROUTE_ELEVATION_TOLERANCE_M = 15
const ROUTE_COLOR = '#1557b0'
const METERS_PER_DEGREE = 111320
const HOME_COORDINATES = [11.0095, 46.9726666667]

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

function coordinateDistance(a, b) {
  return distance(point(a), point(b), { units: 'meters' })
}

function normalizeRouteFeatures(features, source, kind) {
  return features
    .filter(
      (feature) =>
        feature.geometry?.type === 'LineString' &&
        feature.geometry.coordinates.length >= 2,
    )
    .map((feature) => {
      const coordinates = feature.geometry.coordinates
      const segments = []
      let length = 0
      let west = Infinity
      let south = Infinity
      let east = -Infinity
      let north = -Infinity

      for (let i = 0; i < coordinates.length; i += 1) {
        const [lng, lat] = coordinates[i]
        west = Math.min(west, lng)
        south = Math.min(south, lat)
        east = Math.max(east, lng)
        north = Math.max(north, lat)
        if (i === 0) continue
        const segmentLength = coordinateDistance(
          coordinates[i - 1],
          coordinates[i],
        )
        segments.push({
          start: coordinates[i - 1],
          end: coordinates[i],
          location: length,
          length: segmentLength,
          bbox: [
            Math.min(coordinates[i - 1][0], coordinates[i][0]),
            Math.min(coordinates[i - 1][1], coordinates[i][1]),
            Math.max(coordinates[i - 1][0], coordinates[i][0]),
            Math.max(coordinates[i - 1][1], coordinates[i][1]),
          ],
        })
        length += segmentLength
      }

      return {
        uid: feature.properties.uid,
        source,
        kind,
        properties: feature.properties,
        coordinates,
        segments,
        bbox: [west, south, east, north],
        length,
      }
    })
    .filter((feature) => feature.length > 0)
}

function routeFeatureLabel(feature) {
  if (feature.kind === 'trasa') {
    return feature.properties.label || feature.properties.name || 'Trasa'
  }
  return feature.properties.name || 'Wyciąg'
}

function terrainElevation(map, coordinates) {
  try {
    const elevation = map.queryTerrainElevation(coordinates, {
      exaggerated: false,
    })
    return Number.isFinite(elevation) ? elevation : null
  } catch {
    return null
  }
}

function isWithinRouteBounds(coordinates, feature, radius) {
  const [lng, lat] = coordinates
  const latRadius = radius / METERS_PER_DEGREE
  const lngRadius =
    radius /
    (METERS_PER_DEGREE * Math.max(Math.cos((lat * Math.PI) / 180), 0.1))
  return (
    lng >= feature.bbox[0] - lngRadius &&
    lng <= feature.bbox[2] + lngRadius &&
    lat >= feature.bbox[1] - latRadius &&
    lat <= feature.bbox[3] + latRadius
  )
}

function areBboxesWithinDistance(first, second, radius) {
  const latitude =
    (first[1] + first[3] + second[1] + second[3]) / 4
  const latRadius = radius / METERS_PER_DEGREE
  const lngRadius =
    radius /
    (METERS_PER_DEGREE * Math.max(Math.cos((latitude * Math.PI) / 180), 0.1))
  return !(
    first[2] + lngRadius < second[0] ||
    second[2] + lngRadius < first[0] ||
    first[3] + latRadius < second[1] ||
    second[3] + latRadius < first[1]
  )
}

function closestSegmentPoints(firstSegment, secondSegment) {
  const origin = firstSegment.start
  const latitude =
    (firstSegment.start[1] +
      firstSegment.end[1] +
      secondSegment.start[1] +
      secondSegment.end[1]) /
    4
  const lngScale =
    METERS_PER_DEGREE * Math.max(Math.cos((latitude * Math.PI) / 180), 0.1)
  const toLocal = ([lng, lat]) => [
    (lng - origin[0]) * lngScale,
    (lat - origin[1]) * METERS_PER_DEGREE,
  ]
  const firstStart = [0, 0]
  const firstEnd = toLocal(firstSegment.end)
  const secondStart = toLocal(secondSegment.start)
  const secondEnd = toLocal(secondSegment.end)
  const firstDirection = [
    firstEnd[0] - firstStart[0],
    firstEnd[1] - firstStart[1],
  ]
  const secondDirection = [
    secondEnd[0] - secondStart[0],
    secondEnd[1] - secondStart[1],
  ]

  const cross = (a, b) => a[0] * b[1] - a[1] * b[0]
  const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]]
  const pointOnSegment = (point, start, end) => {
    const direction = subtract(end, start)
    const lengthSquared =
      direction[0] * direction[0] + direction[1] * direction[1]
    const position = subtract(point, start)
    const ratio =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              (position[0] * direction[0] + position[1] * direction[1]) /
                lengthSquared,
            ),
          )
    return {
      ratio,
      point: [
        start[0] + direction[0] * ratio,
        start[1] + direction[1] * ratio,
      ],
    }
  }

  const candidates = []
  const addCandidate = (firstRatio, secondRatio) => {
    const firstPoint = [
      firstStart[0] + firstDirection[0] * firstRatio,
      firstStart[1] + firstDirection[1] * firstRatio,
    ]
    const secondPoint = [
      secondStart[0] + secondDirection[0] * secondRatio,
      secondStart[1] + secondDirection[1] * secondRatio,
    ]
    const difference = subtract(firstPoint, secondPoint)
    candidates.push({
      firstRatio,
      secondRatio,
      distance: Math.hypot(difference[0], difference[1]),
    })
  }

  const offset = subtract(secondStart, firstStart)
  const denominator = cross(firstDirection, secondDirection)
  if (Math.abs(denominator) > 1e-9) {
    const firstRatio = cross(offset, secondDirection) / denominator
    const secondRatio = cross(offset, firstDirection) / denominator
    if (
      firstRatio >= 0 &&
      firstRatio <= 1 &&
      secondRatio >= 0 &&
      secondRatio <= 1
    ) {
      addCandidate(firstRatio, secondRatio)
    }
  }

  addCandidate(
    pointOnSegment(secondStart, firstStart, firstEnd).ratio,
    0,
  )
  addCandidate(pointOnSegment(secondEnd, firstStart, firstEnd).ratio, 1)
  addCandidate(0, pointOnSegment(firstStart, secondStart, secondEnd).ratio)
  addCandidate(1, pointOnSegment(firstEnd, secondStart, secondEnd).ratio)

  const closest = candidates.reduce((best, candidate) =>
    candidate.distance < best.distance ? candidate : best,
  )
  const interpolate = (start, end, ratio) => [
    start[0] + (end[0] - start[0]) * ratio,
    start[1] + (end[1] - start[1]) * ratio,
  ]
  return {
    firstLocation:
      firstSegment.location + firstSegment.length * closest.firstRatio,
    secondLocation:
      secondSegment.location + secondSegment.length * closest.secondRatio,
    firstCoordinate: interpolate(
      firstSegment.start,
      firstSegment.end,
      closest.firstRatio,
    ),
    secondCoordinate: interpolate(
      secondSegment.start,
      secondSegment.end,
      closest.secondRatio,
    ),
    distance: closest.distance,
  }
}

function nearestRoutePoint(feature, coordinates) {
  const [queryLng, queryLat] = coordinates
  const lngScale =
    METERS_PER_DEGREE *
    Math.max(Math.cos((queryLat * Math.PI) / 180), 0.1)
  let bestDistanceSquared = Infinity
  let bestCoordinate = null
  let bestLocation = 0

  for (const segment of feature.segments) {
    const ax = (segment.start[0] - queryLng) * lngScale
    const ay = (segment.start[1] - queryLat) * METERS_PER_DEGREE
    const bx = (segment.end[0] - queryLng) * lngScale
    const by = (segment.end[1] - queryLat) * METERS_PER_DEGREE
    const dx = bx - ax
    const dy = by - ay
    const segmentLengthSquared = dx * dx + dy * dy
    const projection =
      segmentLengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / segmentLengthSquared))
    const closestX = ax + dx * projection
    const closestY = ay + dy * projection
    const distanceSquared = closestX * closestX + closestY * closestY

    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared
      bestCoordinate = [
        segment.start[0] +
          (segment.end[0] - segment.start[0]) * projection,
        segment.start[1] +
          (segment.end[1] - segment.start[1]) * projection,
      ]
      bestLocation = segment.location + segment.length * projection
    }
  }

  return {
    coordinate: bestCoordinate,
    distance: Math.sqrt(bestDistanceSquared),
    location: Math.min(bestLocation, feature.length),
  }
}

function coordinateAtRouteLocation(feature, location) {
  if (location <= 0) return feature.coordinates[0]
  if (location >= feature.length) {
    return feature.coordinates[feature.coordinates.length - 1]
  }

  for (const segment of feature.segments) {
    const segmentEnd = segment.location + segment.length
    if (location > segmentEnd) continue
    const portion =
      segment.length === 0
        ? 0
        : (location - segment.location) / segment.length
    return [
      segment.start[0] + (segment.end[0] - segment.start[0]) * portion,
      segment.start[1] + (segment.end[1] - segment.start[1]) * portion,
    ]
  }
  return feature.coordinates[feature.coordinates.length - 1]
}

function routeFeatureSlice(feature, startLocation, endLocation) {
  const forward = endLocation >= startLocation
  const low = Math.min(startLocation, endLocation)
  const high = Math.max(startLocation, endLocation)
  const coordinates = [coordinateAtRouteLocation(feature, low)]

  for (const segment of feature.segments) {
    const vertexLocation = segment.location + segment.length
    if (vertexLocation > low && vertexLocation < high) {
      coordinates.push(segment.end)
    }
  }
  coordinates.push(coordinateAtRouteLocation(feature, high))

  return forward ? coordinates : coordinates.reverse()
}

function routePathFeatures(edges, routeFeatures) {
  return edges
    .filter((edge) => edge.geometry?.length >= 2)
    .map((edge, index) => {
      const routeFeature = edge.featureUid
        ? routeFeatures.get(edge.featureUid)
        : null
      const label = routeFeature
        ? routeFeature.properties.name || routeFeature.properties.ref
        : null
      const properties = {
        kind:
          edge.kind === 'wyciąg'
            ? 'lift'
            : edge.kind === 'trasa'
              ? 'piste'
              : 'connection',
        index,
      }
      if (label) properties.label = label
      return {
        type: 'Feature',
        properties,
        geometry: { type: 'LineString', coordinates: edge.geometry },
      }
    })
}

function compareRouteCost(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function buildRouteGraph(features, map, extraPoints) {
  const featureByUid = new Map(features.map((feature) => [feature.uid, feature]))
  const pointsByFeature = new Map()
  const pointNodeIds = new Map()
  const extraRecords = new Map()
  const connectionSpecs = []

  const addPoint = (feature, data) => {
    const points = pointsByFeature.get(feature.uid)
    const existing = points.find(
      (candidate) => Math.abs(candidate.location - data.location) <= 1,
    )
    if (existing) return existing
    const pointRecord = { ...data, featureUid: feature.uid }
    points.push(pointRecord)
    return pointRecord
  }

  for (const feature of features) {
    const start = feature.coordinates[0]
    const end = feature.coordinates[feature.coordinates.length - 1]
    const startElevation = terrainElevation(map, start)
    const endElevation = terrainElevation(map, end)
    pointsByFeature.set(feature.uid, [
      {
        featureUid: feature.uid,
        coordinate: start,
        location: 0,
        elevation: startElevation,
        endpoint: true,
        endpointName: 'start',
      },
      {
        featureUid: feature.uid,
        coordinate: end,
        location: feature.length,
        elevation: endElevation,
        endpoint: true,
        endpointName: 'end',
      },
    ])
  }

  for (const extra of extraPoints) {
    const feature = featureByUid.get(extra.uid)
    if (!feature) continue
    const points = pointsByFeature.get(feature.uid)
    const startPoint = points.find((candidate) => candidate.location === 0)
    const endPoint = points.find(
      (candidate) => candidate.location === feature.length,
    )
    const startElevation = startPoint?.elevation
    const endElevation = endPoint?.elevation
    const interpolatedElevation =
      Number.isFinite(startElevation) && Number.isFinite(endElevation)
        ? startElevation +
          (endElevation - startElevation) * (extra.location / feature.length)
        : terrainElevation(map, extra.coordinate)
    const pointRecord = addPoint(feature, {
      coordinate: extra.coordinate,
      location: extra.location,
      elevation: interpolatedElevation,
    })
    extraRecords.set(extra.id, pointRecord)
  }

  const endpoints = []
  for (const feature of features) {
    const points = pointsByFeature.get(feature.uid)
    endpoints.push(...points.filter((pointRecord) => pointRecord.endpoint))
  }

  for (const sourcePoint of endpoints) {
    const sourceFeature = featureByUid.get(sourcePoint.featureUid)
    for (const targetFeature of features) {
      if (targetFeature.uid === sourceFeature.uid) continue
      if (
        sourceFeature.kind !== 'wyciąg' &&
        targetFeature.kind !== 'wyciąg'
      ) {
        continue
      }
      if (
        !isWithinRouteBounds(
          sourcePoint.coordinate,
          targetFeature,
          ROUTE_CONNECT_RADIUS_M,
        )
      ) {
        continue
      }

      let targetPoint
      let connectionDistance
      const targetPoints = pointsByFeature.get(targetFeature.uid)

      if (targetFeature.kind === 'wyciąg') {
        const nearestEndpoint = targetPoints
          .filter((candidate) => candidate.endpoint)
          .map((candidate) => ({
            candidate,
            distance: coordinateDistance(
              sourcePoint.coordinate,
              candidate.coordinate,
            ),
          }))
          .sort((a, b) => a.distance - b.distance)[0]
        if (!nearestEndpoint) continue
        targetPoint = nearestEndpoint.candidate
        connectionDistance = nearestEndpoint.distance
      } else {
        const nearest = nearestRoutePoint(
          targetFeature,
          sourcePoint.coordinate,
        )
        if (nearest.distance > ROUTE_CONNECT_RADIUS_M) continue
        targetPoint = addPoint(targetFeature, {
          coordinate: nearest.coordinate,
          location: nearest.location,
          elevation: terrainElevation(map, nearest.coordinate),
        })
        connectionDistance = nearest.distance
      }

      if (connectionDistance > ROUTE_CONNECT_RADIUS_M) continue
      connectionSpecs.push({
        sourcePoint,
        targetPoint,
        distance: connectionDistance,
      })
    }
  }

  const pisteFeatures = features.filter((feature) => feature.kind === 'trasa')
  for (let firstIndex = 0; firstIndex < pisteFeatures.length; firstIndex += 1) {
    const firstFeature = pisteFeatures[firstIndex]
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < pisteFeatures.length;
      secondIndex += 1
    ) {
      const secondFeature = pisteFeatures[secondIndex]
      if (
        !areBboxesWithinDistance(
          firstFeature.bbox,
          secondFeature.bbox,
          ROUTE_CONNECT_RADIUS_M,
        )
      ) {
        continue
      }

      let closest = null
      for (const firstSegment of firstFeature.segments) {
        for (const secondSegment of secondFeature.segments) {
          if (
            !areBboxesWithinDistance(
              firstSegment.bbox,
              secondSegment.bbox,
              ROUTE_CONNECT_RADIUS_M,
            )
          ) {
            continue
          }
          const candidate = closestSegmentPoints(
            firstSegment,
            secondSegment,
          )
          if (!closest || candidate.distance < closest.distance) {
            closest = candidate
          }
        }
      }

      if (!closest || closest.distance > ROUTE_CONNECT_RADIUS_M) continue
      const firstPoint = addPoint(firstFeature, {
        coordinate: closest.firstCoordinate,
        location: closest.firstLocation,
        elevation: terrainElevation(map, closest.firstCoordinate),
      })
      const secondPoint = addPoint(secondFeature, {
        coordinate: closest.secondCoordinate,
        location: closest.secondLocation,
        elevation: terrainElevation(map, closest.secondCoordinate),
      })
      connectionSpecs.push(
        {
          sourcePoint: firstPoint,
          targetPoint: secondPoint,
          distance: closest.distance,
        },
        {
          sourcePoint: secondPoint,
          targetPoint: firstPoint,
          distance: closest.distance,
        },
      )
    }
  }

  const nodes = new Map()
  const adjacency = new Map()
  const addEdge = (from, to, edge) => {
    if (!adjacency.has(from)) adjacency.set(from, [])
    adjacency.get(from).push(edge)
  }

  for (const feature of features) {
    const rawPoints = pointsByFeature.get(feature.uid)
    const sortedPoints = [...rawPoints].sort(
      (a, b) => a.location - b.location,
    )
    const mergedGroups = []
    for (const pointRecord of sortedPoints) {
      const lastGroup = mergedGroups[mergedGroups.length - 1]
      if (
        lastGroup &&
        Math.abs(lastGroup[0].location - pointRecord.location) <= 1
      ) {
        lastGroup.push(pointRecord)
      } else {
        mergedGroups.push([pointRecord])
      }
    }

    for (let i = 0; i < mergedGroups.length; i += 1) {
      const group = mergedGroups[i]
      const representative = group[0]
      const nodeId = `${feature.uid}:${i}`
      for (const pointRecord of group) pointNodeIds.set(pointRecord, nodeId)
      nodes.set(nodeId, {
        coordinate: representative.coordinate,
        elevation: representative.elevation,
      })
    }

    const startElevation = mergedGroups[0][0].elevation
    const endElevation = mergedGroups[mergedGroups.length - 1][0].elevation
    let forward = true
    if (Number.isFinite(startElevation) && Number.isFinite(endElevation)) {
      forward =
        feature.kind === 'wyciąg'
          ? startElevation <= endElevation
          : startElevation >= endElevation
    }

    const orderedGroups = forward ? mergedGroups : [...mergedGroups].reverse()
    for (let i = 1; i < orderedGroups.length; i += 1) {
      const fromPoint = orderedGroups[i - 1][0]
      const toPoint = orderedGroups[i][0]
      const from = pointNodeIds.get(fromPoint)
      const to = pointNodeIds.get(toPoint)
      const segmentDistance = Math.abs(
        toPoint.location - fromPoint.location,
      )
      if (!from || !to || segmentDistance <= 0) continue
      const liftEdge = {
        to,
        featureUid: feature.uid,
        geometry: routeFeatureSlice(
          feature,
          fromPoint.location,
          toPoint.location,
        ),
        kind: feature.kind,
        distance: segmentDistance,
        transferDistance: 0,
        liftCount: feature.kind === 'wyciąg' ? 1 : 0,
        downhillLiftCount: 0,
      }
      addEdge(from, to, liftEdge)
      if (feature.kind === 'wyciąg') {
        addEdge(to, from, {
          ...liftEdge,
          to: from,
          geometry: routeFeatureSlice(
            feature,
            toPoint.location,
            fromPoint.location,
          ),
          downhillLiftCount: 1,
        })
      }
    }
  }

  for (const connection of connectionSpecs) {
    const from = pointNodeIds.get(connection.sourcePoint)
    const to = pointNodeIds.get(connection.targetPoint)
    if (!from || !to || from === to) continue
    const sourceElevation = connection.sourcePoint.elevation
    const targetElevation = connection.targetPoint.elevation
    if (
      Number.isFinite(sourceElevation) &&
      Number.isFinite(targetElevation) &&
      targetElevation > sourceElevation + ROUTE_ELEVATION_TOLERANCE_M
    ) {
      continue
    }
    addEdge(from, to, {
      to,
      featureUid: null,
      kind: 'połączenie',
      geometry: [
        connection.sourcePoint.coordinate,
        connection.targetPoint.coordinate,
      ],
      distance: connection.distance,
      transferDistance: connection.distance,
      liftCount: 0,
      downhillLiftCount: 0,
    })
  }

  for (const [id, pointRecord] of extraRecords) {
    pointNodeIds.set(pointRecord, pointNodeIds.get(pointRecord))
    extraRecords.set(id, pointNodeIds.get(pointRecord))
  }

  return {
    nodes,
    adjacency,
    extraNodeIds: Object.fromEntries(extraRecords),
  }
}

function findRoute(graph) {
  const start = graph.extraNodeIds.start
  const end = graph.extraNodeIds.end
  if (!start || !end) return null

  const distances = new Map([[start, [0, 0, 0, 0]]])
  const previous = new Map()
  const queue = [{ node: start, cost: [0, 0, 0, 0] }]

  while (queue.length) {
    queue.sort((a, b) => compareRouteCost(a.cost, b.cost))
    const current = queue.shift()
    if (compareRouteCost(current.cost, distances.get(current.node)) !== 0) {
      continue
    }
    if (current.node === end) break

    for (const edge of graph.adjacency.get(current.node) ?? []) {
      const nextCost = [
        current.cost[0] + edge.downhillLiftCount,
        current.cost[1] + edge.liftCount,
        current.cost[2] + edge.transferDistance,
        current.cost[3] + edge.distance,
      ]
      const previousCost = distances.get(edge.to)
      if (!previousCost || compareRouteCost(nextCost, previousCost) < 0) {
        distances.set(edge.to, nextCost)
        previous.set(edge.to, { node: current.node, edge })
        queue.push({ node: edge.to, cost: nextCost })
      }
    }
  }

  if (!distances.has(end)) return null

  const edges = []
  let node = end
  while (node !== start) {
    const step = previous.get(node)
    if (!step) return null
    edges.push(step.edge)
    node = step.node
  }
  edges.reverse()

  const steps = []
  for (const edge of edges) {
    if (edge.featureUid && steps[steps.length - 1] !== edge.featureUid) {
      steps.push(edge.featureUid)
    }
  }
  if (!steps.length) return null

  return {
    featureUids: [...new Set(steps)],
    steps,
    edges,
    cost: distances.get(end),
  }
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
  const routeFeaturesRef = useRef(new Map())
  const routeModeRef = useRef(false)
  const routePointsRef = useRef({ start: null, end: null })
  const routeResultRef = useRef(null)
  const routeMarkersRef = useRef({ start: null, end: null })
  const blinkRef = useRef(0)

  const [selected, setSelected] = useState(null)
  const [items, setItems] = useState([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [routeMode, setRouteMode] = useState(false)
  const [routeResult, setRouteResult] = useState(null)
  const [routePanelOpen, setRoutePanelOpen] = useState(false)
  const [routeMessage, setRouteMessage] = useState('')

  function setRouteModeValue(value) {
    routeModeRef.current = value
    setRouteMode(value)
  }

  function removeRouteMarkers() {
    for (const marker of Object.values(routeMarkersRef.current)) {
      marker?.remove()
    }
    routeMarkersRef.current = { start: null, end: null }
  }

  function updateRouteMarkers(points) {
    removeRouteMarkers()
    const map = mapRef.current
    if (!map) return
    if (points.start) {
      routeMarkersRef.current.start = new Marker({ color: '#16a34a' })
        .setLngLat(points.start.coordinate)
        .addTo(map)
    }
    if (points.end) {
      routeMarkersRef.current.end = new Marker({ color: '#dc2626' })
        .setLngLat(points.end.coordinate)
        .addTo(map)
    }
  }

  function setRoutePath(features) {
    const source = mapRef.current?.getSource('route-path')
    if (!source) return
    source.setData({
      type: 'FeatureCollection',
      features,
    })
  }

  function clearRoute() {
    setRouteModeValue(false)
    routePointsRef.current = { start: null, end: null }
    routeResultRef.current = null
    setRouteResult(null)
    setRoutePanelOpen(false)
    setRouteMessage('')
    removeRouteMarkers()
    setRoutePath([])
  }

  function toggleRouteMode() {
    if (
      routeModeRef.current ||
      routeResultRef.current ||
      routePointsRef.current.start
    ) {
      clearRoute()
      return
    }
    setRouteModeValue(true)
    setRouteMessage('Wybierz punkt startowy na trasie')
  }

  function findNearestPiste(coordinates) {
    let nearest = null
    for (const feature of routeFeaturesRef.current.values()) {
      if (feature.kind !== 'trasa') continue
      if (!isWithinRouteBounds(coordinates, feature, ROUTE_SNAP_RADIUS_M)) {
        continue
      }
      const candidate = nearestRoutePoint(feature, coordinates)
      if (!nearest || candidate.distance < nearest.distance) {
        nearest = { ...candidate, uid: feature.uid }
      }
    }
    return nearest && nearest.distance <= ROUTE_SNAP_RADIUS_M ? nearest : null
  }

  function handleRouteMapClick(lngLat) {
    const map = mapRef.current
    if (!map || !routeModeRef.current) return

    const snap = findNearestPiste([lngLat.lng, lngLat.lat])
    if (!snap) {
      setRouteMessage('Kliknij w liniową trasę, maksymalnie 100 m od niej')
      return
    }

    const current = routePointsRef.current
    if (!current.start) {
      const next = { start: snap, end: null }
      routePointsRef.current = next
      updateRouteMarkers(next)
      setRouteMessage('Wybierz punkt docelowy na trasie')
      return
    }

    const next = { start: current.start, end: snap }
    const mapFeatures = [...routeFeaturesRef.current.values()]
    const graph = buildRouteGraph(mapFeatures, map, [
      { id: 'start', ...current.start },
      { id: 'end', ...snap },
    ])
    const result = findRoute(graph)

    if (!result) {
      routePointsRef.current = { start: current.start, end: null }
      updateRouteMarkers(routePointsRef.current)
      setRouteMessage('Nie znaleziono połączenia między tymi punktami')
      return
    }

    const seenStepNames = new Set()
    const stepItems = []
    for (const uid of result.steps) {
      const feature = routeFeaturesRef.current.get(uid)
      if (!feature) continue
      const label = routeFeatureLabel(feature)
      const key = `${feature.kind}:${label}`
      if (seenStepNames.has(key)) continue
      seenStepNames.add(key)
      stepItems.push({
        label,
        kind: feature.kind,
        color:
          feature.kind === 'trasa'
            ? DIFFICULTY_COLORS[feature.properties.difficulty] || '#888888'
            : '#7c3aed',
      })
    }
    const resultWithLabels = {
      ...result,
      stepItems,
      stepLabels: stepItems.map((item) => item.label),
    }
    routePointsRef.current = next
    routeResultRef.current = resultWithLabels
    setRouteResult(resultWithLabels)
    setRoutePanelOpen(false)
    updateRouteMarkers(next)
    setRoutePath(
      routePathFeatures(resultWithLabels.edges, routeFeaturesRef.current),
    )
    setRouteModeValue(false)
    setRouteMessage('')
  }

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
      center: [10.977123714520985, 46.95802633395613],
      zoom: 13,
      pitch: 40,
      bearing: -90,
      maxPitch: 85,
      maxZoom: 19,
      attributionControl: false,
    })

    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right')
    map.addControl(new FullscreenControl(), 'top-right')
    map.addControl(new ScaleControl(), 'bottom-left')
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right')

    const logMapMove = () => {
      const center = map.getCenter()
      console.log('[Mapa] centrum po przesunięciu:', {
        lng: center.lng,
        lat: center.lat,
      })
    }
    const logMapZoom = () => {
      console.log('[Mapa] zoom:', map.getZoom())
    }
    map.on('moveend', logMapMove)
    map.on('zoomend', logMapZoom)

    const homeMarkerElement = document.createElement('div')
    homeMarkerElement.className = 'home-marker'
    homeMarkerElement.setAttribute('role', 'img')
    homeMarkerElement.setAttribute('aria-label', 'Dom')
    homeMarkerElement.title = 'Dom'
    homeMarkerElement.innerHTML = `
      <svg viewBox="0 0 32 42" aria-hidden="true">
        <path class="home-marker-pin" d="M16 41S2 25.5 2 15C2 7.3 8.3 1 16 1s14 6.3 14 14c0 10.5-14 26-14 26Z" />
        <path class="home-marker-house" d="m8.5 19 7.5-6 7.5 6v8h-15v-8Zm4.5 8v-5h6v5" />
      </svg>`
    const homeMarker = new Marker({ element: homeMarkerElement, anchor: 'bottom' })
      .setLngLat(HOME_COORDINATES)
      .addTo(map)

    mapRef.current = map

    return () => {
      removeRouteMarkers()
      map.off('moveend', logMapMove)
      map.off('zoomend', logMapZoom)
      homeMarker.remove()
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
        map.addSource('route-path', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
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
        map.addLayer({
          id: 'route-path-casing',
          type: 'line',
          source: 'route-path',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#ffffff',
            'line-width': 9,
          },
        })
        map.addLayer({
          id: 'route-path',
          type: 'line',
          source: 'route-path',
          filter: ['!=', ['get', 'kind'], 'lift'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ROUTE_COLOR,
            'line-width': 6,
          },
        })
        map.addLayer({
          id: 'route-lifts',
          type: 'line',
          source: 'route-path',
          filter: ['==', ['get', 'kind'], 'lift'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#7c3aed',
            'line-width': 6,
            'line-dasharray': [2, 1.5],
          },
        })
        map.addLayer({
          id: 'route-piste-labels',
          type: 'symbol',
          source: 'route-path',
          filter: [
            'all',
            ['==', ['get', 'kind'], 'piste'],
            ['has', 'label'],
          ],
          layout: {
            'symbol-placement': 'line',
            'symbol-spacing': 260,
            'text-field': ['get', 'label'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 16,
            'text-letter-spacing': 0.05,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': ROUTE_COLOR,
            'text-halo-color': '#ffffff',
            'text-halo-width': 3,
            'text-halo-blur': 0.2,
          },
        })
        map.addLayer({
          id: 'route-lift-labels',
          type: 'symbol',
          source: 'route-path',
          filter: [
            'all',
            ['==', ['get', 'kind'], 'lift'],
            ['has', 'label'],
          ],
          layout: {
            'symbol-placement': 'line-center',
            'text-field': ['get', 'label'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 16,
            'text-letter-spacing': 0.05,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#5b21b6',
            'text-halo-color': '#ffffff',
            'text-halo-width': 3,
            'text-halo-blur': 0.2,
          },
        })

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
        routeFeaturesRef.current = new Map(
          [
            ...normalizeRouteFeatures(pistes.features, 'pistes', 'trasa'),
            ...normalizeRouteFeatures(lifts.features, 'lifts', 'wyciąg'),
          ].map((feature) => [feature.uid, feature]),
        )

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
          if (routeModeRef.current) return
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
          if (routeModeRef.current) return
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
          console.log('[Mapa] kliknięcie:', {
            lng: e.lngLat.lng,
            lat: e.lngLat.lat,
          })
          if (routeModeRef.current) {
            handleRouteMapClick(e.lngLat)
            return
          }
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
  const routeStepItems = routeResult?.stepItems ?? []
  const routeStepLabels = routeStepItems.map((item) => item.label)
  const routeSummary = routeStepLabels.join(' → ')
  const routeDownhillLiftCount = routeResult?.cost[0] ?? 0
  const routeLiftCount = routeResult?.cost[1] ?? 0
  const routeDistance = routeResult?.cost[3] ?? 0
  const routeButtonLabel = routeResult
    ? 'Wyczyść trasę'
    : routeMode
      ? 'Anuluj wybór punktów'
      : 'Wyznacz trasę'

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
      <button
        className={`route-toggle${menuOpen ? ' open' : ''}${
          routeMode ? ' active' : ''
        }${routeResult ? ' has-route' : ''}`}
        onClick={toggleRouteMode}
        aria-label={routeButtonLabel}
        title={routeButtonLabel}
      >
        {routeResult || routeMode ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="6" cy="18" r="2" />
            <circle cx="18" cy="6" r="2" />
            <path d="M8 17c3-1 3-7 6-8 1-.3 2-.3 4-1" />
          </svg>
        )}
      </button>
      {routeMessage && (
        <div className="route-message" role="status">
          {routeMessage}
        </div>
      )}
      {routeResult && (
        <section className={`route-panel${routePanelOpen ? ' expanded' : ''}`}>
          <button
            className="route-panel-toggle"
            onClick={() => setRoutePanelOpen((open) => !open)}
            aria-expanded={routePanelOpen}
            aria-label={routePanelOpen ? 'Zwiń trasę' : 'Rozwiń trasę'}
          >
            <span className="route-panel-title">Trasa</span>
            <span className="route-panel-summary" title={routeSummary}>
              {routeStepItems.map((item, index) => (
                <Fragment key={`${item.kind}/${item.label}/${index}`}>
                  {index > 0 && (
                    <svg
                      className="route-summary-arrow"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M4 12h16m-6-6 6 6-6 6" />
                    </svg>
                  )}
                  <span
                    className="route-step-badge"
                    style={{ background: item.color }}
                  >
                    {item.label}
                  </span>
                </Fragment>
              ))}
            </span>
            <span className="route-panel-chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path
                  d={routePanelOpen ? 'M6 9l6 6 6-6' : 'M6 15l6-6 6 6'}
                />
              </svg>
            </span>
          </button>
          {routePanelOpen && (
            <div className="route-panel-details">
              <div className="route-panel-meta">
                {routeLiftCount}{' '}
                {routeLiftCount === 1 ? 'wyciąg' : 'wyciągów'} ·{' '}
                {routeDownhillLiftCount > 0 &&
                  `${routeDownhillLiftCount} w dół wyciągiem · `}
                {routeDistance >= 1000
                  ? `${(routeDistance / 1000).toFixed(1)} km`
                  : `${Math.round(routeDistance)} m`}
              </div>
              <ol className="route-panel-list">
                {routeStepItems.map((item, index) => (
                  <li key={`${item.kind}/${item.label}/${index}`}>
                    <span
                      className="route-step-badge"
                      style={{ background: item.color }}
                    >
                      {item.label}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
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
