# V3 OpenCAMLib 采样质量评估记录

日期: 2026-07-18

## 本轮增量

- OpenCAMLib runner 已在 `opencamlib-cutter-envelope-report.json` 输出 `sampling.quality`。
- OpenCAMLib runner 已在 `opencamlib-cutter-contact-report.json` 输出 `contactSampling.samplingQuality`。
- 质量 schema 为 `hediao3d.opencamlib-heightfield-sampling-quality.v1`。

## 指标

- `hitRate`: STL 射线/采样命中率。
- `xStepMm`: X 长度方向采样步距。
- `rotaryAngleStepDeg`: 旋转角度步距。
- `rotarySurfaceStepMm`: 按坯料半径折算后的旋转表面线性步距。
- `maxLinearStepMm`: X/旋转方向中的最大线性步距。
- `stepToCutterRatio`: 最大线性步距 / 刀具直径。
- `blockers`: 阻断进入真实 cutter-contact 精加工候选的问题。
- `warnings`: 可以继续试算但需要复核的问题。

## 当前结论

当前 7x33 旋转预览样件会被标记为 `coarse`，并暴露:

```text
sampling-step-larger-than-quarter-cutter-diameter
```

这说明当前输出只能用于可视化、包络复核和离料空跑，不能作为精加工候选。后续要进入真实试雕候选，至少需要提高采样密度，或替换为真正的 OpenCAMLib drop-cutter / cutter-contact / waterline 输出。

## 已验证

```text
npm run test:v3:rotary-heightfield: 通过
npm run test:v3:rotary-neutral-handoff: 通过
```
