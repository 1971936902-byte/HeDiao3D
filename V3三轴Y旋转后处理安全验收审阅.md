# V3 三轴控制器 + Y轴旋转夹具后处理安全验收审阅

审阅日期：2026-07-18

## 结论

当前 V3 小闭环已经明确支持“三轴控制器 + Y轴旋转夹具”的专用后处理：

- X = 工件长度方向。
- Y = 旋转夹具的线性化展开坐标，按 `rotaryWrapPerRevolutionMm` 把 360 度换算成 Y 轴行程。
- Z = 刀深/安全高度。
- 目标刀具为 `vflat-4mm-25deg`，即 4mm 25 度平底尖刀。

现有安全策略保持 fail-closed：内置 Mesh CAM、小闭环仿真、空跑和试雕证据可以支持试雕流程，但不能单独解锁生产包。生产包仍要求同一加工包内的真实 CAM 输出、真实材料去除仿真、NC 静态分析、后处理追溯、控制器方言检查、离料空跑、旋转标定、试雕反馈和机床现场验收全部闭环。

## 已确认的实现证据

### 机床画像与默认映射

`src/manufacturingProfiles.ts` 中 `desktop-3axis-rotary-y` 已定义为三轴机床，说明为：

- X 走核雕长度。
- Z 控制刀深。
- Y 轴线性位移映射夹具旋转。

`applyMachineProfile()` 对该机型会自动设置：

- `camMode = rotaryWrap`
- `rotaryOutputAxis = Y`
- `postProcessor = wrapY`

### 后处理输出

`server.mjs` 的 `toRotaryWrapGcode()` 会生成旋转包裹 NC：

- 头部写入 `ROTARY_WRAP_AXIS=Y`、`ROTARY_WRAP_PER_REV_MM=...`、`LENGTH_AXIS=X`。
- 切削点输出为 `X/Y/Z`。
- Y 值由角度 `Adeg / 360 * rotaryWrapPerRevolutionMm` 换算得到。
- `wrapY` 模式下不输出 A 轴。

### 空跑与旋转标定

`server.mjs` 生成三类关键 NC：

- `toolpath.nc`：机床候选刀路。
- `air-run.nc`：离料空跑，主轴关闭，切削 Z 替换为安全高度。
- `rotary-calibration-airrun.nc`：旋转夹具 90/180/270/360 度标定空跑，主轴关闭，Z 恒定安全高度。

`nc-static-analysis.json` 会检查：

- 机床 NC 是否含旋转包裹头。
- Y 旋转模式是否有 Y 运动。
- 空跑文件是否含 `AIR RUN ONLY` 标记。
- 空跑是否误启主轴。
- 空跑最低 Z 是否低于 `safeZ`。

`controller-dialect-report.json` 会按保守三轴控制器方言检查：

- 只允许基础 `G0/G1/G21/G90/G94/M3/M5/M30`。
- `wrapY` 机床禁止 A 字地址。
- 空跑文件禁止 M3/M03。

### 后处理追溯

`postprocess-trace-report.json` 会逐点比对源刀路点与 `toolpath.nc` 的机床输出：

- 长度轴偏差阈值：0.01mm。
- 旋转线性化轴偏差阈值：0.01mm。
- Z 偏差阈值：0.01mm。
- 回算旋转角偏差阈值：0.05deg。
- 源点数量与机床切削运动数量必须一致。

### 生产门控

`production-gate.json` 当前不会因为后处理测试通过就放行生产。它还要求：

- Mesh/CAM 输入达到生产条件。
- 外部 CAM adapter 就绪且不是内置 fallback。
- 真实材料去除仿真证据满足生产解锁。
- NC 静态分析 ready。
- 后处理追溯 ready。
- 控制器方言 ready。
- 后续还需同包哈希绑定的试雕反馈与机床验收。

`machine-acceptance` API 会要求：

- `toolpath.nc`、`air-run.nc`、`rotary-calibration-airrun.nc` 的 SHA-256 与当前 `package-integrity.json` 匹配。
- 操作员确认仿真/报告类文件不可上机。
- 旋转标定实测包含方向、90/180/360 度和反向间隙。
- 必需步骤全部通过后，才把现场验收作为生产证据。

## 已运行测试

### `npm run test:v3:postprocess`

结果：通过。

关键输出：

- `nc-static-analysis`：ready。
- `controller-dialect-report`：ready。
- `postprocess-trace-report`：ready。
- `machineControllerProfile`：`desktop-3axis-rotary-y`。
- `toolpath.nc` 轴计数：X/Y/Z 均有运动，A 为 0。
- `air-run.nc` Z 范围：22mm 到 22mm。
- `rotary-calibration-airrun.nc` Z 范围：22mm 到 22mm。

### `npm run test:v3:machine-acceptance-api`

结果：通过。

关键输出：

- 先提交错误哈希会被拒绝。
- 再提交匹配哈希、旋转标定、空跑和软料试雕证据后通过。
- 必需步骤 6 项，全部通过。

## 主要风险

### 1. 后端 Orchestrator 已新增制造参数综合校验

前端 `validateManufacturingSetup()` 会同时考虑刀具、材料和机床，例如橄榄核材料上限、刀具推荐进给、机床最大进给等。后端现在已新增 `manufacturing-setup-report.json`，把刀具、材料、机床、进给、转速、切深、步距、Y 旋转夹具边界统一纳入 Orchestrator 证据链。

当前行为：

- 橄榄核 + 4mm 25度平底尖刀超过材料保守切深时进入 review。
- 明显危险切深、未知刀具/材料/机床、Y 旋转夹具边界不匹配会进入 critical。
- critical 项进入 `production-gate.json` blockers，同时在 `production-unlock-matrix.json` 和 `production-evidence-dossier.json` 中可审计。
- 当前 `npm run test:v3:manufacturing-setup` 与 `npm run test:v3:small-loop-acceptance` 已覆盖 review 与 critical 两类场景。

仍需注意：

- 该报告是参数安全门，不等于真实 CAM 精度证明。
- review 项不会单独阻断试雕包，但生产包仍需要真实 CAM、材料去除仿真、空跑、试雕和机床验收同包闭环。

### 2. `wrapY` 依赖真实控制器脉冲/每圈距离校准

`rotaryWrapPerRevolutionMm` 是 Y 轴线性行程到夹具一圈旋转的映射。如果机床实际脉冲、微步、减速比或夹具接线变化，该值会导致角度比例错误。

现有措施：

- 已生成 `rotary-calibration-airrun.nc`。
- 机床验收要求 90/180/360 度实测和反向间隙。

建议：

- 在前端增加“标定值回填后自动更新参数并要求重新生成刀路”的强提示。
- 将 `measuredWrapPerRevolutionMm` 与当前设置差异超过阈值时，直接阻断生产证据。

### 3. CAMotics 展开预览不是完整圆柱夹具仿真

Y 轴旋转夹具在 CAMotics 中被准备为展开平面 X/Y/Z 检查，适合验证行程、Z、安全高度和大致包络，但不能完整代表圆柱/橄榄核实体、夹持端干涉和刀具姿态。

现有措施：

- 文档与仿真计划已标注限制。
- 生产门控要求真实材料去除仿真或等效证据。

建议：

- 引入 OpenCAMLib/FreeCAD/BlenderCAM 的真实刀具接触证据后，再用 CAMotics 或其他仿真器做同包材料去除结果绑定。
- 对两端夹持区增加不可达区/禁雕区验证。

### 4. 当前小闭环仍可能使用内置 Mesh CAM fallback

小闭环可验证架构和后处理，但内置 Mesh CAM 不等于专业 CAM 精度。

现有措施：

- `resultEngine === internal-mesh-cam` 会让生产门控保持 trial-only。

建议：

- 下一阶段优先接入可执行 OpenCAMLib/BlenderCAM neutral 刀位点输出。
- 只让外部 CAM 的 neutral 点进入 HeDiao3D `wrapY` 后处理。

## 建议下一步

1. 完成 Linux 侧 OpenCAMLib/BlenderCAM neutral 刀位点闭环，把内置 Mesh CAM 从生产候选路径中剥离。
2. 把旋转标定回填值用于推荐 `rotaryWrapPerRevolutionMm`，差异过大时要求重新生成 NC。
3. 增加端部夹持不可达区报告，避免两端缺损被误认为刀路错误。
4. 后续将制造 Profile 抽成前后端共享 JSON，避免 Profile 常量在前端和后端长期重复维护。
