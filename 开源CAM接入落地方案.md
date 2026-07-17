# HeDiao3D 开源 CAM 接入落地方案

日期：2026-07-17
分支：`HeDiao3D_V3`

## 1. 结论

当前项目距离成熟 CAM 软件的精度和稳定性还有明显差距，建议接入开源 CAM/仿真引擎，但不能把它们当作“一键替换”。最稳妥的落地方式是：

```text
HeDiao3D 前端/Orchestrator
  -> 外部 CAM/几何内核生成 G-code 或 neutral toolpath
  -> HeDiao3D 后处理成三轴控制器 + Y轴旋转夹具 NC
  -> CAMotics/自研旋转仿真/空跑/试雕门禁
```

也就是说，外部 CAM 负责更专业的刀路算法，HeDiao3D 继续负责核雕业务、旋转夹具后处理、安全校验和加工包交付。

## 2. 推荐接入对象

| 软件/库 | 定位 | 推荐级别 | 在本项目中的用途 | 不能直接解决的问题 |
|---|---|---:|---|---|
| FreeCAD CAM / Path Workbench | 开源通用 CAM | P0 | 三轴浮雕、规则实体、夹具/治具、标准 G-code 参考 | 不能直接生成三轴控制器 + Y 旋转夹具最终 NC |
| OpenCAMLib | 曲面刀具接触几何内核 | P0 | drop-cutter、水线、精加工刀位点、刀具包络计算 | 不是完整 CAM 软件，没有完整 UI/装夹/后处理 |
| CAMotics | G-code 材料去除仿真 | P0 | 上机前材料去除、Z 深度、边界、空跑验证 | 不生成刀路，旋转夹具只能做展开预览或辅助验证 |
| BlenderCAM / FabexCNC | 艺术 Mesh CAM | P1 | 佛头、人物、浮雕纹理和 Blender 修模流程 | 插件版本/API 差异较大，需要服务器实测 |
| LinuxCNC | 控制器/仿真环境 | P2 | G-code 方言参考、控制器行为验证 | 不适合作为本项目主要 CAM 引擎 |
| PyCAM | 轻量开源 CAM | P2 | 可作为研究/备选 | 维护活跃度和复杂曲面能力需谨慎评估 |

## 3. 推荐技术路线

### 3.1 近期小闭环

目标：先证明外部 CAM 结果可以进入 HeDiao3D 统一流程。

1. FreeCAD adapter 输出 `freecad-cam-plan.json`、`freecad-run-template.py` 和实验 G-code。
2. OpenCAMLib adapter 输出 `hediao3d.neutral-toolpath.v1` 中立刀位点。
3. HeDiao3D 摄取外部 G-code/neutral toolpath，统一生成：
   - `toolpath.nc`
   - `air-run.nc`
   - `camotics-preview.nc`
   - `production-gate.json`
   - `delivery-manifest.json`
4. CAMotics 运行真实材料去除仿真，结果回填 `hediao3d.camotics-result.v1`。

### 3.2 中期可试雕闭环

目标：让外部 CAM 输出通过真实仿真和机床验收。

1. Linux CAM 服务器安装 FreeCAD、OpenCAMLib、CAMotics。
2. 使用佛头 STL/OBJ 小模型跑外部 CAM。
3. 对比：
   - 原始 3D 模型
   - 外部 CAM 刀路
   - CAMotics 材料去除结果
   - HeDiao3D 旋转包裹预览
4. 导出离料空跑文件，验证 X/Z/Y 旋转方向。
5. 软料试雕并回填试雕反馈。

### 3.3 长期生产闭环

目标：逐步逼近成熟 CAM 的工程能力。

1. OpenCAMLib 替换当前预览采样核心，实现真实刀具接触点。
2. 加入粗加工、精加工、清残分层策略。
3. 以 CAMotics 或等效仿真输出材料去除网格和截图。
4. 形成机床 Profile、刀具库、后处理模板和试雕案例库。
5. 只有真实外部 CAM、真实材料去除仿真、空跑、试雕、机床验收全部通过时，才允许生产 NC 下载。

## 4. 与当前 V3 架构的对应关系

| V3 层 | 当前/新增职责 | 开源 CAM 接入点 |
|---|---|---|
| 前端 HeDiao3D | 参数、模型预览、中文流程、报告、下载 | 展示 Native CAM readiness、adapter 报告、CAMotics 结果 |
| Orchestrator | 任务队列、文件缓存、模型修复、外部命令调用 | 调用 FreeCAD/BlenderCAM/OpenCAMLib/CAMotics adapter |
| CAM 引擎层 | 专业刀路或中立刀位点 | FreeCAD、OpenCAMLib、BlenderCAM |
| 仿真层 | 材料去除和空跑验证 | CAMotics + 自研旋转包裹预览 |
| 后处理层 | 三轴控制器 + Y轴旋转夹具 NC | HeDiao3D 自研 wrapY/wrapA 后处理 |

## 5. 当前代码中的落地入口

| 入口 | 作用 |
|---|---|
| `GET /api/orchestrator/engines` | 探测本机 FreeCAD/Blender/CAMotics/OpenCAMLib 是否可用 |
| `POST /api/orchestrator/native-cam` | 生成 Native CAM readiness 报告和能力矩阵 |
| `POST /api/orchestrator/jobs` | 创建 V3 加工任务，自动生成 CAM 输入、adapter 预检、刀路、仿真和交付包 |
| `adapters/freecad/freecad_cam_job.py` | FreeCAD CAM 计划与外部命令适配器 |
| `adapters/opencamlib/opencamlib_job.py` | OpenCAMLib neutral toolpath 适配器 |
| `adapters/camotics/camotics_job.js` | CAMotics 结果导入/仿真计划适配器 |
| `adapters/camotics/camotics_cli_prepare.js` | Linux CAMotics 运行包准备工具 |

## 6. 验收命令

```bash
npm run test:v3:native-cam
npm run test:v3:adapters
npm run test:v3:freecad-external-handoff
npm run test:v3:closed-neutral-handoff
npm run test:v3:camotics-import
npm run test:v3:readiness-api
```

生产前必须额外完成：

- 外部 CAM 输出不是 fixture/synthetic。
- CAMotics 或等效仿真结果不是 synthetic。
- `camotics-result.json` 与当前 `camotics-preview.nc` 输入哈希匹配。
- `controller-dialect-report.json` 没有 critical。
- `machine-acceptance.json` 和试雕反馈通过。

## 7. 关键边界

1. Meshy/AI 3D 负责生成视觉模型，不负责 CAM。
2. FreeCAD/BlenderCAM 可以生成外部刀路，但不能绕过 HeDiao3D 安全门。
3. OpenCAMLib 更适合做核心几何算法，不是完整 CAM 产品。
4. CAMotics 是仿真器，不是刀路生成器。
5. 三轴控制器 + Y轴旋转夹具的最终 NC 必须由 HeDiao3D 后处理层生成或复核。
6. 当前所有 fixture/synthetic/preview scaffold 结果只能证明链路，不代表能上机生产。

## 8. 下一步建议

优先做三件事：

1. 在 Linux 服务器安装 FreeCAD、OpenCAMLib、CAMotics，并跑通 `native-cam` readiness。
2. 用佛头 STL/OBJ 做 FreeCAD/OpenCAMLib 小模型外部 handoff。
3. 将真实 CAMotics 材料去除结果回填到 V3 job，让 `production-gate.json` 能基于真实仿真给出试雕判断。
