# HeDiao3D V3 Linux 部署指南

日期：2026-07-17
分支：`HeDiao3D_V3`

## 1. 部署目标

V3 推荐部署为：

```text
Nginx
  /              -> dist/ 前端静态文件
  /api/*         -> Node Orchestrator API :8787

Node Orchestrator
  Meshy 代理
  V3 job 队列
  文件缓存
  Mesh 体检/修复计划
  外部 CAM adapter 预检与调用
```

## 2. 基础安装

```bash
git clone git@github.com:1971936902-byte/HeDiao3D.git
cd HeDiao3D
git checkout HeDiao3D_V3
npm install
cp .env.example .env
```

编辑 `.env`：

```bash
nano .env
```

至少确认：

```env
API_PORT=8787
MESHY_API_KEY=你的MeshyKey
ORCHESTRATOR_CONCURRENCY=1
ENABLE_EXTERNAL_CAM_ADAPTERS=false
HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT=false
HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT=false
HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT=false
HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN=false
ORCHESTRATOR_AUTO_MESH_REPAIR=false
```

首次部署建议保持 `ENABLE_EXTERNAL_CAM_ADAPTERS=false`，先跑通 V3 小闭环和自检。

## 3. 启动验证

```bash
npm run build
npm run api
```

另一个终端执行：

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/orchestrator/diagnostics
curl http://127.0.0.1:8787/api/orchestrator/engines
```

如果服务器已经有测试模型 `/meshy-results/material01-meshy.glb`，可执行完整 V3 小闭环 smoke test：

```bash
npm run build
npm run test:v3
npm run test:v3:small-loop-acceptance
```

如需指定模型：

```bash
V3_SMOKE_MODEL_URL=/imported-models/example.glb npm run test:v3
```

外部 adapter 上机前先跑计划产物验证：

```bash
npm run test:v3:native-cam
npm run test:v3:obj-model-import
npm run test:v3:external-adapters
npm run test:v3:neutral-adapter
npm run test:v3:neutral-import
npm run test:v3:camotics-import
```

`test:v3:native-cam` 会检查 Linux CAM 服务器上是否能由同一服务用户调用 FreeCAD、Blender/BlenderCAM、OpenCAMLib 和 CAMotics，并生成：

```text
public/native-cam-readiness/<timestamp>/
  native-cam-readiness.json
  native-cam-readiness.md
  native-cam-server-bootstrap.sh
  native-cam-env.template
  native-cam-acceptance-checklist.md
  native-cam-server-package.json
```

`native-cam-readiness.json` 的 `summary.integrationStrategy` 会同时输出开源 CAM 接入策略，说明 FreeCAD、OpenCAMLib、CAMotics、BlenderCAM/FabexCNC 在 V3 中各自负责什么、如何交接到 Orchestrator、以及哪些 fixture/synthetic/preview 结果不能作为生产证据。

同目录下的 Native CAM 服务端准备包用于迁移到 Linux 服务器：

- `native-cam-server-bootstrap.sh`：安装/探测辅助脚本，默认 `DRY_RUN=1`，只打印命令；人工复核后才可用 `DRY_RUN=0` 执行。
- `native-cam-env.template`：外部 CAM adapter 环境变量模板，默认关闭生产输出和所有 synthetic/fixture 开关。
- `native-cam-acceptance-checklist.md`：服务器安装、adapter 验证、小模型试算、CAMotics 回填和生产边界清单。
- `native-cam-server-package.json`：准备包机器可读清单，供前端或部署脚本展示。

部署 API 启动后，也可以在前端 V3 面板点击“验收Native CAM”，或直接调用：

```bash
curl http://127.0.0.1:8787/api/orchestrator/native-cam/latest
curl -X POST http://127.0.0.1:8787/api/orchestrator/native-cam \
  -H 'Content-Type: application/json' \
  -d '{"strict":false}'
```

完成 Native CAM 验收、Adapter 验证和 V3 小闭环后，可生成汇总门禁报告：

```bash
curl -X POST http://127.0.0.1:8787/api/orchestrator/readiness \
  -H 'Content-Type: application/json' \
  -d '{}'
curl http://127.0.0.1:8787/api/orchestrator/readiness/latest
```

该报告会聚合 Orchestrator 自检、Native CAM 验收、Adapter 验证和最近一次 V3 任务的 `production-gate.json`，用于判断当前部署是 `trial-only`、`blocked` 还是 `production-ready`。报告中的 `acceptancePlan` 会按顺序列出部署验收步骤、命令、证据文件和是否阻断生产，并额外生成 `v3-acceptance-runbook.sh`，可在服务器上执行验收检查。

如果只是想生成报告但不阻断部署，可以直接运行上面的命令；如果希望 CI/上线脚本在未就绪时失败，可使用：

```bash
npm run test:v3:native-cam -- --strict
```

`test:v3:external-adapters` 使用安全默认命令运行 adapter，确认四条路线都能生成计划产物，并把结果保存在：

```text
public/orchestrator-adapter-validation/<timestamp>/
  v3-external-adapter-validation.json
  v3-external-adapter-validation.md
```

当服务器已经安装 FreeCAD / Blender / OpenCAMLib / CAMotics 后，再运行 native 命令模式：

```bash
npm run test:v3:native-cam
V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters
```

native 模式会尝试 `FreeCADCmd/freecadcmd`、`blender`、Python `opencamlib/ocl`、以及 CAMotics 检测。它仍不会自动放开生产输出；实验输出必须继续受下面的 `HEDIAO3D_*` 开关保护。

`test:v3:neutral-adapter` 会启动一个独立本地 API 端口，强制运行 OpenCAMLib synthetic neutral handoff 与 CAMotics synthetic result 回填，用来验证：

- 外部 CAM adapter 可以输出 `neutral-toolpath.json`。
- HeDiao3D 可以把 neutral 刀位点后处理为 `Y轴旋转夹具` 的 `toolpath.nc`。
- CAMotics 仿真 adapter 可以回填 `camotics-result.json`。
- `simulation-summary.json`、`machining-package-index.json` 和 NC 静态分析能识别这条链路。

该测试是“协议/交接链路”验证，不代表真实 CAM 精度，也不会解锁生产 NC。

`test:v3:obj-model-import` 会验证后端 `/api/mesh/import` 能接收 `.obj`，完成基础三角化并进入 Orchestrator CAM 链路，最后输出三轴控制器 + Y 轴旋转夹具的 `wrapY` NC。该测试用于确认服务器上的后端模型导入不只支持前端预览。

`test:v3:neutral-import` 会验证 OpenCAMLib adapter 可以导入一份 `hediao3d.neutral-toolpath.v1` 的非 synthetic 中立刀路，并交给 HeDiao3D 后处理。它用于把真实 OpenCAMLib/包装脚本输出接入统一刀路链路。

`test:v3:camotics-import` 会验证 CAMotics adapter 可以导入一份 `hediao3d.camotics-result.v1` 的非 synthetic 结果，并把它回填为 `camotics-result.json`。这用于部署服务器上把真实 CAMotics/包装脚本的材料去除结果接入 HeDiao3D；它验证的是结果接入契约，不会替代真实 CAMotics 仿真本身。

诊断结果建议：

- `critical` 必须为 0。
- `warning` 可以存在，通常表示外部 CAM/CAMotics 尚未安装。
- `public/orchestrator-jobs`、`public/imported-models`、`public/meshy-results` 必须可写。
- `native-cam-readiness.json` 中 `readyCount/requiredCount` 必须逐步提升；生产部署目标是目标 CAM 模式所需项全部 ready。
- V3 总门禁中的 `externalHandoff` 应至少出现一次完成记录；它证明外部 neutral 刀位点、Y轴旋转后处理和 CAMotics 回填链路已跑通。

## 4. 外部 CAM 安装路线

### BlenderCAM / FabexCNC

适合 Meshy 佛头、艺术曲面、旋转夹具展开刀路。

部署目标：

```bash
blender --version
```

能在运行 Node API 的同一用户环境下执行。

### FreeCAD CAM

适合标准三轴、规则实体、夹具/治具类模型。

部署目标：

```bash
FreeCADCmd --version
# 或
freecadcmd --version
```

### CAMotics

用于 NC 材料去除仿真，不负责生成刀路。

部署目标：

```bash
camotics --version
# 或
camotics-cli --version
```

### OpenCAMLib

用于后续 drop-cutter、水线和刀具接触算法，是几何内核，不是完整 CAM 软件。

部署目标：

```bash
python -c "import opencamlib"
# 或
python -c "import ocl"
```

## 5. 启用外部 adapter

确认 `/api/orchestrator/diagnostics` 中外部命令和目录都正常后，再修改 `.env`：

```env
ENABLE_EXTERNAL_CAM_ADAPTERS=true
HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT=false
HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT=false
HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT=false
# 仅当外部 OpenCAMLib/包装脚本已生成真实中立刀路时设置：
# HEDIAO3D_OPENCAMLIB_NEUTRAL_JSON=/absolute/path/to/neutral-toolpath.json
HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN=false
# 仅当外部 CAMotics/包装脚本已生成真实结果时设置：
# HEDIAO3D_CAMOTICS_RESULT_JSON=/absolute/path/to/real-camotics-result.json
```

然后重启 API。启用后仍应先用小模型 dry-run，查看：

- `engine-diagnostics.json`
- `native-cam-readiness.json`
- `adapter-preflight.json`
- `adapter-report.json`
- `freecad-cam-plan.json`（FreeCAD adapter 执行时生成）
- `freecad-run-template.py`（FreeCAD adapter 执行时生成）
- `blendercam-cam-plan.json`（BlenderCAM adapter 执行时生成）
- `blendercam-run-template.py`（BlenderCAM adapter 执行时生成）
- `opencamlib-kernel-plan.json`（OpenCAMLib adapter 执行时生成）
- `opencamlib-run-template.py`（OpenCAMLib adapter 执行时生成）
- `camotics-simulation-plan.json`
- `camotics-project-template.json`
- `production-gate.json`

`HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT` 必须继续保持 `false`，直到 `freecad-cam-plan.json`、`freecad-run-template.py` 和小模型试算在目标服务器上人工验收通过。该开关打开后也只代表允许进入实验输出阶段，不代表生产门禁自动放行。

`HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT` 必须继续保持 `false`，直到 `blendercam-cam-plan.json`、`blendercam-run-template.py`、BlenderCAM/FabexCNC add-on API 和小模型试算在目标服务器上人工验收通过。

`HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT` 必须继续保持 `false`，直到 `opencamlib-kernel-plan.json`、`opencamlib-run-template.py`、中性 cutter-contact 输出和 HeDiao3D 后处理交接在目标服务器上人工验收通过。

如果部署服务器使用外部 OpenCAMLib 包装脚本生成中立刀路，可以让包装脚本输出 `hediao3d.neutral-toolpath.v1`，并在运行 adapter 时设置 `HEDIAO3D_OPENCAMLIB_NEUTRAL_JSON=/absolute/path/to/neutral-toolpath.json`。该文件必须是非 synthetic，包含非空 `points`，并至少具备 `x` 与 `z` 字段；HeDiao3D 会继续负责 Y/A 旋转夹具后处理和安全门禁。

`HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN` 也必须继续保持 `false`，直到 `camotics-simulation-plan.json`、`camotics-project-template.json`、截图/材料去除结果导出在目标服务器上人工验收通过。

如果部署服务器使用外部包装脚本运行 CAMotics，可以让包装脚本输出如下结构的真实结果，并在运行 adapter 时设置 `HEDIAO3D_CAMOTICS_RESULT_JSON=/absolute/path/to/result.json`。该文件必须满足：

- `schema` 为 `hediao3d.camotics-result.v1`。
- `status` 为 `completed`。
- `synthetic` 不能为 `true`。
- 必须包含 `summary` 和 `metrics`。

只有非 synthetic 的真实结果才可能成为 `production-gate.json` 的材料去除仿真证据；synthetic 结果只用于链路验证。

只要 `production-gate.json` 仍是 `trial-only`，就不要直接上机生产。

## 6. systemd 示例

创建 `/etc/systemd/system/hediao3d-api.service`：

```ini
[Unit]
Description=HeDiao3D V3 Orchestrator API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/HeDiao3D
EnvironmentFile=/opt/HeDiao3D/.env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3
User=hediao3d
Group=hediao3d

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hediao3d-api
sudo systemctl status hediao3d-api
```

## 7. Nginx 示例

```nginx
server {
    listen 80;
    server_name _;

    root /opt/HeDiao3D/dist;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 600s;
    }
}
```

## 8. 上线前检查清单

- [ ] `.env` 已配置，且没有提交到 Git。
- [ ] `npm run build` 成功。
- [ ] `systemctl status hediao3d-api` 正常。
- [ ] `/api/orchestrator/diagnostics` 无 critical。
- [ ] `npm run test:v3` 成功，或已使用 `V3_SMOKE_MODEL_URL` 指定服务器上的测试模型。
- [ ] `npm run test:v3:small-loop-acceptance` 成功，当前应为 20/20。
- [ ] 前端 V3 面板环境自检可见。
- [ ] 可导入 GLB/STL/OBJ。
- [ ] 可运行 V3 小闭环。
- [ ] 可下载 V3 ZIP 加工包。
- [ ] 生产 NC 只在 `production-gate.json` 明确允许后开放。

## 9. 当前边界

当前 V3 已具备 Orchestrator 架构、小闭环、产物链、门禁和部署自检；FreeCAD adapter 已能生成可审计 CAM 计划和 FreeCADCmd 运行模板，但真实 Path Job/ToolController/operation/G-code 输出仍需在服务器上继续验证。BlenderCAM adapter 已能生成可审计艺术曲面加工计划和 Blender 运行模板，但真实 BlenderCAM/FabexCNC operation/G-code 输出仍需继续验证。OpenCAMLib adapter 已能生成可审计几何内核计划和中性 cutter-contact 运行模板，但真实 drop-cutter/waterline 输出仍需继续验证。CAMotics adapter 已能生成可审计仿真计划和项目模板，但真实材料去除结果、截图和网格导出仍需继续验证。正式达到商业 CAM 精度前，需要继续实现外部 adapter 的真实刀路与材料去除仿真。
