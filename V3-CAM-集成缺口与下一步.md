# HeDiao3D V3 CAM 集成缺口与下一步

日期：2026-07-18  
分支：`HeDiao3D_V3`  
角色：后台 Agent B，CAM/仿真/后处理接入缺口审计

## 1. 审计结论

当前 V3 已经具备一条较完整的安全闭环框架：

```text
3D 模型输入
  -> Orchestrator job
  -> Mesh 体检 / 修复计划 / CAM 输入计划
  -> 外部 CAM adapter 或内置 fallback
  -> HeDiao3D wrapY 后处理
  -> NC 静态分析 / 控制器方言检查
  -> CAMotics 仿真准备包 / 结果回填
  -> 空跑 / 试雕 / 机床验收 / 生产门禁
```

但它还没有达到“下载 `.nc` 后直接上机雕刻成品”的阶段。核心原因不是前端按钮不够，而是当前真实生产证据链还没有闭合：

1. 外部 CAM 生产候选刀路还没有稳定输出。
2. OpenCAMLib 当前主线仍偏 `heightfield preview scaffold`，不是最终 drop-cutter / cutter-contact / waterline。
3. CAMotics 在当前 Linux 环境还没有形成稳定真实材料去除结果。
4. 三轴控制器 + Y 旋转夹具的后处理需要实机参数和现场验收数据绑定。
5. 4mm 25 度平底尖刀的真实刀具几何、刀尖平底、侧刃干涉和材料去除误差还需要用试雕闭环校正。

所以当前正确定位应是：

```text
可用于：任务链路验证、安全试雕包、离料空跑、软料试雕准备、证据审查。
不可宣称：成熟 CAM 精加工精度、正式生产 NC 一键可用。
```

## 2. 当前已具备的关键基础

从 `server.mjs`、`package.json`、`scripts/` 和现有文档审计，V3 已完成以下工程底座：

| 模块 | 当前能力 | 审计判断 |
| --- | --- | --- |
| Orchestrator | job 队列、文件缓存、产物清单、加工包、生产门禁 | 架构正确，可继续承载长耗时 CAM/仿真任务 |
| 外部 CAM adapter | FreeCAD、BlenderCAM、OpenCAMLib、CAMotics adapter slot 与协议测试 | 接口边界清晰，但多数仍是 skeleton/proof/preview 状态 |
| 中立刀路 | `hediao3d.neutral-toolpath.v1`，可进入 wrapY 后处理 | 适合作为外部几何内核和本项目后处理之间的稳定契约 |
| 后处理 | `desktop-3axis-rotary-y` / `wrapY`，输出 X/Y/Z，不输出 A 轴 | 符合用户设备形态：X 长度、Y 旋转夹具、Z 刀深 |
| 安全文件 | `air-run.nc`、`rotary-calibration-airrun.nc`、`production-gate.json`、`machine-controller-profile.json` | 安全门设计合理，继续保持 fail-closed |
| CAMotics 链路 | 准备包、结果模板、哈希绑定、结果 ZIP 回填、材料去除验收器 | 协议完整，缺真实稳定执行环境和真实结果样本 |
| 现场证据 | trial feedback、machine acceptance、rotary calibration、air-run evidence | 表单和门禁已存在，缺真实机床回填数据 |

## 3. 离可直接上机还缺哪些核心环节

### P0-1 真实生产候选 CAM 输出

当前缺口：

- FreeCAD/BlenderCAM 的生产候选输出仍依赖外部 runner 和 `cam-proof`，还没有形成稳定真实刀路。
- OpenCAMLib 已能做旋转 heightfield 预览和 neutral handoff，但明确标记为 preview scaffold。
- 内置 Mesh CAM fallback 只能验证流程，不能承担复杂佛头曲面的生产精度。

必须补齐：

- 至少一个外部引擎输出非 fixture、非 synthetic、非 preview 的真实 candidate。
- 输出必须绑定：
  - 原始模型哈希；
  - CAM plan 哈希；
  - neutral/toolpath 哈希；
  - contact report 或 cam proof；
  - 目标机床 profile；
  - 目标刀具 profile。

验收标准：

```text
handoffEvidence.classification = production-candidate
quality.productionCandidate = true
quality.postprocessEligible = true
fixture/synthetic/previewScaffold = false
model/plan/output hash 全部匹配
```

### P0-2 OpenCAMLib 从预览采样升级为真实刀具接触

当前缺口：

- `heightfield preview` 能按 X + 旋转角采样模型外表面，但它不是成熟 CAM 的 drop-cutter。
- 采样质量报告已经暴露 `coarse`、`stepToCutterRatio` 等问题，说明它只能做可视化和空跑参考。
- 4mm 25 度平底尖刀目前只有预览包络，不等于真实刀补。

必须补齐：

- 真实 drop-cutter / cutter-contact 计算。
- waterline 或等高线策略，用于陡峭区域和细节区。
- 粗加工、精加工、清残分层策略。
- 刀具扫掠体与模型误差热力图。
- 端部夹持区、过渡区、不可达区自动避让。

验收标准：

```text
contact report 非 preview
hitRate 达标
stepToCutterRatio 达标
欠切/过切/残料指标可量化
清残区域可解释
同一模型重复生成结果稳定
```

当前已固化的候选门槛：

```text
npm run test:v3:opencamlib-contact-validate
```

Native CAM 真实输出回填已经与该门槛绑定：`native-cam-real-output-bundle.zip` 可随包携带 `opencamlib-contact-output-validation.json`，导入端会生成 `contactValidationStatus`；OpenCAMLib production-candidate 若缺少 ready strict contact 验证，会被降级为 critical，不能作为生产证据。

该验证器现在要求真实 OpenCAMLib contact report 同时满足：

- `contactSampling.algorithm` 属于 `drop-cutter` / `cutter-contact` / `waterline`，且不含 `preview` / `heightfield` / `scaffold`。
- `tool.diameterMm`、`tool.angleDeg`、`tool.flatTipMm` 完整绑定当前 4mm 25度平底尖刀。
- `contactSampling.hitRate >= 0.995`。
- `contactSampling.stepToCutterRatio <= 0.25`。
- `residualMaterial.maxGougeMm <= tolerances.maxGougeMm`，默认 0.03mm。
- `residualMaterial.maxUndercutMm <= tolerances.maxUndercutMm`，默认 0.08mm。

这一步不是完成真实 CAM，而是防止后续 runner 只写 `productionCandidate=true` 就绕过门禁。

### P0-3 真实材料去除仿真

当前缺口：

- CAMotics 准备包和回填协议已经具备，但当前 Linux 服务器上的 CAMotics 运行环境不稳定。
- 自研旋转包裹预览能辅助看方向和覆盖，不等同真实材料去除仿真。
- 没有一组“真实 NC -> 仿真截图/STL -> 回填 -> 门禁刷新”的固定佛头样件基准。

必须补齐：

- 可重复运行的 CAMotics 或替代仿真环境，建议优先容器化或固定 Ubuntu 版本。
- 回填真实 `camotics-result-bundle.zip`，包含截图、剩余材料 STL 或等效几何证据。
- 对比原模型、目标刀路、材料去除结果，输出过切/欠切指标。

验收标准：

```text
synthetic = false
inputIdentity = matched
cliRunPackage = matched
motionConsistency = matched
machineContext = matched
materialRemoval = verified
```

### P0-4 三轴控制器 + Y 旋转夹具实机后处理验收

当前缺口：

- 代码已支持 wrapY 输出，但真实机器的 Y 行程到旋转角换算、方向、反向间隙、限位和控制器方言还需要实测。
- 只有通用 profile 不能证明用户家里的具体机器可直接执行。

必须补齐实机参数：

| 参数 | 必填原因 |
| --- | --- |
| `rotaryWrapPerRevolutionMm` | Y 轴移动多少 mm 对应夹具旋转 360 度 |
| Y 轴正方向 | 判断图案是否左右/前后反向 |
| 90/180/360 度实测误差 | 判断圆周展开比例是否正确 |
| Y 轴反向间隙 | 判断换向策略和补偿 |
| X 有效行程 | 防止长度方向撞限位或进夹持区 |
| Z 安全高度和最大下刀深度 | 防止撞料、撞夹具、断刀 |
| 主轴启停指令 | 确认 M3/M5/S 是否被控制器识别 |
| 支持/禁用 G/M 指令 | 防止 G2/G3/G43/M6 等控制器不支持指令混入 |
| 夹持区长度 | 两端不可雕刻区必须在 CAM 中硬约束 |
| 刀具有效伸出 | 判断刀柄/夹头干涉风险 |

必须补齐现场验收证据：

- `rotary-calibration-airrun.nc` 离料空跑视频或记录。
- 整条 `air-run.nc` 离料空跑记录。
- 软料试雕照片和问题标注。
- 真实核胚小深度试雕反馈。
- 下载包 SHA-256 与现场运行文件一致性。
- 机床验收记录绑定当前 job/package。

### P0-5 生产包门禁继续保持锁定

当前项目已经做对的一点是：正式生产包接口在证据不足时保持 423/锁定。

建议继续坚持：

```text
没有真实 CAM candidate -> 不解锁生产 NC
没有真实材料去除仿真 -> 不解锁生产 NC
没有空跑/试雕/机床验收 -> 不解锁生产 NC
哈希不绑定同一 job/package -> 不解锁生产 NC
```

## 4. FreeCAD / BlenderCAM / OpenCAMLib / CAMotics 分工建议

### 4.1 FreeCAD CAM

适合承担：

- 规则实体、简单三轴浮雕、夹具/治具、标准 G-code 参考。
- 做一条保守、可审查的三轴参考 CAM 路线。
- 输出 CAM plan、tool controller、operation、postprocessor proof。

不适合单独承担：

- 佛头复杂艺术曲面的全部精加工。
- 三轴控制器 + Y 旋转夹具最终后处理。

建议定位：

```text
P0/P1 辅助引擎：规则几何和通用 CAM 参考。
```

下一步：

- 解决 Linux 侧 FreeCAD Path/CAM 可脚本化环境，优先避免 snap PySide/Qt 冲突。
- 跑通一个真实 STL -> FreeCAD Path Job -> G-code -> cam-proof -> HeDiao3D 摄取的小样件。

### 4.2 BlenderCAM / FabexCNC

适合承担：

- 艺术 Mesh、人物/佛头曲面、浮雕类路径试算。
- 与 Blender 修模、Remesh、姿态校准流程衔接。

不适合单独承担：

- 稳定工业级后处理和安全门禁。
- 未验证插件版本时作为 P0 生产路径。

建议定位：

```text
P1 艺术曲面 CAM 备选。
```

下一步：

- 在 Linux 服务器安装并固定 BlenderCAM/FabexCNC 插件版本。
- 先只要求输出可审查 G-code 和 cam-proof，不直接解锁生产。

### 4.3 OpenCAMLib

适合承担：

- 核心几何内核。
- drop-cutter、cutter-contact、水线、清残区域分析。
- 输出中立刀位点，由 HeDiao3D 统一后处理成 wrapY。

不适合单独承担：

- 完整 CAM 产品体验。
- 机床 profile、加工包、安全门禁、现场验收。

建议定位：

```text
P0 主攻方向：把当前 preview scaffold 升级为真实 cutter-contact neutral toolpath。
```

下一步：

- 保留 `hediao3d.neutral-toolpath.v1` 作为主契约。
- 将 `heightfield preview` 替换为真实 OpenCAMLib drop-cutter/contact 输出。
- 对 4mm 25 度平底尖刀建立真实几何模型和接触报告。

### 4.4 CAMotics

适合承担：

- G-code 材料去除仿真。
- 上机前确认 Z 深度、边界、空跑、异常突跳。
- 生成截图、剩余材料网格、仿真报告，回填生产证据。

不适合承担：

- 生成刀路。
- 替代真实试雕。
- 直接理解三轴控制器 + Y 旋转夹具的全部物理行为。

建议定位：

```text
P0 仿真证据入口：真实材料去除结果必须进入 production-evidence-dossier。
```

下一步：

- 优先用容器或兼容系统解决 CAMotics 依赖问题。
- 若 CAMotics 在 Ubuntu 24.04 继续不稳定，保留现有 schema，替换为其他材料去除仿真器或自研后端体素仿真。

## 5. 三轴控制器 + Y 旋转夹具的 NC 后处理要求

目标设备逻辑：

```text
X = 核雕长度方向
Y = 旋转夹具等效展开行程
Z = 刀深 / 安全高度
```

这种设备看起来像四轴，但控制器层面更接近：

```text
三轴控制器 + 旋转夹具把 Y 线性位移转换成角度
```

因此最终 NC 不应默认输出 `A` 轴，而应输出：

```gcode
G1 X... Y... Z...
```

其中：

```text
Y = 旋转角度 / 360 * rotaryWrapPerRevolutionMm
```

后处理必须具备：

1. `ROTARY_WRAP_AXIS=Y`、`ROTARY_WRAP_PER_REV_MM`、`LENGTH_AXIS=X` 头部标识。
2. 禁止混入真实 A 轴字，除非切换到真实四轴 profile。
3. 限制 X/Y/Z 范围。
4. 检查 Y 轴突跳和换向。
5. 支持往复行排序，减少空走和突然回跳。
6. 夹持区和端部保护区硬约束。
7. `toolpath.nc`、`air-run.nc`、`rotary-calibration-airrun.nc` 分用途导出。
8. 生产前绑定 `machine-controller-profile.json`、`postprocess-profile.json` 和 `postprocess-trace-report.json`。

## 6. 建议下一步任务拆分

### Agent A：前端/操作流

目标：

- 只保留试雕主线。
- 弱化或隐藏会误导为生产可用的按钮。
- 将“生成安全试雕数据、下载安全试雕包、生成 CAMotics 仿真包、回填仿真结果、回填机床验收”做成顺序步骤。

### Agent B：CAM/仿真/后处理文档与验收清单

目标：

- 维护本文件。
- 将 P0 缺口拆成可执行验收清单。
- 明确哪些证据进入生产门禁。

### Agent C：测试/证据门禁

目标：

- 补充 production gate 不变量测试。
- 确保 fixture/synthetic/preview scaffold 永不解锁生产。
- 增加真实 CAM candidate 缺失时的 fail-closed 回归。

### 主 Agent：架构合并与真实引擎推进

目标：

- 统一外部 CAM 输出契约。
- 在 Linux 上优先推进 OpenCAMLib 真实 cutter-contact。
- 解决或替换 CAMotics 真实材料去除仿真。
- 把实机标定和试雕回填作为生产解锁前置项。

## 7. 推荐 P0 路线图

### 第一步：固定样件和机床 profile

- 已选定一个佛头 STL/GLB 作为 V3 回归样件：
  - `public/v3-fixtures/buddha-baseline.json`
  - `/meshy-results/019f6a05-c78b-7c70-b07f-ea857a54bea5.glb`
  - `/meshy-results/019f6a05-c78b-7c70-b07f-ea857a54bea5.stl`
  - 校验：`npm run test:v3:buddha-fixture`
- 固化用户机床 profile：
  - `desktop-3axis-rotary-y`
  - 4mm 25 度平底尖刀
  - X 长度、Y 旋转夹具、Z 刀深
  - 实测 `rotaryWrapPerRevolutionMm`

### 第二步：OpenCAMLib 真实 contact 输出

- 从 STL/OBJ 输入开始，暂时不要把 GLB 转换复杂性放进 P0。
- 输出非 preview neutral toolpath。
- 输出 hash-bound cutter contact report。
- contact report 必须通过 `npm run test:v3:opencamlib-contact-validate` 的真实算法、刀具、采样和残料指标门槛。
- 进入 HeDiao3D wrapY 后处理。

### 第三步：真实仿真结果回填

- 用 CAMotics 容器或替代仿真器跑 `camotics-preview.nc`。
- 回填真实 `camotics-result-bundle.zip`。
- 让 `production-evidence-dossier.json` 显示材料去除证据 matched。

### 第四步：离料空跑和软料试雕

- 先运行 `rotary-calibration-airrun.nc`。
- 再运行整条 `air-run.nc`。
- 软料试雕，上传照片和反馈。
- 记录 Y 旋转误差、反向间隙、深度偏差。

### 第五步：生产门禁只对同包证据放行

- 只有同一个 job/package 的 CAM、仿真、空跑、试雕、机床验收哈希全部一致，才允许生产包下载。

## 8. 可以暂时不做或降级的功能

为了加快工程进度，以下功能可以暂时降级：

| 功能 | 建议 |
| --- | --- |
| 多 Provider AI 3D 对比 | 暂缓，保留 Meshy + 原始模型导入 |
| 复杂权限/客户管理 | 暂缓 |
| 多控制器方言 | 先只做用户当前三轴控制器 + Y 旋转夹具 |
| 正式生产包 UI | 继续锁定或隐藏，避免误点 |
| 老版浮雕/热力图生产下载 | 保留工程入口，不作为主流程 |
| BlenderCAM 真实输出 | P1，等 OpenCAMLib/CAMotics 主链路稳定后再推进 |

## 9. 最终判断

HeDiao3D V3 当前最有价值的工程资产不是“已经能直接雕”，而是已经建立了正确的安全架构：

```text
任何刀路都必须被证明来源真实、仿真真实、机床匹配、现场验收匹配，才能进入生产下载。
```

下一阶段最短路径不是继续堆功能，而是集中打通：

```text
佛头 STL/OBJ
  -> OpenCAMLib 真实 cutter-contact neutral
  -> HeDiao3D wrapY 后处理
  -> CAMotics/等效材料去除仿真
  -> 离料空跑
  -> 软料试雕
  -> 机床验收
```

这条链路打通后，项目才可以从“安全试雕准备系统”进入“可控上机试雕系统”。距离“成熟 CAM 软件级别的一键生产”，仍需要多轮实机误差补偿和工艺模板沉淀。
