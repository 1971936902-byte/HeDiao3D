import { PointerEvent, useEffect, useRef, useState } from "react";
import { Brush, Waves } from "lucide-react";
import type { DepthMap } from "./types";

type BrushMode = "deepen" | "reduce" | "smooth";

type DepthEditorProps = {
  depthMap: DepthMap | null;
  onChange: (depthMap: DepthMap) => void;
};

export function DepthEditor({ depthMap, onChange }: DepthEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [mode, setMode] = useState<BrushMode>("deepen");
  const [brushSize, setBrushSize] = useState(14);
  const [strength, setStrength] = useState(0.16);

  useEffect(() => {
    drawDepthMap(canvasRef.current, depthMap);
  }, [depthMap]);

  const paint = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!depthMap || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * depthMap.width;
    const y = ((event.clientY - rect.top) / rect.height) * depthMap.height;
    const next = applyBrush(depthMap, x, y, brushSize, strength, mode);
    onChange(next);
  };

  return (
    <section className="panel">
      <div className="panel-title">
        <Brush size={18} />
        <h2>局部修模</h2>
      </div>
      <div className={`depth-editor ${depthMap ? "" : "disabled"}`}>
        <canvas
          ref={canvasRef}
          width={256}
          height={160}
          onPointerDown={(event) => {
            drawingRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            paint(event);
          }}
          onPointerMove={(event) => {
            if (drawingRef.current) paint(event);
          }}
          onPointerUp={(event) => {
            drawingRef.current = false;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerLeave={() => {
            drawingRef.current = false;
          }}
        />
        {!depthMap && <span>点击“3D生成”后可局部修模</span>}
      </div>
      <div className="segmented">
        <button className={mode === "deepen" ? "active" : ""} onClick={() => setMode("deepen")} type="button">
          加深
        </button>
        <button className={mode === "reduce" ? "active" : ""} onClick={() => setMode("reduce")} type="button">
          减浅
        </button>
        <button className={mode === "smooth" ? "active" : ""} onClick={() => setMode("smooth")} type="button">
          <Waves size={14} />
          平滑
        </button>
      </div>
      <label className="control compact">
        <span>
          笔刷
          <strong>{brushSize}px</strong>
        </span>
        <input type="range" min={4} max={42} step={1} value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
      </label>
      <label className="control compact">
        <span>
          强度
          <strong>{strength.toFixed(2)}</strong>
        </span>
        <input type="range" min={0.02} max={0.35} step={0.01} value={strength} onChange={(event) => setStrength(Number(event.target.value))} />
      </label>
    </section>
  );
}

function drawDepthMap(canvas: HTMLCanvasElement | null, depthMap: DepthMap | null) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#efe5d7";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!depthMap) return;

  const image = ctx.createImageData(depthMap.width, depthMap.height);
  for (let i = 0; i < depthMap.values.length; i += 1) {
    const shade = Math.round(255 - depthMap.values[i] * 235);
    const p = i * 4;
    image.data[p] = shade;
    image.data[p + 1] = Math.max(0, shade - 20);
    image.data[p + 2] = Math.max(0, shade - 44);
    image.data[p + 3] = 255;
  }

  const offscreen = document.createElement("canvas");
  offscreen.width = depthMap.width;
  offscreen.height = depthMap.height;
  offscreen.getContext("2d")?.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
}

function applyBrush(depthMap: DepthMap, cx: number, cy: number, radius: number, strength: number, mode: BrushMode): DepthMap {
  const values = new Float32Array(depthMap.values);
  const radiusSq = radius * radius;
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(depthMap.width - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(depthMap.height - 1, Math.ceil(cy + radius));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > radiusSq) continue;

      const index = y * depthMap.width + x;
      const falloff = 1 - Math.sqrt(distanceSq) / radius;

      if (mode === "smooth") {
        values[index] = values[index] * (1 - strength * falloff) + localAverage(depthMap, x, y) * strength * falloff;
      } else {
        const direction = mode === "deepen" ? 1 : -1;
        values[index] = Math.min(1, Math.max(0, values[index] + direction * strength * falloff));
      }
    }
  }

  return { ...depthMap, values };
}

function localAverage(depthMap: DepthMap, x: number, y: number): number {
  let sum = 0;
  let count = 0;

  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const sx = Math.min(depthMap.width - 1, Math.max(0, x + ox));
      const sy = Math.min(depthMap.height - 1, Math.max(0, y + oy));
      sum += depthMap.values[sy * depthMap.width + sx];
      count += 1;
    }
  }

  return sum / count;
}
