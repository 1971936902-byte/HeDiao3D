# HeDiao3D V3 新服务器 CAM 环境实测记录

记录时间：2026-07-22

## 服务器

- 系统：Ubuntu 22.04.3 LTS
- 项目目录：`/opt/hediao3d`
- Git 分支：`HeDiao3D_V3`
- 当前同步提交：`114b231 relax opencamlib readiness boundary assertion`
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
