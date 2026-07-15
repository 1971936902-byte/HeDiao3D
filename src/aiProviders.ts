export type Ai3dProviderId = "meshy" | "tripo" | "rodin" | "local-hunyuan";

export type Ai3dProvider = {
  id: Ai3dProviderId;
  name: string;
  status: "available" | "planned" | "local";
  endpoint?: string;
  taskEndpoint?: (taskId: string) => string;
  maxImages: number;
  targetFormats: string[];
  capabilities: string[];
  note: string;
};

export const ai3dProviders: Ai3dProvider[] = [
  {
    id: "meshy",
    name: "Meshy",
    status: "available",
    endpoint: "/api/meshy/multi-image-to-3d",
    taskEndpoint: (taskId) => `/api/meshy/multi-image-to-3d/${encodeURIComponent(taskId)}`,
    maxImages: 4,
    targetFormats: ["glb", "stl"],
    capabilities: ["多图转3D", "GLB/STL", "Repair", "Remesh"],
    note: "当前已接入，适合快速生成完整 3D Mesh 并进入 CAM 体检。"
  },
  {
    id: "tripo",
    name: "Tripo",
    status: "planned",
    maxImages: 4,
    targetFormats: ["glb", "stl"],
    capabilities: ["多图转3D", "纹理模型", "版本对比"],
    note: "预留 Provider 接口；接入后可与 Meshy 结果并排比较。"
  },
  {
    id: "rodin",
    name: "Rodin",
    status: "planned",
    maxImages: 4,
    targetFormats: ["glb", "obj"],
    capabilities: ["高质量视觉模型", "纹理生成", "重拓扑"],
    note: "预留云端 Provider，用于补充不同 AI 3D 生成风格。"
  },
  {
    id: "local-hunyuan",
    name: "本地 Hunyuan3D",
    status: "local",
    maxImages: 1,
    targetFormats: ["glb", "stl"],
    capabilities: ["本地推理", "数据不出本机", "可私有化"],
    note: "预留本地推理 Provider，需要另行部署模型服务。"
  }
];

export function getAi3dProvider(id: Ai3dProviderId) {
  return ai3dProviders.find((provider) => provider.id === id) ?? ai3dProviders[0];
}

export function isProviderAvailable(provider: Ai3dProvider) {
  return provider.status === "available" && Boolean(provider.endpoint && provider.taskEndpoint);
}
