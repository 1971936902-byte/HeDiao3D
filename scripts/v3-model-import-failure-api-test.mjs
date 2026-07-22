#!/usr/bin/env node

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";

async function main() {
  await getJson("/api/health");

  const unsupported = await postJsonExpectFailure("/api/mesh/import", {
    filename: "not-a-model.zip",
    dataUrl: `data:application/zip;base64,${Buffer.from("zip-bytes", "utf8").toString("base64")}`
  });
  assert(unsupported.status === 400, `unsupported format should be 400, got ${unsupported.status}`);
  assert(/stl|obj|glb|gltf/i.test(unsupported.data.error ?? ""), "unsupported format error should list supported mesh formats");

  const empty = await postJsonExpectFailure("/api/mesh/import", {
    filename: "empty.stl",
    dataUrl: "data:model/stl;base64,"
  });
  assert(empty.status === 400, `empty model should be 400, got ${empty.status}`);
  assert(/为空|太小|empty/i.test(empty.data.error ?? ""), "empty model error should explain the file is empty");

  const invalidObj = await postJsonExpectFailure("/api/mesh/import", {
    filename: "invalid.obj",
    dataUrl: `data:model/obj;base64,${Buffer.from("# no faces\nv 0 0 0\n", "utf8").toString("base64")}`
  });
  assert(invalidObj.status === 400, `invalid OBJ should be 400, got ${invalidObj.status}`);
  assert(/无法进入 CAM|三角面|Mesh|太小|为空/i.test(invalidObj.data.error ?? ""), "invalid OBJ error should explain CAM geometry validation failed");

  const imported = await postJson("/api/mesh/import", {
    filename: "valid-import-fixture.obj",
    dataUrl: `data:model/obj;base64,${Buffer.from(createValidObj(), "utf8").toString("base64")}`
  });
  assert(imported.format === "obj", `valid OBJ import format mismatch: ${imported.format}`);
  assert(imported.modelUrl?.startsWith("/imported-models/"), `valid OBJ model URL mismatch: ${imported.modelUrl}`);
  assert(imported.camModelUrl === imported.modelUrl, "valid OBJ camModelUrl should match modelUrl");
  assert(imported.meshQuality && typeof imported.meshQuality === "object", "valid OBJ import should return meshQuality");
  assert(imported.meshQuality?.triangleCount >= 4, `valid OBJ triangle count too low: ${imported.meshQuality?.triangleCount}`);

  console.log(JSON.stringify({
    ok: true,
    schema: "hediao3d.v3-model-import-failure-api-test.v1",
    failures: {
      unsupported: unsupported.data.error,
      empty: empty.data.error,
      invalidObj: invalidObj.data.error
    },
    valid: {
      modelUrl: imported.modelUrl,
      triangleCount: imported.meshQuality.triangleCount,
      qualityStatus: imported.meshQuality.status
    }
  }, null, 2));
}

function createValidObj() {
  return [
    "# HeDiao3D valid import fixture",
    "v 0 0 0",
    "v 1 0 0",
    "v 1 1 0",
    "v 0 1 0",
    "v 0.5 0.5 1",
    "f 1 2 5",
    "f 2 3 5",
    "f 3 4 5",
    "f 4 1 5",
    "f 1 4 3 2",
    ""
  ].join("\n");
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

async function postJsonExpectFailure(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  assert(!response.ok, `${path} should fail but returned ${response.status}`);
  return { status: response.status, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
