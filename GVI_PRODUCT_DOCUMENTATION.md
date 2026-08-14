# GVI — Green View Index
### A 3D Green-Exposure & Liveability Platform for Real Estate

![figure:01-logo.png]()

---

## 1. Project Overview and Concept

**GVI (Green View Index)** is an interactive 3D web application that answers a question
the property industry has never been able to answer with evidence:

> **"How much greenery will I actually see out of *this* window, on *this* floor,
> facing *this* direction?"**

Traditional listings say "park nearby" or "leafy neighbourhood." GVI replaces that
marketing language with a **measured, per-window, per-floor number** — computed from a
photo-realistic 3D reconstruction of the building and its real surrounding city.

The user flies to a real building rendered in 3D on a real map of the city, steps
*inside* it, walks to a window or balcony, and the platform captures what the eye
actually sees from that exact point. It then measures the percentage of that view that
is living vegetation, and rolls those measurements up into a scorecard for the whole
building.

Around that core measurement, GVI adds the wider **liveability picture** — live air
quality, heat comfort, traffic noise, tree health, and real sun/shadow simulation — so
a single address can be assessed on green exposure *and* environmental wellbeing in one
session.

### Key Features

- **Real 3D City, Real Building.** The building sits inside an accurate 3D globe with
  real terrain, real surrounding buildings, and real street trees — not an illustration
  or an artist's render.

- **Window-Level Green View Index.** Every window on every floor gets its own score.
  A 3rd-floor north window and a 9th-floor south window are measured separately,
  because they genuinely see different things.

- **Walk Inside the Building.** An indoor navigation mode lets the user move through
  the flat, turn, and look out of any window with on-screen movement controls — exactly
  as a prospective buyer would during a viewing.

- **Real Trees, Not Decoration.** Trees come from official city inventories and
  LiDAR-scanned canopy data, each placed at its true location, with its true height
  and true crown spread. A 25-metre plane tree blocks and provides more view than a
  5-metre redbud, and the model reflects that.

- **Automated Building Sweep.** One click captures and scores every floor × every
  facade in the building unattended, then ranks the floors best-to-worst.

- **Live Environmental Wellness.** Air quality (from EPA monitoring stations), current
  temperature and "feels-like" heat comparison, traffic-noise estimation, and tree
  canopy coverage — refreshed live, not stored marketing figures.

- **Real Sun & Shadow.** Uses genuine astronomical solar position for the building's
  location, date and time — so "does this flat get afternoon light in December?"
  becomes a demonstrable, on-screen answer.

- **Auditable, Not a Black Box.** Every score comes with the actual captured view and
  a colour-coded overlay showing precisely which pixels were counted as greenery. The
  client can see the working, not just the number.

---

## 2. The Making of GVI: How the Platform Was Built

GVI was built iteratively — starting with a 3D globe and a single building, then
layering measurement, data, and analysis on top, testing each stage against real
scenes before moving on.

### A. Step 1: The 3D Foundation

1. **The Globe and the Building.** The platform is built on **CesiumJS**, the same
   3D-geospatial engine used in aviation and defence visualisation. It gives us a real
   Earth: accurate terrain elevation, correct geographic coordinates, and a real-world
   sun.

2. **Placing the Building Correctly.** A detailed 3D building model is anchored to a
   real address in West Midtown Manhattan. Getting this *exactly* right mattered more
   than expected — the model's own geometry sits offset from its anchor point, so its
   true footprint and base offset were measured from the model file itself, and later
   re-verified empirically against captured viewpoints on all four facades. Without
   this, virtual cameras end up *inside walls* and floor heights are measured from the
   wrong ground plane.

3. **Surrounding City Context.** The neighbouring city blocks are rendered from
   OpenStreetMap 3D building data. This is essential, not cosmetic: a neighbouring
   tower is what *blocks* a green view, and any honest measurement has to include it.

![figure:02-aerial-photoreal.png](Figure 1 — The subject building (dark) anchored to its real address in West Midtown Manhattan, shown against photo-realistic 3D city context, real terrain and the Hudson River.)


4. **Performance Engineering.** A full 3D city with thousands of individual trees is
   heavy. The application was tuned with model compression, repeated-geometry
   instancing, level-of-detail tuning, and chunked far-to-near loading so it runs
   smoothly in an ordinary browser rather than requiring specialist hardware.

![figure:03-massing-occlusion.png](Figure 2 — The same location in analysis mode. Neighbouring blocks become simplified white massing: these are the structures that physically block a green view, and every measurement accounts for them.)


### B. Step 2: Making Vegetation Real

The single biggest determinant of accuracy is whether the trees in the scene match the
trees on the street.

1. **Three Independent Data Sources, Merged.** The platform pulls from:
   - **LiDAR canopy data** (aerial laser scanning — the most accurate source, giving
     real measured crown shapes and heights),
   - **NYC Parks' official Forestry Tree Points inventory** (real trees, surveyed by
     city staff, with species, trunk diameter and an arborist-assessed condition
     rating),
   - **OpenStreetMap** (parks, woods, scrub, and grassland areas).

2. **Intelligent De-duplication.** The same physical tree often appears in more than
   one dataset. Rather than double-counting or discarding data, GVI merges them: it
   keeps the highest-quality record and *backfills its gaps* from the others. A LiDAR
   tree with real crown geometry but no species is combined with the city record for
   the same tree that has species and trunk diameter — producing one complete record
   instead of two partial ones.

3. **Honest Height Estimation.** A tree with no measured height is not simply assumed.
   It goes through a species-and-trunk-diameter growth model (a London plane and a
   crab apple mature to very different sizes). Every tree is then tagged with how its
   height was determined — **measured by LiDAR**, **estimated**, or **default** — and
   those counts are reported to the user. During testing we also found LiDAR heights
   being contaminated by adjacent building rooftops, producing "trees" at building
   height; a realistic ceiling now rejects those readings so they fall back to the
   estimate instead.

4. **Manual Vegetation Override.** For greenery no dataset captures — a private
   courtyard, a green roof, a new planting scheme — the user can draw the vegetation
   directly onto the map. These hand-drawn areas are treated as **verified ground
   truth** and merged into the measurement.

### C. Step 3: Measuring the View

This is the core of the product.

1. **Placing the Eye.** For a chosen floor, facade and flat, the system computes the
   exact position and orientation a person's eye would occupy at that window —
   accounting for floor height, eye height, the building's rotation on the ground, and
   an offset that puts the camera just *outside* the glass rather than inside the wall.

2. **Capturing What the Eye Sees.** The 3D view from that eye position is captured as
   an image — a genuine rendering of the real scene, including trees, terrain,
   neighbouring buildings, sky and roads.

3. **Classifying the Greenery.** The captured image is analysed pixel by pixel. Our
   first attempt used a simple "is this pixel green?" test — and it failed badly, as
   naive approaches always do: it classified grey roofs, shadowed concrete, glass and
   khaki rooftops as vegetation. The current classifier requires **multiple independent
   colour criteria to agree simultaneously**, followed by a noise-cleanup pass. This
   was tuned against real captured scenes until rooftop speckle disappeared while dry
   and autumn foliage was still correctly counted.

4. **Excluding What Isn't Being Assessed.** Sky and anything beyond the analysis range
   is excluded from both the numerator *and* the denominator, so the score reflects the
   area actually being assessed rather than the shape of the photo.

5. **Rolling It Up.** Window scores average into rooms, rooms into flats, flats into
   floors, and floors into a single building score — giving both a granular and an
   executive-level view of the same data.

![figure:04-balcony-gvi-analysis.png](Figure 3 — Measuring a single window. Left: every saved viewpoint on Floor 7 with its own score. Right: the captured view and the vegetation mask beneath it, showing exactly which pixels were counted — this window scores 3.3% green.)


### D. Step 4: Automation and Scale

Manually capturing hundreds of viewpoints is not a product. A **backend automation
service** was built that drives a headless browser through every floor × facade ×
flat combination in the building, captures each view, computes its score, and stores
the result with its preview image in a PostgreSQL database.

The job queue can be **started, paused, resumed, cancelled, retried, and regenerated**
per-viewpoint or per-floor — and if the server restarts mid-run, it automatically
resumes from the last completed job rather than starting over.

![figure:05-automated-tour.png](Figure 4 — The automated sweep in progress, paused mid-run. Each window is captured from inside the flat and scored in sequence, with its floor, facade and window identity recorded alongside the result.)


### E. Step 5: The Wider Liveability Picture

Green view alone doesn't describe a place to live. Four further metrics were added,
each from a real source with its method openly stated:

- **Air Quality** — live readings from **EPA AirNow** monitoring stations, with a
  model-based fallback for gaps between stations.
- **Heat Comfort** — live temperature and "feels like" for the address, compared
  against a stable city reference point, plus an estimate of the cooling effect of
  nearby canopy.
- **Traffic Noise** — estimated from proximity to major roads. **Explicitly labelled
  an estimate, not a measurement**, because no acoustic sensor feed is involved.
- **Tree Canopy & Vegetation Health** — coverage percentage, plus real
  arborist-assessed tree condition ratings and species-diversity analysis (a
  single-species block is far more vulnerable to one pest event than a mixed one).

These are cached on **two different clocks**, matched to how fast each actually
changes: trees and roads are cached for a day; air quality and temperature are
recomputed on every request, because a day-old AQI reading is simply wrong.

### F. Step 6: Sun, Shadow and Light Quality

Finally, real solar simulation was added — using genuine planetary-position
astronomy for the building's exact coordinates, date and time. It answers whether a
given window receives direct sunlight at a given moment, at what intensity, and
classifies the scene into **shadow**, **sunlight filtered through tree canopy**, and
**harsh sunlight on bare hardscape** — the difference between a pleasant and an
uncomfortable outlook.

![figure:06-sunlight-night.png](Figure 5 — The same window at 03:21. The sun sits 25.1 degrees below the horizon, so all four facades correctly report 0% sunlight — the simulation is driven by real astronomy, not a decorative day/night effect.)

![figure:07-sunlight-day.png](Figure 6 — The identical viewpoint at 15:30. The East facade is brightest at 43% intensity, the sun is 49 degrees up, solar irradiance reads 675 W/m2 — and real building shadows are now cast across the scene, with live weather and air quality shown alongside.)



---

## 3. Interface Controls: What Everything Does

### The 3D View

The main screen is the live 3D city. The application opens on an oblique aerial view
of the building and its street-level surroundings. Standard mouse controls orbit, pan
and zoom.

### Indoor Navigation

- **Enter / Exit the Building** — switches between the outside aerial view and
  first-person indoor mode.
- **Movement Controls** — on-screen forward/back, strafe, and rotate controls for
  walking through the flat to a window. Camera height and pitch are constrained to
  realistic human values, so the view is always what a standing person would see.

### Balcony & Viewpoint Navigator

- **Floor / Side / Flat selectors** — choose exactly which viewpoint to inspect
  (e.g. Floor 7, North facade, Flat 2).
- **Go To View** — flies the camera to that exact window position.
- **Save Point** — stores the current camera position as a named viewpoint for reuse.
- **Analyse GVI** — loads the surrounding vegetation, waits for it to fully render,
  captures the view, and computes the score. *(The waiting matters: capturing
  mid-render was producing falsely low scores, so the sequence is now explicitly
  ordered.)*
- **Leaderboard** — ranks all analysed viewpoints by score, best to worst.

### Vegetation Controls

- **Analyse Nearby Vegetation** — fetches and renders every tree and green area around
  the building from all data sources.
- **Layer toggles** — independently show or hide 3D trees, canopy polygons, tree
  centre points, and visible-vs-occluded canopy.
- **Tree Hover Popup** — hover any tree to see its species, height, crown size, and
  **where that height came from** (LiDAR / Estimated / Default).

### Manual Vegetation Editor

- **Draw Polygon** — trace greenery the datasets missed directly onto the map.
- **Edit / Import / Export** — adjust existing shapes, or move them between projects as
  standard **GeoJSON** files.

### Analysis Panels

- **Green Wellness Panel** — the combined liveability score with its four weighted
  components, plus plain-English insights and recommendations.
- **Air Quality Panel** — current AQI, PM2.5, status band, and the source used.
- **Heat Comfort Panel** — current temperature, feels-like, difference from the city
  average, and estimated canopy cooling.
- **Vegetation Health Panel** — tree condition breakdown (Good / Fair / Poor) and
  species diversity.
- **Sunlight Analysis Panel** — date/time control, sun elevation and bearing, direct
  sunlight status per window, and the shadow / filtered-light / harsh-light breakdown.
- **Window GVI Panel** — per-window results with the captured image, the colour-coded
  vegetation overlay, and a **ray-count dial** trading analysis time for precision.

### Generation Control Panel *(operator tool)*

**Generate**, **Pause**, **Resume**, **Cancel**, **Retry Failed**, and **Regenerate**
for the automated building-wide sweep, with live progress. Protected by an admin
token — read-only for everyone else.

---

## 4. Algorithms and Methods Used in GVI

### 1. Vegetation Data Fusion

**Multi-source merge with proximity de-duplication.**
Two records within a short distance of each other are treated as the same physical
tree. The higher-quality source wins, and its missing fields are filled from the
lower-priority match.
**Result:** the most complete possible record for each real tree, with nothing
double-counted and nothing thrown away.

**Species-and-diameter growth models (allometry).**
Trunk diameter and species are mapped to expected mature height and crown spread via
saturating growth curves, per species.
**Result:** trees without measured heights are still realistically sized, and every
value is labelled with its provenance.

### 2. Line-of-Sight Ray Casting

**What it does:** fires thousands of rays outward from the eye position across the
window's field of view into the live 3D scene, recording what each ray hits first —
tree, building, terrain, or nothing.
**Why it matters:** this is what makes occlusion honest. A tree hidden behind a
neighbouring tower is *not* counted as visible greenery.
**Result:** a true visibility field from that exact eye point, not a flat circular
radius drawn on a map.

*Engineering note:* each ray is a genuine scene intersection test, not a cheap
approximation. The engine yields control back to the browser at regular intervals so
large analyses never freeze the page, and ray density is exposed to the user as a
speed-versus-precision dial.

### 3. Multi-Criteria Vegetation Segmentation

**What it does:** classifies every pixel of the captured view. A pixel counts as
vegetation only if it satisfies **all** criteria at once — colour hue within the
foliage band, sufficient saturation and brightness, an "excess green" index above
threshold, a minimum green ratio, and demonstrable green dominance over both red and
blue.
**Why all of them:** any single test misclassifies large parts of a real urban scene.
Requiring simultaneous agreement is what actually excludes roads, roofs, walls,
shadows, vehicles, water and sky.
**Result:** a vegetation mask that survives contact with real city imagery.

**Morphological cleanup pipeline.**
The raw mask then passes through a median filter, a morphological opening, a
morphological closing, and small-blob removal.
**Result:** isolated green speckle on rooftops and pavement is removed, while genuine
canopy stays intact and solid.

**Ground-truth union.**
Manually drawn vegetation is merged in **after** cleanup — user-asserted greenery is
not subjected to a noise filter that exists solely to correct the automatic
classifier's mistakes.

### 4. Occlusion-Aware Polygon Projection

**What it does:** projects hand-drawn vegetation areas into the exact captured frame,
casting a ray to each vertex and rejecting any that a building blocks.
**Result:** no phantom green blobs appearing over building interiors that contain no
greenery at all in the actual captured view.

### 5. Hierarchical Score Roll-Up

**What it does:** aggregates window scores into rooms, rooms into flats, flats into
floors, and floors into a single building figure.
**Result:** one number for the boardroom, and full traceability down to the individual
window behind it.

### 6. Automated Full-Building Sweep

**What it does:** iterates every floor and facade, repositioning the camera
*instantly* rather than animating between poses, capturing a compact thumbnail of each
view for later audit, and ranking floors by average score.
**Result:** a defensible green-exposure ranking across the entire building — which is
what a real estate decision actually requires — produced in one unattended run.

![figure:08-leaderboard.png](Figure 7 — The output of a full sweep: 102 analysed viewpoints ranked best to worst, each with its floor, facade, window and captured thumbnail. This is the deliverable a developer or valuer actually uses.)


### 7. Solar Position and Light-Quality Classification

**What it does:** computes true sun elevation and bearing from planetary-position
astronomy, correctly handling the location's real time zone and daylight-saving
transitions. Direct sunlight on a window is determined from the sun's angle relative
to that window's outward direction, with intensity falling off both with angle and
with how low the sun sits.
**Result:** verifiable answers to "does this flat get morning sun in March?" — and a
three-way split of the view into shadow, canopy-filtered light, and harsh direct
light.

### 8. Weighted Wellness Composite

**What it does:** combines the four environmental metrics into one 0–100 score —
Tree Canopy 31%, Air Quality 31%, Heat Comfort 23%, Noise 15% — each normalised so
higher always means healthier, then converts the result into plain-English insights.
**Result:** a single comparable liveability figure per address, with the weighting
stated openly rather than hidden.

---

## 5. Technology and Architecture

| Layer | Technology | Role |
|---|---|---|
| 3D Engine | **CesiumJS** | Real-world globe, terrain, 3D buildings, ray casting |
| Frontend | **React + TypeScript**, Vite | Interface, analysis panels, state |
| Backend | **Node.js + Express (TypeScript)** | APIs, automation service, job queue |
| Database | **PostgreSQL** | Buildings, floors, viewpoints, results, cached snapshots |
| Automation | **Headless browser (Puppeteer)** | Unattended full-building capture sweeps |
| Deployment | **Vercel** (frontend) + **Render** (backend) | Independent scaling of app and processing |

### External Data Sources

| Source | Provides |
|---|---|
| NYC Parks Forestry Tree Points | Official tree inventory: species, diameter, arborist condition |
| Aerial LiDAR canopy data | Measured tree heights and crown geometry |
| OpenStreetMap / Overpass | Parks, woods, grassland, road network |
| Cesium OSM Buildings | Surrounding city 3D massing (occlusion) |
| EPA AirNow | Live air quality from physical monitoring stations |
| Open-Meteo | Live temperature and feels-like; air-quality fallback |

### Design Principles

1. **Provenance over polish.** Every number is tagged with how it was derived —
   measured, estimated, or defaulted — and the counts are shown to the user.
2. **Estimates are labelled as estimates.** The noise metric says plainly that it is
   inferred from road proximity, not measured with a microphone.
3. **Pluggable data sources.** All vegetation sources sit behind one shared interface,
   so a satellite NDVI layer or a new city's inventory can be added without touching
   the analysis code.
4. **Swappable classifier.** The pixel classifier is isolated behind a stable
   interface — a learned segmentation model can replace the current rule-based one
   without changing anything around it.

---

## 6. Who It Is For, and What It Delivers

| Audience | What GVI gives them |
|---|---|
| **Property developers** | Evidence of which floors and orientations command a green-view premium — before construction, using the 3D model. |
| **Estate agents & marketing** | A verified, visual green-view score per unit, replacing unprovable "leafy outlook" copy. |
| **Valuers & investors** | A consistent, auditable environmental metric that can be compared across buildings and portfolios. |
| **Architects & planners** | Immediate feedback on how massing, orientation and planting change residents' green exposure and daylight. |
| **City & sustainability teams** | Canopy coverage, tree health, species diversity and heat/air-quality context tied to real addresses. |
| **Prospective residents** | An honest look out of the actual window, on the actual floor, at the actual time of day. |

### Why It Is Defensible

- It measures the **view**, not the map. Two flats on the same plot with the same
  "park nearby" get different, correct scores.
- It accounts for **occlusion**. Greenery you cannot see is not counted.
- It shows its **working**. Every score ships with the captured image and the
  highlighted vegetation overlay.
- It states its **limits**. Estimated values are marked as estimated.

---

## 7. Current Status and Roadmap

**Delivered and working today:** the full 3D environment; indoor navigation; window-,
floor- and building-level GVI; multi-source vegetation fusion with provenance; manual
vegetation drawing with import/export; the automated building-wide sweep with a
resumable job queue; live air quality, heat comfort, noise and vegetation health; real
sun and shadow analysis; mobile-responsive interface; and live deployment.

**Natural next steps:**

- **Learned segmentation model** — replace the rule-based pixel classifier with a
  trained semantic-segmentation network for higher accuracy in difficult lighting.
- **Any building, any city** — the current deployment is configured around one
  demonstration building; generalising the placement pipeline opens up arbitrary
  addresses.
- **Seasonal modelling** — winter bare-branch versus summer full-leaf scoring.
- **Measured noise data** — replace the road-proximity heuristic with real complaint
  density or acoustic sensor feeds.
- **Reporting exports** — branded PDF scorecards per unit for listings and valuations.

---

## 8. Summary

GVI turns a subjective, unverifiable property claim into a measured, auditable,
defensible number — and it does so from inside a photo-realistic 3D reconstruction of
the real building in the real city.

It combines official municipal tree inventories, LiDAR canopy scans, live
environmental data feeds and genuine solar astronomy, and it analyses the actual
rendered view from the actual window position, accounting for everything that blocks
it.

The result is a platform that can tell a developer which floors are worth more, tell a
buyer what they will really see, and tell a city where its canopy is working — all
from the same measurement, and all with the working shown.
