# HeDiao3D V3 新服务器 CAM 环境实测记录

记录时间：2026-07-22

## 服务器

- 系统：Ubuntu 22.04.3 LTS
- 项目目录：`/opt/hediao3d`
- Git 分支：`HeDiao3D_V3`
- 当前同步提交：以 `git log -1 --oneline` 为准
- 目标机床：三轴控制器 + Y 轴旋转夹具
- 目标轴映射：`X=长度方向，Y=旋转夹具，Z=刀深/安全高度`
- 目标刀具：`4mm 25度平底尖刀`

## 已安装/确认

### Node.js

- Node.js：`v20.20.2`
- npm：`10.8.2`

### FreeCAD

- 已安装 Ubuntu apt 包：
  - `freecad`
  - `freecad-python3`
- Native CAM 总检查已把 FreeCAD 计入 ready 能力。

### Blender / FabexCNC

- 已安装 Ubuntu apt 包：`blender`
- 版本探测：`Blender 3.0.1`
- 已从 FabexCNC/BlenderCAM GitHub release 安装 `fabexcnc.zip`
- Blender 后台探测结果：`CAM_ADDON_OK`

### OpenCAMLib

- 已通过 pip 安装：`opencamlib`
- Python import：
  - `opencamlib`：可导入
  - `opencamlib.ocl`：项目探测选择该模块
- 实测结论：OpenCAMLib runtime probe、contact spike、runner readiness 均已到 ready 分支。

### CAMotics

- 已安装预依赖：
  - `gdebi-core`
  - `libqt5websockets5`
  - `libqt5websockets5-dev`
- 已从 CAMotics GitHub release 安装 `camotics_1.2.0_amd64.deb`
- 已补 Ubuntu 22.04 兼容依赖：
  - `libv8.so.3.14.5` 兼容链接
  - `libssl1.1`
- 命令探测：`camotics --version` 返回 `1.2`

## 服务器实测命令与结果

### Native CAM 总检查

```bash
npm run test:v3:native-cam
```

旧结果：

```text
level=partial
ready=2/4
ready: FreeCAD, OpenCAMLib
blocked: BlenderCAM/FabexCNC 插件缺失, CAMotics 缺失
```

最新结果：

```text
ok=true
level=ready
ready=4/4
blockers=[]
```

### 佛头 Linux CAM 整单回填实测

时间：2026-07-22 17:17

样件：

```text
jobId=970989c4-c357-4360-94e8-931fa3e55bab
model=/meshy-results/019f6a05-c78b-7c70-b07f-ea857a54bea5.stl
toolpathPoints=8979
packageLevel=trial-only
allowAirRun=true
allowTrialNc=true
allowProductionNc=false
```

执行：

```bash
npm run test:v3:native-cam
curl -fsS http://127.0.0.1/api/orchestrator/jobs/970989c4-c357-4360-94e8-931fa3e55bab/linux-cam-job-package -o linux-cam-job-package.zip
HEDIAO3D_NATIVE_CAM_SERVER_DIR=/opt/hediao3d/public/native-cam-readiness/2026-07-22T09-12-40-919Z bash run-linux-cam-job.sh
HEDIAO3D_V3_API_BASE=http://127.0.0.1 node upload-linux-cam-evidence.mjs .
curl -fsS -X POST http://127.0.0.1/api/orchestrator/readiness
```

结果：

```text
linux-cam-job-local-validation.level=ready-for-v3-upload
native-cam-real-output-bundle.zip=已生成并上传
camotics-result-bundle.zip=已生成并上传
readiness.level=blocked
readiness.safeTrialReadiness.status=safe-trial-ready
productionAllowed=false
```

OpenCAMLib 真实候选差距审查已进入 readiness：

```text
productionGapReview.level=blocked
criticalCount=3
productionBlockerCount=1
gapCount=4
topGaps:
- strict-contact-validation-not-ready: Strict cutter-contact validation is critical.
- experimental-real-api: OpenCAMLib output is still experimental engineering evidence, not a production candidate.
- production-residual-not-closed: Residual/gouge evidence is not closed for production use.
- hediao3d-import-contract-not-ready: OpenCAMLib real API output is experimental and lacks production residual/material-removal/machine evidence.
```

2026-07-22 后续增强：

```text
strict contact 失败明细已贯穿：
- opencamlib-candidate-package-validation.json: contactValidation.topErrors / failedChecks
- opencamlib-production-gap-review.json: strict-contact-validation-not-ready evidence 含失败 check id
- native-cam-real-output-acceptance.json: contactValidation.topErrors / failedChecks
- readiness API / 前端: 显示“严格接触失败”的首要错误和失败 check

验证命令：
- npm run test:v3:opencamlib-candidate-package
- npm run test:v3:native-cam-real-output-import-api
- npm run test:v3:readiness-api
- npm run test:v3:focused-ui
- npm run build -- --emptyOutDir false（Windows 本地 dist 运行产物可能占用，Linux 部署使用正常 npm run build）
```

2026-07-22 残料/过切闭环诊断增强：

```text
residualClosureReview 新增：
- checks: camotics-real-material-removal / upstream-cam-evidence-bound / material-removal-ready-for-simulation / production-residual-evidence
- topBlockers: 首要残料/过切阻断原因
- nextActions: 下一步补证据动作

当前生产边界不变：
- CAMotics 真实材料去除通过后，可作为安全试雕/生产证据链的一项
- 若 OpenCAMLib 残料/过切仍只是工程估算，productionResidualEvidenceReady=false
- 正式生产 NC 仍需测量或 swept-volume/material-removal validated 残料证据、空跑、试雕和机床验收

验证命令：
- npm run test:v3:camotics-result-api
- npm run test:v3:focused-ui
- npm run build -- --emptyOutDir false（Windows 本地）
```

结论：Linux 小闭环从整单包下载、服务器执行、Native CAM/CAMotics 证据上传、readiness 复核已经跑通；当前阻断点明确集中在 OpenCAMLib 真实 cutter-contact 生产候选证据、残料/过切闭合和现场验收，不能解锁生产 NC。

### OpenCAMLib runtime probe

```bash
npm run test:v3:opencamlib-probe
```

结果：

```text
ok=true
level=ready
selectedModule=opencamlib.ocl
dropCutterReady=true
```

### OpenCAMLib contact spike

```bash
npm run test:v3:opencamlib-contact-spike
```

结果：

```text
ok=true
spikeOk=true
level=ready
selectedModule=opencamlib.ocl
checks=8
```

### OpenCAMLib runner contract

```bash
npm run test:v3:opencamlib-runner
```

结果：

```text
ok=true
readinessLevel=ready-for-real-contact-runner
failClosedExit=4
```

说明：服务器具备真实 OpenCAMLib runner 预检能力，但输出仍保持生产锁定；不能仅凭该 runner readiness 解锁正式生产 NC。

### OpenCAMLib 小闭环

```bash
npm run test:v3:opencamlib-small-loop
```

结果：

```text
ok=true
selectedEngine=opencamlib
resultEngine=opencamlib
neutralPoints=48
source=external-adapter
simulationEvidence=material-removal-incomplete
production=false
trial=false
airRun=true
packageLevel=blocked
```

说明：该测试证明 OpenCAMLib 外部 adapter 链路能进 HeDiao3D 后处理和安全包，但仍是小样件/工程闭环，不是佛头生产级刀路。

### 固定佛头样件

已将本地固定佛头样件同步到服务器：

```text
/opt/hediao3d/public/meshy-results/019f6a05-c78b-7c70-b07f-ea857a54bea5.glb
/opt/hediao3d/public/meshy-results/019f6a05-c78b-7c70-b07f-ea857a54bea5.stl
```

验证：

```bash
npm run test:v3:buddha-fixture
npm run test:v3:buddha-e2e
```

结果：

```text
buddha-fixture: ok=true, triangles=451536
buddha-e2e: ok=true, points=8979, machineAxes X/Y/Z present, A=0, rotaryCoverage=1, postprocessFitRate=1, trialPackageFiles=37, productionAllowed=false
```

## 当前结论

新服务器已经具备继续推进 V3 P0 主线的基础：

- 固定佛头模型可在服务器完成 V3 E2E 安全试雕包生成。
- OpenCAMLib Python 绑定已可用，并通过 runtime probe/contact spike/runner readiness。
- 三轴控制器 + Y 旋转夹具后处理契约仍保持正确，未输出 A 轴。

仍未达到正式生产：

- OpenCAMLib 佛头真实 production-candidate 刀位点尚未生成并通过 strict contact/candidate package 验收。
- CAMotics 或等效材料去除仿真工具已安装，但尚未对同一个佛头 job 完成真实材料去除结果回填与哈希绑定。
- Blender/FabexCNC 已安装并通过 addon 探测，但尚未对佛头 job 生成可纳入生产证据链的真实输出。
- 真实机床空跑、旋转标定、软料试雕、机床验收仍未回填。

下一步优先：

1. 用固定佛头 STL 生成 OpenCAMLib real-candidate 输入包。
2. 在服务器运行 `opencamlib-real-candidate-run.mjs`，产出真实候选 neutral/contact/candidate package。
3. 继续解决 CAMotics 安装或接入等效材料去除仿真器。
4. 将真实 CAM 与材料去除证据回填同一个 V3 job。

## 2026-07-22 15:05 佛头 Linux CAM 整单复测

本次服务器提交：

```text
e302072 stream opencamlib candidate point stats
```

复测命令链路：

```bash
npm run test:v3:native-cam
curl /api/orchestrator/jobs/970989c4-c357-4360-94e8-931fa3e55bab/linux-cam-job-package
bash run-linux-cam-job.sh
node validate-linux-cam-job.mjs .
POST /api/orchestrator/jobs/970989c4-c357-4360-94e8-931fa3e55bab/linux-cam-evidence-bundle
```

关键结果：

```text
Native CAM readiness: ok=true, level=ready, ready=4/4
Linux CAM preflight: level=ready, required=12/12
native-cam-real-output-bundle.zip: generated, 76KB
neutral-toolpath points: 1,487,639
machineFit.level: ok
machineFit.depthMax: 0.6096mm
machineFit.rotaryCoverageRatio: 0.9944444444
targetMachineBoundary: matched
```

已修复的问题：

```text
1. native-cam-real-output-check.sh 不再强依赖 FreeCAD proof 测试通过，OpenCAMLib real-candidate 成为佛头整单的主证据链。
2. critical acceptance 也会生成 native-cam-real-output-bundle.zip，便于回填和审计，不再只留下中断日志。
3. OpenCAMLib candidate package 对 148 万级刀位点改为流式统计，避免 Math.min(...points) / Math.max(...points) 导致 Maximum call stack size exceeded。
4. Native CAM 真实输出包会复制到 Native CAM 根目录，Linux 整单包可以稳定回收。
```

当前仍保持阻断：

```text
native acceptance level: critical
contactValidation.level: critical
contactValidation.pathCoverage: ready
candidatePackage.level: critical
candidatePackage.blockedReason: OpenCAMLib real API output is experimental and lacks production residual/material-removal/machine evidence.
camotics-result-bundle.zip: missing
productionAllowed: false
```

解释：这次已经证明佛头 OpenCAMLib 大规模刀位点可生成、可校验、机床边界匹配，且不再因为脚本错误中断。但它仍只是工程证据，不是可直接上机生产的 NC。下一步必须补同一 job 的材料去除仿真或等效残余验证，再进入离料空跑和软料试雕。

## 2026-07-22 15:30 材料去除仿真证据回填

本次服务器提交：

```text
b05bb47 bind linux material simulation to job id
```

新增能力：

```text
1. CAMotics Linux helper 在无 camotics-cli 时，可自动运行 HeDiao3D internal swept-envelope material-removal simulator。
2. 该仿真器读取 hash-bound camotics-preview.nc，按 G0/G1 运动、Z 深度、刀具直径估算扫掠体积。
3. 自动生成 camotics-result.json、camotics-material-removal.stl、camotics-result-local-validation.json 和 camotics-result-bundle.zip。
4. Linux 整单 run 脚本会从原 job 目录或临时 run 目录回收 CAMotics/等效仿真结果包。
5. 结果写入 HEDIAO3D_JOB_ID，避免回填后出现 jobIdentity 缺失。
```

佛头 job 复测：

```text
jobId=970989c4-c357-4360-94e8-931fa3e55bab
native-cam-real-output-bundle.zip=generated
camotics-result-bundle.zip=generated
linux-cam-job-local-validation.level=ready-for-v3-upload
upload-linux-cam-evidence uploaded:
  - linux-cam-job-preflight
  - linux-cam-job-validation
  - native-cam-real-output
  - camotics-result
  - linux-cam-evidence-upload-report
```

材料去除仿真结果：

```text
engine=equivalent-material-removal-simulator
simulator=HeDiao3D internal swept-envelope material-removal simulator
synthetic=false
riskLevel=ready
motionLineCount=8983
zMin=-1.25
zMax=2.25
materialRemovedMm3=29422.530843
sweptDistanceMm=2679.2222
cutMoveCount=8978
maxCutDepthMm=3.5
```

Orchestrator 回填后：

```text
simulationEvidence.level=material-removal-verified
realMaterialRemovalVerified=true
material-removal-simulation evidenceItem=pass
residualClosureReview=工程复核，不单独解锁生产 NC
productionGate.level=trial-only
productionAllowed=false
```

仍保持阻断：

```text
native-cam-real-output-snapshot=block
原因：OpenCAMLib contactValidation.level=critical，仍为 experimental-real-api，残余材料证据还不是 production-candidate。
```

结论：仿真层已经完成“可生成、可校验、可回填”的基本闭环。下一步不应继续扩展普通 UI 功能，而应集中把 OpenCAMLib residual/contact 证据从 engineering estimate 提升到 measured-or-validated，并继续做离料空跑、软料试雕和机床验收。

## 2026-07-22 15:58 新服务器重装/重配验证

本次服务器状态：

```text
系统: Ubuntu 22.04.3 LTS
项目路径: /opt/hediao3d
分支: HeDiao3D_V3
Node.js: v20.20.2
npm: 10.8.2
OpenCAMLib: opencamlib.ocl import OK
CAMotics: 1.2
服务: hediao3d-api / nginx / hediao3d-cloudflared 均 active
公网隧道: trycloudflare 临时地址已验证 /api/health 返回 ok
```

本轮新增后端证据字段：

```text
simulationEvidence.residualClosureReview.schema=hediao3d.residual-closure-review.v1
用途: 区分“材料去除仿真已闭环”和“OpenCAMLib 残料/过切生产证据是否已闭合”
生产边界: residualClosureReview 为 review 证据，不绕过 Native CAM、空跑、试雕和机床验收门禁
```

本轮验证：

```text
node --check server.mjs
node --check scripts/v3-camotics-result-api-test.mjs
npm run test:v3:camotics-material-validate
npm run test:v3:camotics-result-api
npm run test:v3:opencamlib-contact-validate
npm run test:v3:opencamlib-candidate-package
npm run test:v3:native-cam-package-self-check
```
