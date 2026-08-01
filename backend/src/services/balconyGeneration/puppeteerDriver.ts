import puppeteer, { Browser } from "puppeteer";
import { BalconyDirection } from "../../types";

export interface AutomationCaptureResult {
  ok: boolean;
  error?: string;
  previewImageDataUrl?: string;
  maskImageDataUrl?: string;
  width?: number;
  height?: number;
  gviScore?: number;
  greenPixelCount?: number;
  greyPixelCount?: number;
  totalPixelCount?: number;
  camera?: {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
  };
}

const FRONTEND_URL = process.env.BALCONY_FRONTEND_URL ?? "http://localhost:5173";
const CAPTURE_TIMEOUT_MS = Number(process.env.BALCONY_CAPTURE_TIMEOUT_MS ?? 60_000);

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
    });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  await browser.close();
  browserPromise = null;
}

/**
 * Drives the REAL cesium-demo frontend (via its ?automation=1 harness — see
 * cesium-demo/src/features/balcony-debug/AutomationHarness.tsx) through one
 * complete viewpoint capture: navigate -> the page flies its own camera,
 * waits for render stability, captures its own canvas, and runs the
 * existing GVI pixel-classification pipeline entirely client-side -> the
 * page calls back into `window.__reportBalconyCapture`, which this function
 * listens for via `exposeFunction`.
 */
export async function captureViewpoint(params: {
  floor: number;
  direction: BalconyDirection;
  flat: number;
  /** A manually-verified position (synced in via /import-positions) that overrides the harness's generic per-floor/side/flat formula. */
  overridePosition?: { longitude: number; latitude: number; height: number };
}): Promise<AutomationCaptureResult> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  try {
    const result = await new Promise<AutomationCaptureResult>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Capture timed out after ${CAPTURE_TIMEOUT_MS}ms`));
      }, CAPTURE_TIMEOUT_MS);

      page
        .exposeFunction("__reportBalconyCapture", (payload: AutomationCaptureResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(payload);
        })
        .then(() => {
          const url = new URL(FRONTEND_URL);
          url.searchParams.set("automation", "1");
          url.searchParams.set("floor", String(params.floor));
          url.searchParams.set("direction", params.direction);
          url.searchParams.set("flat", String(params.flat));
          if (params.overridePosition) {
            url.searchParams.set("lon", String(params.overridePosition.longitude));
            url.searchParams.set("lat", String(params.overridePosition.latitude));
            url.searchParams.set("h", String(params.overridePosition.height));
          }
          return page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: CAPTURE_TIMEOUT_MS });
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        });
    });

    if (!result.ok) throw new Error(result.error ?? "Automation harness reported failure");
    return result;
  } finally {
    await page.close().catch(() => undefined);
  }
}
