# 采样点及航线管理器 — 需求文档

> 版本：1.0
> 日期：2026-08-28
> 模块：SuperSplat 采样点标记与航线生成系统

---

## 1. 概述

在 SuperSplat 场景编辑器中，针对导入的 LCC（XGRIDS）高斯泼溅模型，提供一套完整的**采样点标记**与**无人机航点航线生成**功能。用户可以在模型表面标注采样点，系统自动沿表面法线方向生成无人机悬停拍照点，并将所有航点连接为航线。

### 1.1 核心价值

- 在 3D 模型表面直观标注采样点
- 自动生成无人机航点（悬停拍照点）
- 可视化航线规划
- 采样点与航点均可调整位置
- 支持经纬度坐标输出（WGS84）

---

## 2. 功能清单

### 2.1 采样点标记工具

| 功能 | 描述 |
|------|------|
| 工具入口 | bottom-toolbar 中添加功能 icon，悬浮提示"采样点标记" |
| 激活状态 | 点击后背景 active 样式与其他工具按钮一致 |
| 标记绘制 | 鼠标点击已导入模型表面，在点击处绘制黄色小球 |
| 小球大小 | 约为场景半径的 0.002/3，视觉精巧不遮挡模型 |
| 位置修改 | 选中小球后出现 TranslateGizmo，可拖动调整位置 |
| 撤销/重做 | 通过 AddSamplePointOp / MoveSamplePointOp 支持完整撤销重做 |
| 实时渲染 | 操作后强制场景重绘，确保 UI 即时响应 |

### 2.2 采样点及航线管理器面板

**位置**：左侧场景管理器面板下方，独立面板。

#### 2.2.1 文件夹管理

| 功能 | 描述 |
|------|------|
| 新建文件夹 | 面板头部 + 按钮，点击创建新文件夹 |
| 文件夹结构 | 文件夹名 + 展开/折叠按钮 + 操作按钮区 |
| 删除文件夹 | 文件夹行右侧删除按钮，销毁所有采样点及航点 |

#### 2.2.2 采样点管理

| 功能 | 描述 |
|------|------|
| 新增采样点 | 文件夹行右侧"新增采样点"按钮，点击后高亮表示标注中 |
| 标注模式 | 新增期间隐藏 bottom-toolbar，全屏交互 |
| 序号规则 | 每个文件夹内序号从 1 开始递增（Point 1, Point 2, ...） |
| 序号重排 | 删除中间点后，剩余点序号自动重新排列 |
| 采样点删除 | 每行右侧删除按钮，删除后序号重排 + 小球销毁 |
| hover 高亮 | 鼠标悬浮面板采样点行，对应 3D 小球变为橙黄色 |

#### 2.2.3 航点及航线管理

| 功能 | 描述 |
|------|------|
| 生成航点及航线 | 文件夹行右侧航线按钮，点击后生成航点+航线 |
| 按钮激活态 | 点击后按钮高亮，再次点击退出激活 |
| 航点位置调整 | 激活状态下点击航点出现 gizmo，可拖动调整位置 |
| 航线实时更新 | 航点移动后蓝色航线即时重新连接 |
| 航点子文件夹 | 生成后在采样点文件夹内创建"航点"子文件夹 |
| 子文件夹删除 | 子文件夹右侧删除按钮，清除所有航点和航线 |
| hover 高亮 | 鼠标悬浮面板航点行，对应 3D 航点变为天蓝色 |

### 2.3 坐标转换

| 功能 | 描述 |
|------|------|
| LCC 地理元数据 | 导入 LCC 模型时提取 epsg、offset、shift、scale |
| 坐标链路 | 场景局部坐标 → LCC 局部坐标 → EPSG 投影坐标 → WGS84 经纬度 |
| 项目持久化 | 保存 .ssproj 时写入 geoMeta，加载时恢复 |
| 经纬度输出 | 采样点可输出 WGS84 { lat, lon, alt } |

---

## 3. 航点生成规则

### 3.1 表面法线计算

由于 LCC 高斯泼溅模型无显式表面法线，采用以下近似方案：

```
法线方向 = normalize(相机位置 - 采样点表面位置)
```

即从模型表面指向相机的方向，近似为该点的表面法线（适用于凸表面、相机正对表面的场景）。

### 3.2 航点位置

```
航点位置 = 采样点位置 + 法线方向 × 10m
```

- 偏移距离：10 个场景单位（假设 1 单位 = 1 米）
- 沿法线方向偏移，确保无人机悬停位置在模型表面法线方向上方

### 3.3 航线渲染

- 使用 PlayCanvas `PRIMITIVE_LINESTRIP` 将所有航点按顺序连接
- 航点材质：蓝色 (0, 0.5, 1)
- 航线材质：蓝色 (0, 0.5, 1)
- 航点移动后通过 `mesh.setPositions()` + `mesh.update()` 实时更新

---

## 4. 视觉设计

### 4.1 颜色方案

| 元素 | 默认颜色 | hover 高亮颜色 |
|------|----------|----------------|
| 采样点（黄色小球） | (1, 1, 0) 黄色 | (1, 0.5, 0) 橙黄色 |
| 航点（蓝色小球） | (0, 0.5, 1) 蓝色 | (0, 0.8, 1) 天蓝色 |
| 航线（线段） | (0, 0.5, 1) 蓝色 | — |

### 4.2 面板样式

| 元素 | 样式 |
|------|------|
| 面板位置 | 左侧 24px，宽 320px，最大高度 40vh |
| 采样点行 | 黄色文字主题 |
| 航点行 | 蓝色文字主题，左侧缩进区分层级 |
| 按钮激活态 | 背景色变浅 + SVG 颜色变为主题色 |

---

## 5. 技术架构

### 5.1 文件结构

```
src/
├── tools/
│   └── sample-point-tool.ts          # 采样点工具（标记创建、gizmo、航点生成）
├── ui/
│   ├── sample-point-panel.ts         # 面板 UI（文件夹、采样点、航点列表）
│   ├── scss/
│   │   └── sample-point-panel.scss   # 面板样式
│   └── svg/
│       ├── route.svg                 # 航线图标
│       └── sample-point-small.svg    # 采样点图标
├── scene.ts                          # GeoMeta 接口定义
├── file-handler.ts                   # LCC 导入时提取地理元数据
├── doc.ts                            # 项目保存/加载 geoMeta
└── main.ts                           # 工具注册、面板挂载
```

### 5.2 事件系统

| 事件名 | 方向 | 数据 | 说明 |
|--------|------|------|------|
| `samplePoint.created` | Tool → Panel | { position, normal, wgs84, markerEntity } | 采样点创建完成 |
| `samplePoint.highlight` | Panel → Tool | Entity | 高亮 marker |
| `samplePoint.unhighlight` | Panel → Tool | Entity | 取消高亮 |
| `samplePoint.generateRoute` | Panel → Tool | { position, normal }[] | 触发航点生成 |
| `samplePoint.routeMode` | Panel → Tool | boolean | 进入/退出航线编辑模式 |
| `route.generated` | Tool → Panel | { position, markerEntity }[] | 航点生成完成 |
| `route.clear` | Panel → Tool | — | 清除航线 |
| `waypoint.moved` | Tool → Panel | Entity, Vec3 | 航点位置移动 |
| `edit.add` | Tool → EditSystem | EditOp | 撤销/重做操作入栈 |

### 5.3 编辑操作（EditOp）

| 操作类 | 功能 |
|--------|------|
| `AddSamplePointOp` | 添加采样点（do: 添加 entity，undo: 移除 entity） |
| `MoveSamplePointOp` | 移动采样点（do: 设新位置，undo: 设旧位置） |

> 航点移动暂不支持撤销/重做（仅实时更新航线）。

### 5.4 工具模式

| 模式 | 触发条件 | 行为 |
|------|----------|------|
| 采样点创建模式 | 点击"新增采样点"按钮 | 点击模型表面创建黄色小球 |
| 航线编辑模式 | 点击"生成航点及航线"按钮 | 点击航点选中并移动，表面点击不创建新点 |
| 非激活模式 | 默认状态 | 工具不响应交互 |

---

## 6. 数据结构

### 6.1 采样点数据

```typescript
interface SamplePointData {
    id: string;
    name: string;           // "Point 1", "Point 2", ...
    position: Vec3;          // 场景局部坐标
    normal: Vec3;            // 表面法线（近似）
    wgs84: { lat: number; lon: number; alt: number } | null;
    markerEntity: Entity;    // 3D 黄色小球实体
}
```

### 6.2 航点数据

```typescript
interface WaypointData {
    id: string;
    name: string;           // "WP 1", "WP 2", ...
    position: Vec3;          // 航点位置（采样点 + 法线 × 10）
    markerEntity: Entity;    // 3D 蓝色小球实体
}
```

### 6.3 文件夹数据

```typescript
interface SampleFolder {
    id: string;
    name: string;
    expanded: boolean;
    addingPoints: boolean;    // 是否正在新增采样点
    routeActive: boolean;     // 是否在航线编辑模式
    points: SamplePointData[];
    waypoints: WaypointData[];
}
```

### 6.4 地理元数据

```typescript
interface GeoMeta {
    epsg: number;       // 投影坐标系 EPSG 编号
    offset: [number, number, number];
    shift: [number, number, number];
    scale: [number, number, number];
}
```

---

## 7. 已知限制

1. **表面法线为近似值**：使用相机方向近似法线，非真实几何法线
2. **航点移动无撤销**：航点位置调整暂不支持 undo/redo
3. **航线线宽**：WebGL 线段默认 1 像素宽，无法加粗（如需加粗需改用 tube mesh）
4. **旧项目文件兼容**：之前保存的 .ssproj 文件无 geoMeta 字段，需重新导入 LCC 并重新保存
5. **偏移距离固定**：航点偏移 10 个场景单位，如场景比例尺非 1:1 米则需调整

---

## 8. 开发历程关键决策

| 时间 | 决策 | 原因 |
|------|------|------|
| - | 小球上显示序号 → 改为 hover 高亮 | 3D 文字渲染复杂，hover 高亮更直观 |
| - | 拖拽排序 → 删除功能 | PCUI Container 阻止 HTML5 drag，pointer 实现复杂 |
| - | 航线用 PRIMITIVE_LINESTRIP | 项目已有 mesh.setPositions 模式，简单高效 |
| - | 航点子文件夹嵌套在采样点文件夹内 | 用户要求层级关系清晰 |
| - | 采样点 hover 橙黄，航点 hover 天蓝 | 区分两类元素的视觉反馈 |
