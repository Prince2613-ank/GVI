import { chromium } from "playwright";

const browser = await chromium.launch({ args: ["--no-sandbox", "--ignore-gpu-blocklist", "--enable-webgl"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (err) => console.log("PAGEERROR:", err.message));

await page.goto("http://localhost:5184", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(13000);
await page.screenshot({ path: "screenshot13.png" });
await browser.close();
