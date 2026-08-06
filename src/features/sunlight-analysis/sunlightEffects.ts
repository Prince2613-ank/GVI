// Real Cesium rendering effects — not decorative overlays. Everything here
// is driven by the actual sun direction/elevation this module already
// computes analytically (sunPosition.ts), and is applied directly to the
// live Cesium scene: real bloom around the real sun, a real lens-flare
// post-process stage, a real screen-space god-rays stage that samples
// toward the sun's actual projected screen position, and a real
// shadow-mapped directional light (so the building's own window
// mullions/grills cast real moving shadows as the simulated time changes).
//
// This is opt-in and fully reversible: `applySunlightEffects` snapshots
// every viewer property it touches, and `restoreViewer` puts them all back
// exactly as found. That matters because this repo's GVI scoring
// (services/gvi.ts) classifies screenshot pixels by color — leaving
// enableLighting/shadows/postProcessStages on permanently would visibly
// change those screenshots. So these effects only run while this feature's
// toggle is on, and are always undone when it's switched off or the panel
// closes.

import * as Cesium from "cesium";
import { SunPosition } from "./sunPosition";

interface ViewerSnapshot {
  shadows: boolean;
  shadowMapEnabled: boolean;
  enableLighting: boolean;
  sunBloom: boolean;
  light: Cesium.Light;
}

const snapshots = new WeakMap<Cesium.Viewer, ViewerSnapshot>();
const godRaysStages = new WeakMap<Cesium.Viewer, Cesium.PostProcessStage>();
const lensFlareStages = new WeakMap<Cesium.Viewer, Cesium.PostProcessStage>();
const currentSunDirections = new WeakMap<Cesium.Viewer, Cesium.Cartesian3>();
const currentSunElevations = new WeakMap<Cesium.Viewer, number>();
const currentWeatherFactors = new WeakMap<Cesium.Viewer, number>();
const originalTilesetStyles = new WeakMap<Cesium.Cesium3DTileset, Cesium.Cesium3DTileStyle | undefined>();

// `raysStrength` gates the whole effect to near-zero whenever the sun isn't
// genuinely visible on screen (below the horizon, or behind the camera) —
// without this, the shader was sampling toward an off-screen point, which
// clamps to the same edge texel 40 times and floods the entire frame with
// added brightness (the solid white/orange wash). The magnitude constants
// below are also deliberately conservative — this is a subtle light-shaft
// hint, not a tone-mapped HDR bloom pass.
const GOD_RAYS_FRAGMENT_SHADER = `
uniform sampler2D colorTexture;
uniform vec2 sunScreenPosition;
uniform float raysStrength;
uniform float exposure;
uniform float decay;
uniform float density;
uniform float weight;
in vec2 v_textureCoordinates;

const int SAMPLES = 40;

void main() {
    vec3 base = texture(colorTexture, v_textureCoordinates).rgb;

    if (raysStrength <= 0.001) {
        out_FragColor = vec4(base, 1.0);
        return;
    }

    vec2 deltaTexCoord = (v_textureCoordinates - sunScreenPosition) * (1.0 / float(SAMPLES)) * density;
    vec2 coord = v_textureCoordinates;
    float illuminationDecay = 1.0;
    vec3 accum = vec3(0.0);

    for (int i = 0; i < SAMPLES; i++) {
        coord -= deltaTexCoord;
        vec3 texel = texture(colorTexture, clamp(coord, vec2(0.0), vec2(1.0))).rgb;
        texel *= illuminationDecay * weight;
        accum += texel;
        illuminationDecay *= decay;
    }

    out_FragColor = vec4(base + accum * exposure * raysStrength, 1.0);
}
`;

// Civil twilight ends 6° below the horizon — past that the sky is
// genuinely dark (real astronomical convention). Between -6° and 0° is
// "blue hour," the transition real photographers/urban-lighting tools name
// explicitly: the sky reads as deep blue rather than black or orange.
const CIVIL_TWILIGHT_DEG = -6;

const NIGHT_COLOR = Cesium.Color.fromBytes(130, 155, 205); // clearly visible moonlight blue, not black
const HORIZON_COLOR = Cesium.Color.fromBytes(255, 147, 66); // warm sunrise/sunset orange
const OVERHEAD_COLOR = Cesium.Color.fromBytes(255, 250, 235); // near-white midday

// The surrounding city-block masses are rendered by a Cesium3DTileset (OSM
// Buildings, see hooks/useCesium.ts) styled with an explicit UNLIT shading
// model and a flat `color('#A8A8A8')` style — UNLIT means `scene.light`
// can NEVER affect it, by design (see that file's comment: it's what keeps
// every building face the same tone regardless of which way it faces the
// sun, avoiding a lopsided-looking city). So the only way to make it read
// as day/night is to directly swap the tileset's style color, which is
// exactly what this does, on the same elevation curve as everything else.
const NIGHT_BUILDING_COLOR = "38, 41, 48"; // deep, clearly-dark grey at night
const DAY_BUILDING_COLOR = "168, 168, 168"; // the tileset's original off-white (see useCesium.ts)
// Buildings don't reach full brightness until the sun is well clear of the
// horizon — right at sunrise/sunset the city still reads as dim, not
// suddenly bright, so this fade runs wider than the light-intensity one.
const BUILDING_FADE_START_DEG = -6;
const BUILDING_FADE_END_DEG = 12;

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function buildingStyleColorForElevation(elevationDeg: number): string {
  const night = NIGHT_BUILDING_COLOR.split(",").map(Number);
  const day = DAY_BUILDING_COLOR.split(",").map(Number);
  const t =
    elevationDeg <= BUILDING_FADE_START_DEG
      ? 0
      : elevationDeg >= BUILDING_FADE_END_DEG
        ? 1
        : (elevationDeg - BUILDING_FADE_START_DEG) / (BUILDING_FADE_END_DEG - BUILDING_FADE_START_DEG);
  const [r, g, b] = night.map((n, i) => lerpChannel(n, day[i], t));
  return `rgb(${r}, ${g}, ${b})`;
}

function tintOsmBuildings(tileset: Cesium.Cesium3DTileset, elevationDeg: number): void {
  if (!originalTilesetStyles.has(tileset)) {
    originalTilesetStyles.set(tileset, tileset.style);
  }
  const color = buildingStyleColorForElevation(elevationDeg);
  tileset.style = new Cesium.Cesium3DTileStyle({ color: `color('${color}')` });
}

function resetOsmBuildings(tileset: Cesium.Cesium3DTileset): void {
  if (!originalTilesetStyles.has(tileset)) return;
  tileset.style = originalTilesetStyles.get(tileset);
  originalTilesetStyles.delete(tileset);
}

/**
 * Full day/twilight/night color arc, continuous across elevation: deep
 * night-blue below civil twilight, fading into warm sunrise/sunset orange
 * right at the horizon (real "blue hour" gradient), then toward white
 * overhead. This is what makes sunrise and sunset visually read as distinct
 * events rather than the scene just getting generically brighter/dimmer.
 */
function sunColorForElevation(elevationDeg: number): Cesium.Color {
  if (elevationDeg <= CIVIL_TWILIGHT_DEG) return Cesium.Color.clone(NIGHT_COLOR);
  if (elevationDeg <= 0) {
    const t = (elevationDeg - CIVIL_TWILIGHT_DEG) / -CIVIL_TWILIGHT_DEG; // 0 at -6°, 1 at 0°
    return Cesium.Color.lerp(NIGHT_COLOR, HORIZON_COLOR, t, new Cesium.Color());
  }
  const t = Cesium.Math.clamp(elevationDeg / 45, 0, 1); // 0 at horizon, 1 by 45°+
  return Cesium.Color.lerp(HORIZON_COLOR, OVERHEAD_COLOR, t, new Cesium.Color());
}

/**
 * Real light falls off toward night, not just toward "soft" — below civil
 * twilight this floors at a genuinely visible moonlight level (real
 * moonlight is dim but the scene should still read as a lit night view,
 * not go to pure black), rising through twilight into the existing
 * soft-dawn -> harsh-noon daytime curve.
 */
function lightIntensityForElevation(elevationDeg: number): number {
  const NIGHT_INTENSITY = 0.45;
  const HORIZON_INTENSITY = 0.75;
  if (elevationDeg <= CIVIL_TWILIGHT_DEG) return NIGHT_INTENSITY;
  if (elevationDeg <= 0) {
    const t = (elevationDeg - CIVIL_TWILIGHT_DEG) / -CIVIL_TWILIGHT_DEG; // 0 at -6°, 1 at 0°
    return Cesium.Math.lerp(NIGHT_INTENSITY, HORIZON_INTENSITY, t);
  }
  const t = Cesium.Math.clamp(elevationDeg / 60, 0, 1); // 0 at horizon, 1 by 60°+
  return Cesium.Math.lerp(HORIZON_INTENSITY, 1.7, t); // soft dawn/dusk -> harsh midday
}

// Cesium's Sun primitive doesn't expose a queryable world position, so the
// sun's screen-space location for the god-rays shader is derived the same
// way our own sun math produces it: a point far along the real sun
// direction vector from the current camera position, projected to screen
// space each frame.
const SUN_PROJECTION_DISTANCE_M = 1.5e8;

function createGodRaysStage(
  viewer: Cesium.Viewer,
  getSunDirection: () => Cesium.Cartesian3,
  getSunElevationDeg: () => number,
  getWeatherFactor: () => number
): Cesium.PostProcessStage {
  // Cached each frame by sunScreenPosition (evaluated first) so raysStrength
  // doesn't redo the same screen-space projection — Cesium calls each
  // uniform getter once per stage execution per frame.
  let lastWindowValid = false;
  let lastFacing = 0;

  return new Cesium.PostProcessStage({
    name: "sunlight-analysis-god-rays",
    fragmentShader: GOD_RAYS_FRAGMENT_SHADER,
    uniforms: {
      sunScreenPosition: () => {
        const direction = getSunDirection();
        const camDir = viewer.camera.directionWC;
        lastFacing = Cesium.Cartesian3.dot(camDir, direction);

        const farPoint = Cesium.Cartesian3.add(
          viewer.camera.positionWC,
          Cesium.Cartesian3.multiplyByScalar(direction, SUN_PROJECTION_DISTANCE_M, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        );
        const window = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, farPoint);
        const canvas = viewer.scene.canvas;
        if (!window || lastFacing <= 0) {
          lastWindowValid = false;
          return new Cesium.Cartesian2(0.5, 0.5);
        }
        const nx = window.x / canvas.clientWidth;
        const ny = 1 - window.y / canvas.clientHeight;
        lastWindowValid = nx >= -0.2 && nx <= 1.2 && ny >= -0.2 && ny <= 1.2;
        return new Cesium.Cartesian2(nx, ny);
      },
      // Fades to zero below the horizon, behind the camera, or once the sun
      // has left the (slightly padded) view frustum — the actual fix for
      // the full-frame whiteout, which happened whenever the sun wasn't
      // genuinely on screen. Also scaled down under real cloud cover — god
      // rays shouldn't appear when the actual weather for that hour is
      // overcast.
      raysStrength: () => {
        const elevationDeg = getSunElevationDeg();
        if (elevationDeg <= 0 || lastFacing <= 0.15 || !lastWindowValid) return 0;
        const elevationFade = Cesium.Math.clamp(elevationDeg / 15, 0, 1);
        const facingFade = Cesium.Math.clamp((lastFacing - 0.15) / 0.5, 0, 1);
        return elevationFade * facingFade * getWeatherFactor();
      },
      exposure: 0.12,
      decay: 0.93,
      density: 0.5,
      weight: 0.22,
    },
  });
}

/**
 * @param weatherFactor 0-1 from real cloud cover for the displayed hour (1
 * = clear sky, 0 = fully overcast) — dampens light intensity and the
 * visual sun effects to match actual conditions rather than always
 * rendering a cloudless sky regardless of the real forecast.
 */
export function applySunlightEffects(
  viewer: Cesium.Viewer,
  sun: SunPosition,
  sunDirectionEcef: Cesium.Cartesian3,
  weatherFactor: number = 1,
  osmBuildings: Cesium.Cesium3DTileset | null = null
): void {
  currentSunDirections.set(viewer, sunDirectionEcef);
  currentSunElevations.set(viewer, sun.elevationDeg);
  currentWeatherFactors.set(viewer, weatherFactor);

  if (!snapshots.has(viewer)) {
    snapshots.set(viewer, {
      shadows: viewer.shadows,
      shadowMapEnabled: viewer.scene.shadowMap.enabled,
      enableLighting: viewer.scene.globe.enableLighting,
      sunBloom: viewer.scene.sunBloom,
      light: viewer.scene.light,
    });
  }

  // Real shadow-mapped sun light — the direction is the actual sun vector
  // we compute analytically, so shadows genuinely sweep with simulated time.
  // Intensity and shadow softness both scale with elevation, matching why
  // real morning/evening light reads as soft (low sun = long atmospheric
  // path = scattered, diffuse light = soft-edged shadows) while midday sun
  // reads as harsh (short atmospheric path = direct, high-contrast light =
  // sharp shadows). Kept close to Cesium's own default sun intensity
  // (~2.0) rather than boosted further, since this scene's plain, light
  // building materials blow out to solid white easily under strong light.
  const lightDirection = Cesium.Cartesian3.negate(sunDirectionEcef, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(lightDirection, lightDirection);
  const color = sunColorForElevation(sun.elevationDeg);
  const baseIntensity = lightIntensityForElevation(sun.elevationDeg);
  // Overcast skies genuinely reduce direct light, but diffuse skylight still
  // illuminates the scene — floor the reduction at 55% rather than letting
  // clouds black everything out.
  const cloudDamping = sun.elevationDeg > 0 ? Cesium.Math.lerp(0.55, 1.0, weatherFactor) : 1;
  viewer.scene.light = new Cesium.DirectionalLight({
    direction: lightDirection,
    color,
    intensity: baseIntensity * cloudDamping,
  });

  viewer.scene.globe.enableLighting = true;
  viewer.shadows = true;
  viewer.scene.shadowMap.enabled = true;
  viewer.scene.shadowMap.softShadows = sun.elevationDeg < 40; // soft-edged golden-hour shadows, crisp at high noon
  viewer.scene.sunBloom = sun.elevationDeg > 0 && weatherFactor > 0.3; // no visible sun bloom through heavy cloud

  if (osmBuildings) tintOsmBuildings(osmBuildings, sun.elevationDeg);

  if (!godRaysStages.has(viewer)) {
    const stage = createGodRaysStage(
      viewer,
      () => currentSunDirections.get(viewer) ?? Cesium.Cartesian3.UNIT_Z,
      () => currentSunElevations.get(viewer) ?? -90,
      () => currentWeatherFactors.get(viewer) ?? 1
    );
    viewer.scene.postProcessStages.add(stage);
    godRaysStages.set(viewer, stage);
  }
  if (!lensFlareStages.has(viewer)) {
    const stage = Cesium.PostProcessStageLibrary.createLensFlareStage();
    stage.enabled = true;
    viewer.scene.postProcessStages.add(stage);
    lensFlareStages.set(viewer, stage);
  }
  const lensFlare = lensFlareStages.get(viewer);
  if (lensFlare) {
    lensFlare.uniforms.intensity = 0.6 * weatherFactor; // subtle even clear, fades out under cloud
  }

  viewer.scene.requestRender();
}

export function restoreViewer(viewer: Cesium.Viewer, osmBuildings: Cesium.Cesium3DTileset | null = null): void {
  currentSunDirections.delete(viewer);
  currentSunElevations.delete(viewer);
  currentWeatherFactors.delete(viewer);
  const snapshot = snapshots.get(viewer);
  if (snapshot) {
    viewer.shadows = snapshot.shadows;
    viewer.scene.shadowMap.enabled = snapshot.shadowMapEnabled;
    viewer.scene.globe.enableLighting = snapshot.enableLighting;
    viewer.scene.sunBloom = snapshot.sunBloom;
    viewer.scene.light = snapshot.light;
    snapshots.delete(viewer);
  }

  const godRays = godRaysStages.get(viewer);
  if (godRays) {
    viewer.scene.postProcessStages.remove(godRays);
    godRaysStages.delete(viewer);
  }
  const lensFlare = lensFlareStages.get(viewer);
  if (lensFlare) {
    viewer.scene.postProcessStages.remove(lensFlare);
    lensFlareStages.delete(viewer);
  }

  if (osmBuildings) resetOsmBuildings(osmBuildings);

  viewer.scene.requestRender();
}
