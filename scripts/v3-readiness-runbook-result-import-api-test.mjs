#!/usr/bin/env node

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";

async function main() {
  await getJson("/api/health");
  const readiness = await postJson("/api/orchestrator/readiness", {});
  assert(readiness.schema === "hediao3d.v3-readiness-report.v1", "readiness schema mismatch");
  assert(readiness.id, "readiness missing id");

  const invalid = await postJsonAllowingStatus("/api/orchestrator/readiness/runbook-result", {
    schema: "wrong",
    readinessReportId: readiness.id
  }, 400);
  assert(/schema/.test(invalid.error ?? ""), "invalid runbook result should fail on schema");

  const failedResult = createRunbookResultFixture(readiness, false);
  const imported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result.json",
    result: failedResult
  });
  assert(imported.schema === "hediao3d.v3-acceptance-runbook-result.v1", "imported runbook result schema mismatch");
  assert(imported.readinessReportId === readiness.id, "imported runbook result readiness id mismatch");
  assert(imported.identityValid === true, "imported runbook result should be identity-valid");
  assert(imported.ok === false, "failed runbook fixture should not be ok");
  assert(imported.failedCount === 1, "failed runbook fixture should report one failed step");
  assert(imported.blockingFailedCount === 1, "failed runbook fixture should report one blocking failure");
  assert(imported.productionSafe === false, "failed runbook fixture should not be production-safe");
  assert(imported.apiArtifacts?.json?.endsWith("v3-acceptance-runbook-result.json"), "imported runbook result should expose JSON artifact");
  assert(imported.apiArtifacts?.importJson?.endsWith("v3-acceptance-runbook-result-import.json"), "imported runbook result should expose import artifact");

  const importedArtifact = await getJson(imported.apiArtifacts.json);
  assert(importedArtifact.importSource?.route === "/api/orchestrator/readiness/runbook-result", "artifact should preserve import route");
  const importArtifact = await getJson(imported.apiArtifacts.importJson);
  assert(importArtifact.schema === "hediao3d.v3-acceptance-runbook-result-import.v1", "import artifact schema mismatch");
  assert(importArtifact.blockingFailedCount === 1, "import artifact should preserve blocking failure count");

  const zipResult = createRunbookResultFixture(readiness, true);
  const zipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "README-RUNBOOK-RESULT.md", content: "HeDiao3D V3 runbook result bundle\n" }
  ]);
  const zipImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${zipBytes.toString("base64")}`
  });
  assert(zipImported.ok === true, "zip imported runbook result should be ok");
  assert(zipImported.identityValid === true, "zip imported runbook result should be identity-valid");
  assert(zipImported.productionSafe === true, "zip imported all-pass result should be production-safe as a runbook result");
  assert(zipImported.apiArtifacts?.zipBundle?.endsWith("imported-v3-acceptance-runbook-result-bundle.zip"), "zip import should expose preserved source bundle");

  const latest = await getJson("/api/orchestrator/readiness/runbook-result/latest");
  assert(latest.latest?.readinessReportId === readiness.id, "latest runbook result should point to imported readiness id");
  assert(latest.latest.identityValid === true, "latest runbook result should remain identity-valid");
  assert(latest.latest.ok === true, "latest runbook result should be the zip all-pass import");

  const readinessAfterImport = await postJson("/api/orchestrator/readiness", {});
  assert(readinessAfterImport.runbookResult?.readinessReportId === readiness.id, "readiness should include latest imported runbook result");
  assert(readinessAfterImport.runbookResult?.identityValid === true, "readiness should see identity-valid runbook result");
  assert(readinessAfterImport.runbookResult?.productionSafe === true, "readiness should preserve runbook productionSafe flag");
  assert(readinessAfterImport.gates.allowProductionNc === false, "runbook import alone must not unlock production NC");

  console.log(JSON.stringify({
    ok: true,
    readinessId: readiness.id,
    failedImport: imported.failedCount,
    zipImportOk: zipImported.ok,
    latestProductionSafe: latest.latest.productionSafe,
    readinessLevel: readinessAfterImport.level,
    production: readinessAfterImport.gates.allowProductionNc
  }, null, 2));
}

function createRunbookResultFixture(readiness, passing) {
  const readinessCreatedAt = readiness.createdAt;
  const runbookGeneratedAt = readiness.createdAt;
  const createdAt = new Date(Date.parse(readiness.createdAt) + 1000).toISOString();
  const steps = [
    {
      id: "native-cam-readiness",
      title: "Native CAM 环境验收",
      statusAtReport: "blocked",
      blocksProduction: true,
      evidence: ["native-cam-readiness.json"],
      command: "npm run test:v3:native-cam",
      exitCode: passing ? 0 : 1,
      ok: passing
    },
    {
      id: "v3-small-loop",
      title: "V3 小闭环",
      statusAtReport: "review",
      blocksProduction: false,
      evidence: ["production-gate.json"],
      command: "npm run test:v3",
      exitCode: 0,
      ok: true
    }
  ];
  const failed = steps.filter((step) => !step.ok);
  const blockingFailed = failed.filter((step) => step.blocksProduction);
  return {
    schema: "hediao3d.v3-acceptance-runbook-result.v1",
    readinessReportId: readiness.id,
    readinessCreatedAt,
    runbookGeneratedAt,
    createdAt,
    levelAtReport: readiness.level,
    acceptanceAtReport: `${readiness.acceptancePlan?.completed ?? 0}/${readiness.acceptancePlan?.total ?? 0}`,
    commandCount: steps.length,
    blockingStepCountAtReport: steps.filter((step) => step.blocksProduction).length,
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      apiBase: baseUrl
    },
    exitCode: failed.length ? 1 : 0,
    ok: failed.length === 0,
    failedCount: failed.length,
    blockingFailedCount: blockingFailed.length,
    productionSafe: failed.length === 0 && blockingFailed.length === 0,
    failedSteps: failed.map((step) => ({
      id: step.id,
      title: step.title,
      exitCode: step.exitCode,
      blocksProduction: step.blocksProduction
    })),
    steps
  };
}

function createZip(files) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), "utf8");
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      nameBytes
    ]);
    chunks.push(localHeader, data);
    const centralHeader = Buffer.concat([
      uint32(0x02014b50),
      uint16(20),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(offset),
      nameBytes
    ]);
    centralDirectory.push(centralHeader);
    offset += localHeader.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const endRecord = Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(centralSize),
    uint32(centralOffset),
    uint16(0)
  ]);
  return Buffer.concat([...chunks, ...centralDirectory, endRecord]);
}

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value & 0xffff, 0);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function postJsonAllowingStatus(path, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  assert(response.status === expectedStatus, `${path} expected ${expectedStatus}, got ${response.status}`);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
