#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

const host = "127.0.0.1";
const timeoutMs = Number(process.env.V3_FRONTEND_E2E_TIMEOUT_MS ?? 180000);
const chromePath = process.env.CHROME_PATH ?? findChromePath();
const mode = process.argv.includes("--import-model") ? "import-model" : "buddha-fixture";
const children = [];
const tempDirs = [];

class CdpClient {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.commandTimeoutMs = Number(process.env.V3_FRONTEND_E2E_CDP_TIMEOUT_MS ?? 8000);
  }

  open() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
        else resolve(message.result ?? {});
      }
    });
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket is not open for ${method}`));
    }
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, this.commandTimeoutMs).unref();
    });
  }

  fire(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ id: ++this.id, method, params }));
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Ignore shutdown errors for throwaway browser targets.
    }
  }

  async evaluate(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    return result.result?.value;
  }
}

if (!chromePath) {
  console.log(JSON.stringify({
    ok: false,
    skipped: true,
    reason: "Chrome or Edge executable was not found. Set CHROME_PATH to enable the browser E2E."
  }, null, 2));
  process.exit(1);
}

try {
  const apiPort = await findOpenPort(Number(process.env.V3_FRONTEND_E2E_API_PORT ?? 18877));
  const vitePort = await findOpenPort(Number(process.env.V3_FRONTEND_E2E_VITE_PORT ?? 15173));
  const debugPort = await findOpenPort(Number(process.env.V3_FRONTEND_E2E_CHROME_PORT ?? 19222));
  const userDataDir = mkdtempSync(join(tmpdir(), "hediao3d-chrome-e2e-"));
  tempDirs.push(userDataDir);

  start("api", process.execPath, ["server.mjs"], {
    ...process.env,
    API_PORT: String(apiPort)
  });
  start("vite", process.execPath, [join("node_modules", "vite", "bin", "vite.js"), "--host", host, "--port", String(vitePort), "--strictPort"], {
    ...process.env,
    API_PORT: String(apiPort),
    VITE_PORT: String(vitePort),
    VITE_API_PROXY_TARGET: `http://${host}:${apiPort}`
  });
  await waitForHttp(`http://${host}:${apiPort}/api/health`, timeoutMs, "API health");
  await waitForHttp(`http://${host}:${vitePort}/`, timeoutMs, "Vite UI");
  const pageUrl = `http://${host}:${vitePort}/`;
  start("chrome", chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,960",
    "about:blank"
  ], process.env);
  const page = await openChromePage(debugPort, pageUrl);
  await sleep(1000);

  await installDownloadProbe(page);

  await clickButton(page, "建模3D/Meshy");
  await waitForCondition(page, () => document.body.innerText.includes("推荐：真实3D网格"), 10000, "model stage visible");
  if (mode === "import-model") {
    await importInlineStlModel(page);
    await waitForCondition(page, () => {
      const text = document.body.innerText;
      return text.includes("原始3D模型已缓存")
        || text.includes("后端 CAM 可读取")
        || text.includes("已导入原始3D模型");
    }, 30000, "imported STL model cached for CAM");
  } else {
    await clickButton(page, "载入佛头测试模型");
    await waitForCondition(page, () => {
      const text = document.body.innerText;
      return text.includes("后端 CAM 可读取")
        || text.includes("去生成试雕刀路")
        || text.includes("Mesh 可进入刀路生成")
        || text.includes("Meshy模型已加载");
    }, 20000, "Buddha test model ready for CAM");
  }

  const movedToCam = await clickButtonIfPresent(page, "去生成试雕刀路");
  if (!movedToCam) await clickButton(page, "刀路生成/下载");
  await waitForCondition(page, () => document.body.innerText.includes("生成试雕刀路与安全包"), 10000, "CAM action visible");

  await clickButton(page, "生成试雕刀路与安全包");
  await waitForCondition(page, () => {
    const activeTab = [...document.querySelectorAll(".workbench-tabs button.active")].map((item) => item.textContent?.trim()).join(" ");
    const hasSimulationCanvas = [...document.querySelectorAll("canvas")].some((canvas) => canvas.clientWidth > 100 && canvas.clientHeight > 100);
    return document.body.innerText.includes("试雕刀路已生成")
      && activeTab.includes("模拟雕刻")
      && hasSimulationCanvas
      && [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("下载安全试雕包") && !button.disabled);
  }, timeoutMs, "trial toolpath generated and simulation view rendered");

  await clickButton(page, "下载安全试雕包");
  await waitForCondition(page, () => {
    const downloads = window.__hediaoDownloads || [];
    return downloads.some((item) => /trial|试雕|safe|package|zip/i.test(item.download || "") && item.blob?.size > 1000);
  }, 60000, "safe trial package download triggered");

  await assertArtifactDownload(page, "加工包说明", /operator-runbook|operator-download-checklist|operator-note/i, "operator package note download");
  await assertArtifactDownload(page, "下载空跑 NC", /air-run\.nc$/i, "air-run NC download");
  await assertArtifactDownload(page, "下载安全报告 JSON", /production-gate|nc-static-analysis|safety-report.*\.json/i, "safety report JSON download");
  await assertArtifactDownload(page, "下载安全报告 MD", /operator-runbook|operator-download-checklist|safety-report.*\.md/i, "safety report Markdown download");

  const summary = await page.evaluate(() => {
    const activeTab = [...document.querySelectorAll(".workbench-tabs button.active")].map((item) => item.textContent?.trim()).join(" ");
    const canvases = [...document.querySelectorAll("canvas")].map((canvas) => ({
      width: canvas.clientWidth,
      height: canvas.clientHeight
    }));
    const downloads = window.__hediaoDownloads || [];
    return {
      trialGenerated: document.body.innerText.includes("试雕刀路已生成")
        || activeTab.includes("模拟雕刻")
        || downloads.some((item) => /trial|试雕|safe|package|zip/i.test(item.download || "")),
      activeTab,
      canvasCount: canvases.length,
      visibleCanvasCount: canvases.filter((item) => item.width > 100 && item.height > 100).length,
      downloads,
      artifactDownloads: {
        operator: downloads.some((item) => /operator-runbook|operator-download-checklist|operator-note/i.test(item.download || "")),
        airRun: downloads.some((item) => /air-run\.nc$/i.test(item.download || "")),
        safetyJson: downloads.some((item) => /production-gate|nc-static-analysis|safety-report.*\.json/i.test(item.download || "")),
        safetyMarkdown: downloads.some((item) => /operator-runbook|operator-download-checklist|safety-report.*\.md/i.test(item.download || ""))
      },
      safeTrialButtonEnabled: [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("下载安全试雕包") && !button.disabled)
    };
  });

  console.log(JSON.stringify({
    ok: true,
    schema: "hediao3d.v3-frontend-operator-e2e.v1",
    mode,
    ui: pageUrl,
    api: `http://${host}:${apiPort}`,
    chrome: chromePath,
    summary
  }, null, 2));
} finally {
  await shutdown();
}

async function importInlineStlModel(page) {
  const result = await page.evaluate((stlText) => {
    const input = document.querySelector('input[type="file"][accept*=".stl"]');
    if (!input) return { ok: false, reason: "original model file input not found" };
    const file = new File([stlText], "browser-import-fixture.stl", { type: "model/stl" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, filename: file.name, size: file.size };
  }, createBrowserImportStl());
  if (!result.ok) throw new Error(`Failed to import inline STL model: ${result.reason}`);
  return result;
}

function start(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  children.push(child);
  child.stdout?.on("data", (chunk) => {
    if (process.env.V3_TEST_VERBOSE) process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    if (process.env.V3_TEST_VERBOSE) process.stderr.write(`[${label}] ${chunk}`);
  });
}

async function shutdown() {
  for (const child of children.reverse()) {
    if (!child.killed) {
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } else {
        child.kill();
      }
    }
  }
  await sleep(500);
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      if (process.env.V3_TEST_VERBOSE) {
        console.warn(`Failed to remove temporary Chrome profile ${dir}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

async function openChromePage(port, url) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < 60000) {
    let page = null;
    try {
      await requestJson(`http://${host}:${port}/json/version`);
      page = await createChromePage(port, url);
      await waitForPageReady(page);
      return page;
    } catch (error) {
      lastError = error;
      page?.close();
      // Chrome may still be opening the debugging endpoint.
    }
    await sleep(750);
  }
  throw new Error(`Timed out opening Chrome app page: ${lastError instanceof Error ? lastError.message : lastError ?? "unknown error"}`);
}

async function createChromePage(port, url) {
  const target = await requestJson(`http://${host}:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const ws = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await ws.open();
    return ws;
  } catch (error) {
    ws.close();
    throw error;
  }
}

async function waitForPageReady(page) {
  await waitForCondition(page, () => location.href.startsWith("http://127.0.0.1:")
    && Boolean(document.querySelector("#root")), 60000, "page shell ready");
}

async function installDownloadProbe(page) {
  await page.evaluate(() => {
    window.__hediaoDownloads = [];
    window.__hediaoLastBlob = null;
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__hediaoLastBlob = { size: blob.size, type: blob.type };
      return originalCreateObjectUrl(blob);
    };
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedClick() {
      window.__hediaoDownloads.push({
        download: this.download,
        href: this.href,
        blob: window.__hediaoLastBlob
      });
      return originalClick.call(this);
    };
  });
}

async function clickButton(page, text) {
  await waitForCondition(page, (label) => [...document.querySelectorAll("button")]
    .some((item) => item.textContent?.replace(/\s+/g, " ").includes(label) && !item.disabled), 60000, `button ready: ${text}`, text);
  const result = await page.evaluate((label) => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.replace(/\s+/g, " ").includes(label) && !item.disabled);
    if (!button) {
      return {
        ok: false,
        buttons: [...document.querySelectorAll("button")].slice(0, 40).map((item) => ({
          text: item.textContent?.replace(/\s+/g, " ").trim(),
          disabled: item.disabled
        }))
      };
    }
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return { ok: true, text: button.textContent?.replace(/\s+/g, " ").trim() };
  }, text);
  if (!result.ok) throw new Error(`Button not found or disabled: ${text}\n${JSON.stringify(result.buttons, null, 2)}`);
  await sleep(150);
  return result;
}

async function clickButtonIfPresent(page, text) {
  const result = await page.evaluate((label) => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.replace(/\s+/g, " ").includes(label) && !item.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return true;
  }, text);
  await sleep(150);
  return Boolean(result);
}

async function assertArtifactDownload(page, buttonText, filenamePattern, label) {
  const beforeCount = await page.evaluate(() => (window.__hediaoDownloads || []).length);
  await clickButton(page, buttonText);
  await waitForCondition(page, ({ patternSource, previousCount }) => {
    const pattern = new RegExp(patternSource, "i");
    const downloads = window.__hediaoDownloads || [];
    return downloads.slice(previousCount).some((item) => pattern.test(item.download || "") && item.blob?.size > 0);
  }, 60000, label, { patternSource: filenamePattern.source, previousCount: beforeCount });
}

async function waitForCondition(page, fn, limitMs, label, arg) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < limitMs) {
    try {
      if (arg === undefined ? await page.evaluate(fn) : await page.evaluate(fn, arg)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  let pageText = "";
  let pageState = "";
  try {
    const diagnostic = await page.evaluate(() => ({
      href: location.href,
      readyState: document.readyState,
      hasRoot: Boolean(document.querySelector("#root")),
      text: document.body?.innerText?.replace(/\s+/g, " ").slice(0, 1600) ?? ""
    }));
    pageState = `\nPage state: ${JSON.stringify({ href: diagnostic.href, readyState: diagnostic.readyState, hasRoot: diagnostic.hasRoot })}`;
    pageText = diagnostic.text;
  } catch {
    // Ignore diagnostic failures.
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}${pageState}${pageText ? `\nPage text: ${pageText}` : ""}`);
}

async function waitForHttp(url, limitMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < limitMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}: ${url}`);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function findChromePath() {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function findOpenPort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No open port found from ${startPort}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBrowserImportStl() {
  return `solid browser_import
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 38 0 0.6
      vertex 0 15 0.2
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 38 0 0.6
      vertex 38 15 1.1
      vertex 0 15 0.2
    endloop
  endfacet
endsolid browser_import
`;
}
