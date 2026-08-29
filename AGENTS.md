# MapyTest — dokumentacja projektu

PWA do przeglądania map zimowych (OpenStreetMap/OpenSnowMap) na smartfonie i komputerze.
Silnik: **MapLibre GL** + **React 19** + **Vite**. Cała logika mapy jest w jednym pliku `src/App.jsx`.

---

## 1. Cel projektu

- Wyświetlać mapy zimowe: trasy narciarskie (nartostrady), wyciągi, teren w 3D.
- Docelowo: wyciągać informacje o nartostradach (nazwa, trudność, długość, nachylenie),
  nagrywać pozycję GPS i ustalać, które trasy zostały „zaliczone".

**Stan dzisiejszy:** zrealizowana jest wizualizacja + interakcja z trasami (klik, etykiety,
zaznaczanie, kolorowanie wg trudności i ratrakowania). GPS/długości/nachylenia to **następne kroki**
(nie zaimplementowane — patrz sekcja 15).

---

## 2. Stack technologiczny

- `react` / `react-dom` `^19.2.8`
- `maplibre-gl` `^6.5.0` (WebGL, teren 3D, style spec v8)
- `vite` `^8.2.2` + `@vitejs/plugin-react` `^6.1.0`
- Lint: `oxlint` `^1.79.0` (konfiguracja `.oxlintrc.json`)

### Komendy

```bash
npm run dev       # serwer dev (Vite)
npm run build     # build produkcyjny do dist/
npm run lint      # oxlint
npm run preview   # podgląd buildu
```

---

## 3. Struktura plików

| Plik | Rola |
| --- | --- |
| `src/App.jsx` | Cała aplikacja: mapa, źródła, warstwy, interakcje, cache |
| `src/main.jsx` | Punkt wejścia React (StrictMode) |
| `src/App.css` | Style mapy + popupów |
| `src/index.css` | Style globalne (reset wysokości, font) |
| `index.html` | HTML + meta PWA (manifest, theme-color, apple-touch-icon) |
| `vite.config.js` | `base: '/MapyTest/'`, `build.outDir: 'docs'`, **`server.hmr: false`** (hot-reload wyłączony — świadoma decyzja) |
| `public/manifest.webmanifest` | Manifest PWA |
| `public/icons/icon-192.png`, `icon-512.png` | Ikony PWA |
| `docs/` | Zbudowana wersja (deploy na GitHub Pages) |

---

## 4. Źródła danych

| Nazwa | URL | Typ | Użycie |
| --- | --- | --- | --- |
| OpenTopoMap | `https://a.tile.opentopomap.org/{z}/{x}/{y}.png` | raster | Podkład (`source: topo`) |
| AWS Terrain Tiles | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | raster-dem (terrarium) | Teren 3D (`source: terrain`) |
| Overpass API | `https://overpass-api.de/api/interpreter` | JSON | Trasy + wyciągi (wektorowo) |
| MapLibre demo fonts | `https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf` | glyphs | Etykiety tras (`glyphs`) |

> **Ważne:** warstwa `pistes` była kiedyś rastrowymi kafelkami PNG OpenSnowMap
> (`https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png`). Została **usunięta** i zastąpiona
> danymi wektorowymi z Overpass, bo z PNG nie da się wyciągnąć nazw/trudności/geometrii.

---

## 5. Konfiguracja mapy (ustawienia początkowe, niezmienione)

Definiowana w `new Map({...})` w `src/App.jsx`:

- `center: [10.887, 46.97]` — Sölden (Austria)
- `zoom: 12.5`, `pitch: 60`, `bearing: -20`
- `maxPitch: 85`, `maxZoom: 19`
- `terrain: { source: 'terrain', exaggeration: 0.6 }` — wyolbrzymienie terenu 0.6
- `sky` — niebo/fog (kolory `#a5d6f5`, `#f0f6fa`, `#e8eef2`), `horizon-fog-blend`/`fog-ground-blend` 0.4
- `attributionControl: false` — atrybucje dodawane osobno (patrz niżej)

### Kontrolki (dodawane po utworzeniu mapy)

- `NavigationControl({ visualizePitch: true })` — `top-right`
- `FullscreenControl()` — `top-right`
- `ScaleControl()` — `bottom-left`
- `AttributionControl({ compact: true })` — `bottom-right`

### Worker

`setWorkerUrl(maplibreWorkerUrl)` — worker MapLibre ładowany z bundla Vite
(`maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url`).

---

## 6. Potok danych (Overpass → warstwy)

1. `OVERPASS_QUERY` — jedno zapytanie pobiera trasy **i** wyciągi w bounding boxie Sölden:

```text
[out:json][timeout:30];
(
  way["piste:type"](46.85,10.75,47.10,11.05);
  relation["piste:type"](46.85,10.75,47.10,11.05);
  way["aerialway"](46.85,10.75,47.10,11.05);
);
out body geom;
```

2. `overpassToLayers(data)` przekształca odpowiedź na dwa FeatureCollection: `pistes` i `lifts`.

3. `pistes` trafia do źródła `pistes` (`promoteId: 'uid'` — do feature-state),
   `lifts` do źródła `lifts`.

4. Warstwy są dodawane **dynamicznie** (po pobraniu), wszystkie wstawiane przed `track-casing`.

### Geometria

- `toLineString(el)` — dla wyciągów (zawsze linia).
- `toPisteGeometry(el)` — dla tras: jeżeli geometria jest **zamknięta** (pierwszy punkt == ostatni,
  min. 4 punkty) → `Polygon` (obszar/wielokąt), w przeciwnym razie → `LineString` (linia).
  - W OSM trasy zjazdowe bywają mapowane jako **linia** (środkiem trasy), **obszar** (zamknięty obrys)
    lub **relacja** (`route=piste`/`site=piste`). Stąd podział na linie i wielokąty.

---

## 7. Filtrowanie tras (ustalenia)

W `overpassToLayers` odrzucane są:

- elementy bez geometrii (lub z < 2 punktów),
- wszystko co **nie** ma `piste:type` zawierającego `downhill` (czyli: biegowe `nordic`,
  `skitour`, `sled`, itd. — usunięte),
- `grooming === 'no'` (nieprzygotowana — usunięta całkowicie),
- `difficulty === 'freeride'` (freeride — usunięty).

**Zostają tylko trasy zjazdowe (downhill).**

### Właściwości trasy (properties)

| Klucz | Wartość |
| --- | --- |
| `uid` | `` `${el.type}/${el.id}` `` — unikalny id (feature-state) |
| `osmId`, `osmType` | id/typ elementu OSM |
| `name` | `name \|\| piste:name \|\| ref \|\| null` |
| `ref` | `tags.ref` (numer trasy, np. „46") |
| `label` | `ref \|\| name \|\| piste:name \|\| null` — do etykiet |
| `difficulty` | `piste:difficulty` |
| `pisteType` | `piste:type` (surowy) |
| `grooming` | `piste:grooming` |
| `warning` | `grooming === 'backcountry' \|\| grooming === 'mogul'` |

---

## 8. Trudność i grooming (tagi OSM)

### `piste:difficulty` — kolory

| Wartość | Kolor | Etykieta PL |
| --- | --- | --- |
| `novice` | `#22c55e` (zielony) | „zielona (bardzo łatwa)" |
| `easy` | `#3b82f6` (niebieski) | „niebieska (łatwa)" |
| `intermediate` | `#ef4444` (czerwony) | „czerwona (średnia)" |
| `advanced` | `#111827` (prawie czarny) | „czarna (trudna)" |
| `expert` | `#f97316` (pomarańczowy) | „czarna (ekspert)" |
| `freeride` | `#eab308` (żółty) | „freeride (nieoznaczona)" — **usuwana z mapy** |
| brak/nieznane | `#888888` (szary) | surowa wartość |

> Kolory mapują się w wyrażeniu `DIFFICULTY_MATCH` (używane dla `line-color`, `fill-color`, obrysów).

### `piste:grooming` — ratrakowanie (NIE jest skalą, to kategorie)

- brak tagu (dla downhill) → **ratrakowana** (rysowana normalnie)
- `backcountry` → **nieratrakowana** (ostrzeżenie — paski)
- `mogul` → **muldy** (ostrzeżenie — paski)
- `no` → nieprzygotowana — **usuwana z mapy**
- `classic` / `skating` / `classic+skating` → dotyczy biegówek (nie występują po filtrowaniu)

---

## 9. Stylizacja warstw

Kolejność dodawania = kolejność rysowania (pierwsza na spodzie, ostatnia na wierzchu),
wszystkie przed `track-casing` (czyli pod śladem testowym).

| id warstwy | typ | Źródło | Opis |
| --- | --- | --- | --- |
| `topo` | raster | `topo` | podkład (statyczna, w stylu) |
| `track-casing` / `track-line` / `track-start` / `track-end` | line/circle | `track` | ślad testowy (statyczne, w stylu) |
| `pistes-area-fill` | fill | `pistes` | wielokąty tras — kolor trudności, `fill-opacity` 0.26 (0.5 przy zaznaczeniu) |
| `pistes-area-outline` | line | `pistes` | obrys wielokątów — kolor trudności, szer. 1.5 (3 + żółty przy zaznaczeniu) |
| `pistes-area-warning` | line | `pistes` | paski ostrzegawcze na obrysie wielokąta |
| `pistes-casing` | line | `pistes` | biała obwódka linii, szer. 6 (10 + żółta przy zaznaczeniu) |
| `pistes-line` | line | `pistes` | kolor trudności, szer. 3, opacity 0.95 |
| `pistes-warning-stripe` | line | `pistes` | paski ostrzegawcze na linii |
| `pistes-labels` | symbol | `pistes` | numery/nazwy wzdłuż linii |
| `pistes-hit-line` | line | `pistes` | niewidoczny cel kliknięcia (szer. 18) |
| `pistes-hit-area` | fill | `pistes` | niewidoczny cel kliknięcia (cały wielokąt) |
| `lifts-line` | line | `lifts` | wyciągi — czerwona przerywana linia `#dc2626`, szer. 2.5, dash `[2, 1.5]` |
| `lifts-hit` | line | `lifts` | niewidoczny cel kliknięcia (szer. 18) |

### Paski ostrzegawcze (`warning` = backcountry/mogul)

- Kolor dobierany wg trudności (`WARNING_COLOR_MATCH`):
  - `advanced` (czarna trasa) → **jasnoszary** `#e5e7eb`
  - pozostałe → **ciemnoszary** `#374151`
- `WARNING_DASH = [2, 10]` — kreska 2 px, przerwa 10 px.
  - Historia: czarny `[3,3]` → fiolet `[1,3]` → `[2,6]` → `[2,10]`. Fiolet odrzucony (brzydki),
    czarny niewidoczny na czarnych trasach. Finalnie szary, kreski krótkie, przerwy długie.
  - **Uwaga:** użytkownik zgłaszał, że wydłużanie przerw w `line-dasharray` słabo się uwidacznia —
    możliwe zaokrąglanie renderera przy tej grubości linii.

### Etykiety tras (`pistes-labels`)

- `symbol-placement: line` (tekst wzdłuż linii)
- `text-field: ['get', 'label']` (preferuje numer `ref`)
- `symbol-spacing: 150` (zagęszczone 2× z 300)
- `text-font: ['Noto Sans Bold']`, `text-size: 11`, `text-letter-spacing: 0.08`
- `text-allow-overlap: true`, `text-optional: true` (żeby szukać numeru wzrokiem)
- biała obwódka (`text-halo-*`), kolor tekstu `#0f172a`

---

## 10. Interakcje

### Zaznaczenie (feature-state)

- Zaznaczenie realizowane przez `feature-state` (nie osobne źródło).
- `pistes` ma `promoteId: 'uid'`, więc `feature.id` = `uid`.
- Kliknięcie ustawia `{ selected: true }` na poprzednim (wygasza) i nowym feature.
- Warstwy reagują na `['feature-state', 'selected']` (case): obwódka żółta `#facc15`, grubsza,
  a dla wielokątów mocniejszy `fill-opacity`.
- Klik w puste miejsce czyści zaznaczenie (query po warstwach hit).

### Klik / popup

- Trasa (`pistes-hit-line` / `pistes-hit-area`): popup z **Nazwa**, **Trudność**, **Grooming**.
  - Grooming wyświetlany jako: `backcountry` → „nieratrakowana (backcountry)", `mogul` → „muldy",
    pozostałe → „ratrakowana".
- Wyciąg (`lifts-hit`): popup z **Nazwa**, **Rodzaj** (polskie nazwy z `AERIALWAY_LABELS`).
- HTML popupu budowany przez `buildPopupHTML` (klucz/wartość), wartości escapowane (`escapeHtml`).
- Kursor `pointer` na warstwach hit.

### Hit-area (łatwe klikanie)

- Niewidoczne warstwy (`rgba(0,0,0,0)`) o dużej powierzchni klikania:
  linie szer. 18 px, wielokąty całe wnętrze — bo trafienie w cienką linię było trudne.

---

## 11. Cache (Overpass)

- Dane cache'owane w **`localStorage`** pod kluczem `maptest:ski-data:v1`.
- TTL: **24 h** (`SKI_CACHE_TTL_MS`).
- Logika w `loadSkiData()`:
  - cache świeży → użyj cache (bez fetch),
  - przeterminowany → fetch i zapisz,
  - fetch nieudany + cache istnieje (nawet stary) → użyj cache jako fallback.
- Żeby wymusić ponowne pobranie: wyczyść klucz w localStorage albo podbij `v1` w `SKI_CACHE_KEY`.
- Działa identycznie na desktopie i w PWA (to zwykłe localStorage).

---

## 12. Ślad testowy (hardcoded)

- `RUN_WAYPOINTS` — lista punktów trasy „Gaislachkogl → Sölden".
- `RUN_SAMPLES = 4` — interpolacja odcinków (wygładzenie).
- `TRACK_GEOJSON` — LineString + punkty start/end.
- Warstwy `track-*` rysują ślad z gradientem kolorów (`line-gradient` wg `line-progress`),
  zielony punkt startu, czerwony punkt końca.
- **To tylko placeholder** — docelowo ma być zastąpione nagraniem GPS.

---

## 13. PWA

- `public/manifest.webmanifest`: `display: standalone`, `theme_color: #0b3d66`,
  ikony 192/512, `lang: pl`.
- `index.html`: meta theme-color, viewport-fit=cover, apple-touch-icon, link manifest.

---

## 14. Deploy na GitHub Pages (folder `docs/`)

- Repozytorium: `https://github.com/Dasiuss/MapyTest.git`.
- Strona jest hostowana z gałęzi `main`, z folderu **`docs/`** (ustawienie GitHub Pages → Source → `Deploy from a branch` → folder `/docs`).
- `vite.config.js` ma `build.outDir: 'docs'`, więc `npm run build` buduje **prosto do `docs/`**.
- `public/.nojekyll` (pusty plik) jest kopiowany do `docs/` przy buildzie — wyłącza Jekyll na GitHub Pages.
- `base: '/MapyTest/'` — bo strona żyje pod ścieżką `https://<user>.github.io/MapyTest/`.

### Procedura wypuszczenia nowej wersji

```bash
npm run build   # buduje do docs/
git add src public vite.config.js AGENTS.md docs
git commit -m "..."
git push
```

Po pushu GitHub Pages automatycznie serwuje zawartość `docs/`.

---

## 15. Ustalenia i decyzje z sesji (historia)

1. **Raster → wektor.** PNG OpenSnowMap usunięte; trasy i wyciągi pobierane z Overpass jako GeoJSON.
2. **Filtrowanie:** tylko `downhill`; wyrzucone biegowe, freeride, `grooming=no`.
3. **Ratrakowanie oznaczone paskami:** `backcountry` i `mogul` = ostrzeżenie (paski).
4. **Kolor pasków:** czarny → fiolet (odrzucony) → **szary** (jasny na czarnych trasach,
   ciemny na pozostałych).
5. **Paski na oryginalnym kolorze** (nie na bieli).
6. **Obszary vs linie:** zamknięte geometrie rysowane jako półprzezroczyste wypełnienia
   (`fill-opacity` 0.26), otwarte jako linie.
7. **Etykiety:** numery (`ref`) preferowane nad nazwami; drukowane wzdłuż linii; zagęszczone 2×.
8. **Łatwiejsze klikanie:** niewidoczne hit-area (linia 18 px + wnętrza wielokątów).
9. **Zaznaczenie:** przez `feature-state`, podświetla obwódkę na żółto (bez przykrywania koloru).
10. **Obrót mapy:** próbowaliśmy uspokoić obrót (custom handler, wolniejszy, bez przechyłu) —
    **cofnięte**; wróciliśmy do domyślnego `dragRotate` (obrót+przechylanie prawym przyciskiem).
    Użytkownik woli nauczyć się domyślnego zachowania.
11. **Hot-reload wyłączony** (`server.hmr: false`) — użytkownik woli ręczne F5.
12. **Cache 24 h** w localStorage dla danych Overpass.

---

## 16. Ograniczenia i planowane kroki (NIE zaimplementowane)

- **Długość trasy** — do policzenia z geometrii (Haversine lub `@turf/length`).
- **Nachylenie/spadek** — do policzenia z DEM (terrarium, już dostępne) przez próbkowanie wysokości
  wzdłuż geometrii; tag `incline=*` w OSM jest rzadki/niekompletny.
- **Nagrywanie GPS** — `navigator.geolocation.watchPosition` (wymaga HTTPS; GitHub Pages je zapewnia);
  zapis śladu lokalnie (IndexedDB/localStorage).
- **„Zaliczenie" tras** — dopasowanie śladu GPS do geometrii tras (bufor ~20–30 m, próg pokrycia,
  ewentualnie map-matching/snapping). Pomocne: `nearestPointOnLine`, `lineChunk`, `buffer`,
  `booleanPointInPolygon` z turf.
- **Relacje multipolygon** i obszary `site=piste` — uproszczone (obszary wykrywane tylko po
  zamkniętej geometrii pojedynczego elementu).
- Brak backendu — wszystko po stronie klienta (Overpass + localStorage).
