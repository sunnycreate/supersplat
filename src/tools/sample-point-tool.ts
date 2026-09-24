import { Color, Entity, Mat4, Mesh, MeshInstance, PRIMITIVE_LINES, StandardMaterial, TranslateGizmo, Vec3 } from 'playcanvas';
import proj4 from 'proj4';

import { EditOp } from '../edit-ops';
import { ElementType } from '../element';
import { Events } from '../events';
import { ClearanceField, RouteSafetyReport } from '../route/clearance-field';
import { makeLineMaterial, RouteOverlay } from '../route/route-overlay';
import { planDetour, snapToSafe, solveHoverPoint } from '../route/route-planner';
import { SafetyLevel, hardClearance, levelColor } from '../route/safety-config';
import { WaypointCameraRig } from '../route/waypoint-camera';
import { Scene } from '../scene';
import { Splat } from '../splat';

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;

// screen-space pick radius for selecting an existing marker (pixels)
const MARKER_PICK_RADIUS = 12;

// 起飞点/返航点小球的颜色（与航线管线同一绿色系）
const HOME_COLOR = new Color(0.16, 0.75, 0.32);

// temp vectors (module-scope to avoid per-frame allocations)
const tmpScreen = new Vec3();
const tmpWorld = new Vec3();
const tmpDir = new Vec3();

// planned result for one leg of the route
interface LegPlan {
    // intermediate points to insert between the endpoints (empty when the
    // straight leg is already safe); null when the detour search failed and
    // the straight leg is kept (its measured level then flags it)
    detour: Vec3[] | null;
    // worst clearance along the leg
    clearance: number;
    // where that worst clearance occurs
    point: Vec3;
}

// 航线扁平条目：拍照航点与转折点按航线顺序混排。转折点是绕行折线中
// 方向显著变化的顶点，提升为真实条目后画线/校验都以条目序列为准
interface RouteEntry {
    kind: 'shot' | 'turn';
    entity: Entity;
}

// route.entries 载荷元素：按序广播给面板重建航点列表行
interface RouteEntryData {
    marker: Entity;
    kind: 'shot' | 'turn';
    position: Vec3;
}

// 航点导出行：kind 区分拍照点/转折点/起飞返航点（新增字段，向后兼容）；
// 转折点与起飞返航点均无云台字段
type ExportRow = {
    index: number;
    name: string;
    kind: 'shot';
    lon: number | null;
    lat: number | null;
    alt: number | null;
    gimbal: { yaw: number; pitch: number; focal: number; groundDist: number; shootDist: number };
} | {
    index: number;
    name: string;
    kind: 'turn' | 'home';
    lon: number | null;
    lat: number | null;
    alt: number | null;
};

// upper bound on cached legs before the oldest are dropped
const LEG_CACHE_LIMIT = 512;

// payload the panel needs to create (or restore) a row for a marker
interface SamplePointCreatedData {
    position: Vec3;
    normal: Vec3;
    wgs84: { lat: number; lon: number; alt: number } | null;
    markerEntity: Entity;
}

// add a sample point marker to the scene (undo removes it)
class AddSamplePointOp implements EditOp {
    name = 'addSamplePoint';
    parent: Entity;
    marker: Entity;
    scene: Scene;
    events: Events;
    data: SamplePointCreatedData;

    constructor(parent: Entity, marker: Entity, scene: Scene, events: Events, data: SamplePointCreatedData) {
        this.parent = parent;
        this.marker = marker;
        this.scene = scene;
        this.events = events;
        this.data = data;
    }

    // fired from do()/undo() rather than from createMarker so that redo also
    // restores the panel row (the edit history replays do())
    do() {
        this.parent.addChild(this.marker);
        this.scene.forceRender = true;
        this.events.fire('samplePoint.created', this.data);
    }

    undo() {
        this.parent.removeChild(this.marker);
        this.scene.forceRender = true;
        this.events.fire('samplePoint.removed', this.marker);
    }

    destroy() {
        // the op is being discarded: drop the row along with the marker
        this.events.fire('samplePoint.removed', this.marker);
        this.marker.destroy();
    }
}

// move a sample point marker (undo restores the old position)
class MoveSamplePointOp implements EditOp {
    name = 'moveSamplePoint';
    marker: Entity;
    oldPos: Vec3;
    newPos: Vec3;
    scene: Scene;
    events: Events;
    toWgs84: (pos: Vec3) => { lat: number; lon: number; alt: number } | null;

    constructor(
        marker: Entity,
        oldPos: Vec3,
        newPos: Vec3,
        scene: Scene,
        events: Events,
        toWgs84: (pos: Vec3) => { lat: number; lon: number; alt: number } | null
    ) {
        this.marker = marker;
        this.oldPos = oldPos;
        this.newPos = newPos;
        this.scene = scene;
        this.events = events;
        this.toWgs84 = toWgs84;
    }

    do() {
        this.marker.setLocalPosition(this.newPos);
        this.scene.forceRender = true;
        // fired from do()/undo() rather than from the gizmo handler so that
        // undo/redo keep the panel row and waypoint subjects in sync too
        this.events.fire('samplePoint.moved', {
            marker: this.marker,
            position: this.newPos.clone(),
            wgs84: this.toWgs84(this.newPos)
        });
    }

    undo() {
        this.marker.setLocalPosition(this.oldPos);
        this.scene.forceRender = true;
        this.events.fire('samplePoint.moved', {
            marker: this.marker,
            position: this.oldPos.clone(),
            wgs84: this.toWgs84(this.oldPos)
        });
    }
}

class SamplePointTool {
    activate: () => void;
    deactivate: () => void;

    private events: Events;
    private scene: Scene;
    private canvasContainer: HTMLElement;
    // obstacle field used to measure waypoint / route safety
    private clearance: ClearanceField;

    // root entity that holds all sample point markers
    private root: Entity | null = null;
    // entity that holds generated waypoints and route line
    private routeEntity: Entity | null = null;
    // sample points and oriented normals behind the red normal debug lines of
    // the last route generation; kept so a moved sample point can re-orient
    // its line (positions are the panel's live objects, updated in place)
    private debugPoints: { position: Vec3; normal: Vec3; marker?: Entity }[] | null = null;
    private debugNormals: Vec3[] | null = null;
    private debugFieldReady = false;
    // route visuals (tube, arrows, distance indicator and normal debug lines)
    // are drawn by the overlay; the tool keeps interaction and orchestration
    private overlay: RouteOverlay;

    // bounding box of the device selected in the ledger panel (orange wireframe)
    private deviceBoxEntity: Entity | null = null;
    private deviceBoxMesh: Mesh | null = null;
    private deviceBoxMaterial: StandardMaterial;
    // measured safety level per waypoint entity (drives its base colour)
    private markerLevels = new Map<Entity, SafetyLevel>();
    // set while a validation is running; a queued flag re-runs it afterwards
    private validating = false;
    private validationQueued = false;
    // leg plans keyed by their endpoints (see getLegPlan)
    private legCache = new Map<string, LegPlan>();
    // 按航线顺序混排的条目（拍照航点 + 转折点）；位置以实体实时位置为准
    private routeEntries: RouteEntry[] = [];
    // 每个拍照航段上次同步转折点时的端点键：端点没动就跳过重新绕行，
    // 这样拖动转折点后的重新校验不会把用户放置的位置覆盖回规划结果
    private legKeys: string[] = [];
    // 最近一次完整校验的安全报告；转折点移动时在其上做增量更新
    private lastReport: RouteSafetyReport | null = null;
    // 当前航线来源（'panel' | 'device'），随 route.entries 一并广播供面板过滤
    private routeSource: 'panel' | 'device' = 'panel';
    // obstacle field version the cache was built against
    private cachedFieldVersion = '';
    // when true, surface clicks don't create new markers; waypoint dragging is enabled
    private routeEditMode = false;
    // 起飞点/返航点实体（绿色小球，挂在 routeEntity 下）；null = 未放置
    private homePoint: Entity | null = null;
    // true = 正在等待用户点击场景放置起飞点（点击不再创建采样点）
    private homePlacing = false;
    private active = false;

    // gizmo for moving markers
    private gizmo: TranslateGizmo;
    private selectedMarker: Entity | null = null;
    private dragStartPos: Vec3 | null = null;

    private clicked = false;
    private clickX = 0;
    private clickY = 0;

    // gimbal attitude rig: frustum, direction indicators, WASD move and the
    // picture-in-picture preview for waypoints (PRD P1)
    private cameraRig: WaypointCameraRig;

    constructor(events: Events, scene: Scene, canvasContainer: HTMLElement, clearance: ClearanceField) {
        this.events = events;
        this.scene = scene;
        this.canvasContainer = canvasContainer;
        this.clearance = clearance;

        // route visuals (tube, arrows, distance indicators, normal debug
        // lines) are drawn by the overlay; the route entity is created lazily
        // in generateRoute, hence the accessor
        this.overlay = new RouteOverlay(scene, () => this.routeEntity, events, clearance);

        this.deviceBoxMaterial = makeLineMaterial(new Color(1, 0.55, 0.05));

        this.cameraRig = new WaypointCameraRig(events, scene);

        // translate gizmo for repositioning markers
        this.gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);

        this.gizmo.on('render:update', () => {
            scene.forceRender = true;
        });

        this.gizmo.on('transform:start', () => {
            if (this.selectedMarker) {
                this.dragStartPos = this.selectedMarker.getLocalPosition().clone();
            }
        });

        this.gizmo.on('transform:end', () => {
            if (this.selectedMarker && this.dragStartPos) {
                let newPos = this.selectedMarker.getLocalPosition().clone();
                // only record if the marker actually moved
                if (!newPos.equals(this.dragStartPos)) {
                    if (this.selectedMarker.name === 'waypoint') {
                        // P2: dragged into danger — push it back to safety, and
                        // restore the previous position when that isn't possible
                        newPos = this.snapWaypoint(this.selectedMarker, this.dragStartPos);
                        // re-plan the route (legs may need a new detour)
                        this.updateRouteLine();
                        events.fire('waypoint.moved', this.selectedMarker, newPos.clone());
                    } else if (this.selectedMarker.name === 'turnpoint') {
                        // 转折点：用户显式放置的结果，不做安全吸附、不自动再绕行；
                        // 只重画航线并重测与它相连的航段，不走完整校验管线
                        this.updateForTurnMove(this.selectedMarker);
                        events.fire('waypoint.moved', this.selectedMarker, newPos.clone());
                    } else if (this.selectedMarker.name === 'homepoint') {
                        // 起飞点：重绘航线（含首尾蓝色接线）并重新校验；起飞点
                        // 与其接线不进条目序列，不参与净空校验与转折点生成
                        this.updateRouteLine();
                        events.fire('waypoint.moved', this.selectedMarker, newPos.clone());
                    } else {
                        // do() re-applies the position the gizmo already set
                        // (idempotent) and fires 'samplePoint.moved' so the
                        // panel row and the waypoint subject lines follow
                        events.fire('edit.add', new MoveSamplePointOp(
                            this.selectedMarker,
                            this.dragStartPos,
                            newPos,
                            scene,
                            events,
                            (pos) => this.sceneToWgs84(pos)
                        ));
                    }
                }
                this.dragStartPos = null;
            }
        });

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };

        const pointerdown = (e: PointerEvent) => {
            if (!this.clicked && isPrimary(e)) {
                this.clicked = true;
                this.clickX = e.offsetX;
                this.clickY = e.offsetY;
            }
        };

        const pointermove = (e: PointerEvent) => {
            if (this.clicked && Math.hypot(e.offsetX - this.clickX, e.offsetY - this.clickY) > CLICK_TOLERANCE) {
                this.clicked = false;
            }
        };

        const pointerup = async (e: PointerEvent) => {
            if (this.clicked && isPrimary(e)) {
                this.clicked = false;

                // first, check if an existing marker was clicked
                const hit = this.pickMarker(this.clickX, this.clickY);
                if (hit) {
                    if (hit === this.selectedMarker) {
                        // clicking the selected marker deselects it
                        this.deselectMarker();
                    } else {
                        this.selectMarker(hit);
                    }
                } else if (this.homePlacing) {
                    // 起飞点放置状态：在拾取命中点创建起飞点/返航点（此分支
                    // 挡在采样点绘制路径之前，放置期间的点击不再创建采样点）
                    const x = this.clickX / this.canvasContainer.clientWidth;
                    const y = this.clickY / this.canvasContainer.clientHeight;
                    const result = await scene.camera.intersect(x, y);
                    if (result) {
                        this.placeHomePoint(result.position);
                    }
                } else if (this.routeEditMode) {
                    // in route edit mode, clicking empty space just deselects
                    this.deselectMarker();
                } else {
                    // try to place a new marker on the model surface
                    const x = this.clickX / this.canvasContainer.clientWidth;
                    const y = this.clickY / this.canvasContainer.clientHeight;
                    const result = await scene.camera.intersect(x, y);
                    if (result) {
                        this.deselectMarker();
                        // approximate surface normal as direction from surface to camera
                        const cameraPos = scene.camera.mainCamera.getPosition();
                        const normal = new Vec3().sub2(cameraPos, result.position).normalize();
                        this.createMarker(result.position, normal);
                    }
                }

                e.preventDefault();
                e.stopPropagation();
            }
        };

        // keep gizmo size proportional to the canvas
        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            if (camera.ortho) {
                this.gizmo.size = 1125 / canvas.clientHeight;
            } else {
                this.gizmo.size = 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
            }
        };
        updateGizmoSize();
        events.on('camera.resize', updateGizmoSize);
        events.on('camera.ortho', updateGizmoSize);

        this.activate = () => {
            this.active = true;

            // create root entity lazily so markers are only in the scene graph
            // while the tool has been used at least once
            if (!this.root) {
                this.root = new Entity('samplePoints');
                scene.app.root.addChild(this.root);
            }

            canvasContainer.addEventListener('pointerdown', pointerdown);
            canvasContainer.addEventListener('pointermove', pointermove);
            canvasContainer.addEventListener('pointerup', pointerup, true);

            scene.forceRender = true;
        };

        this.deactivate = () => {
            this.active = false;

            this.deselectMarker();

            canvasContainer.removeEventListener('pointerdown', pointerdown);
            canvasContainer.removeEventListener('pointermove', pointermove);
            canvasContainer.removeEventListener('pointerup', pointerup, true);

            scene.forceRender = true;
        };

        // clear all markers when the scene is cleared
        events.on('scene.clear', () => this.clearMarkers());

        // focus the camera on a marker (e.g. clicking a panel row)
        events.on('samplePoint.focus', (marker: Entity) => {
            this.focusMarker(marker);
        });

        // highlight/unhighlight a marker (e.g. when hovering a panel row)
        events.on('samplePoint.highlight', (data: { marker: Entity }) => {
            this.highlightMarker(data.marker);
        });
        events.on('samplePoint.unhighlight', (data: { marker: Entity }) => {
            this.unhighlightMarker(data.marker);
        });

        // generate waypoints and route line from sample points
        events.on('samplePoint.generateRoute', (points: { position: Vec3; normal: Vec3; marker?: Entity }[]) => {
            this.generateRoute(points);
        });

        // a sample point moved after route generation: re-orient its normal at
        // the new position so the red debug line keeps showing the direction
        // the solver would use there
        events.on('samplePoint.moved', (data: { marker: Entity; position: Vec3 }) => {
            if (!this.debugPoints || !this.debugNormals) return;
            const i = this.debugPoints.findIndex((p) => p.marker === data.marker);
            if (i < 0) return;
            const point = this.debugPoints[i];
            point.position.copy(data.position);
            if (this.debugFieldReady) {
                this.debugNormals[i] = solveHoverPoint(this.clearance, point.position, point.normal, this.clearance.config).normal;
            } else {
                this.debugNormals[i] = point.normal;
            }
            this.overlay.setNormalDebug(this.debugPoints, this.debugNormals);
        });

        // toggle route editing mode (enables waypoint picking/moving)
        events.on('samplePoint.routeMode', (active: boolean) => {
            this.routeEditMode = active;
            if (!active) {
                this.deselectMarker();
            }
        });

        // clear the generated route
        events.on('route.clear', () => {
            this.clearRoute();
        });

        // re-measure the route on demand (e.g. the panel's validate button)
        events.on('route.safety.request', () => {
            this.clearance.invalidate();
            this.legCache.clear();
            this.cachedFieldVersion = '';
            this.scheduleValidation();
        });

        // a waypoint was moved with WASD; re-plan the route around the new
        // position (same handling as a gizmo drag). 转折点走轻量路径：只更新
        // 与它相连的航段，不触发完整校验
        events.on('route.redraw.request', (marker: Entity, position: Vec3) => {
            if (marker.name === 'turnpoint') {
                this.updateForTurnMove(marker);
            } else {
                this.updateRouteLine();
            }
            events.fire('waypoint.moved', marker, position);
        });

        // 供 UI 面板把场景坐标转成 WGS84（转折点没有采样点，列表行只能
        // 从实体位置现算）——复用工具现有的 sceneToWgs84 转换链
        events.function('route.toWgs84', (pos: Vec3) => this.sceneToWgs84(pos));

        // 航点列表点击转折点行：选中该转折点（挂 gizmo，编辑面板进入仅位置模式）
        events.on('route.entry.select', (marker: Entity) => {
            this.selectMarker(marker);
        });

        // 航点列表"添加起飞点/返航点"按钮：进入放置状态，点击场景的拾取
        // 命中点创建起飞点。已有起飞点或没有航线时忽略
        events.on('route.home.requestPlace', () => {
            if (this.homePoint || !this.routeEntity) return;
            // 确保采样点工具处于激活态（列表在航线模式下通常已激活；从别的
            // 工具切回时重新接管指针事件）。active 时不能重复 fire，否则
            // ToolManager 会把当前工具 toggle 成关闭
            if (this.events.invoke('tool.active') !== 'samplePoint') {
                this.events.fire('tool.samplePoint');
            }
            this.homePlacing = true;
            // 退出采样点绘制状态：收起 gizmo，放置期间的点击由 pointerup 的
            // homePlacing 分支接管，不再走 createMarker
            this.deselectMarker();
            this.events.fire('route.home.placing', true);
        });

        // export the waypoint list (lon/lat/alt) to the console (panel button)
        events.on('waypoint.export', (waypoints: { name: string; position: Vec3; markerEntity: Entity }[]) => {
            this.exportWaypoints(waypoints);
        });

        // show/hide the shortest-distance indicator lines (panel eye button);
        // broadcast the new state so every panel's eye icon stays in sync
        events.on('route.distIndicators', (visible: boolean) => {
            this.overlay.setDistVisible(visible);
            this.scene.forceRender = true;
            events.fire('route.distIndicators.state', visible);
        });

        // draw/hide the bounding box of the device selected in the ledger panel
        events.on('deviceLedger.select', (data: { name: string; bounding: number[][] }) => {
            this.showDeviceBox(data.bounding);
        });

        events.on('deviceLedger.deselect', () => {
            this.hideDeviceBox();
        });

        // generate a route from the checked ledger devices' sample points
        // (projected coords), reusing the sample point panel's pipeline
        events.on('deviceLedger.generate', (devices: { name: string; samplePoint: number[][] }[]) => {
            this.generateForDevices(devices);
        });
    }

    // build a yellow sphere entity (not yet added to the scene)
    private makeMarkerEntity(position: Vec3): Entity {
        const { scene } = this;

        // size relative to the scene so the marker is visible at any scale.
        // kept small (under half the previous size) per design.
        const sceneRadius = scene.bound.halfExtents.length();
        const radius = Math.max(sceneRadius * 0.002 / 3, 0.0005 / 3);

        const entity = new Entity('samplePoint');
        entity.addComponent('render', {
            type: 'sphere'
        });

        const material = new StandardMaterial();
        material.diffuse = new Color(1, 1, 0);  // yellow
        material.emissive = new Color(1, 1, 0);
        material.metalness = 0;
        material.update();

        entity.render.meshInstances[0].material = material;
        entity.render.layers = [scene.worldLayer.id];

        // sphere primitive has radius 0.5, so scale = radius * 2
        const s = radius * 2;
        entity.setLocalScale(s, s, s);
        entity.setLocalPosition(position);

        return entity;
    }

    // build a turn point sphere entity (not yet added to the scene): smaller
    // than a photo waypoint (60% radius) and orange so the two read apart
    private makeTurnPointEntity(position: Vec3): Entity {
        const { scene } = this;

        // 拍照航点小球半径的 80%（同一套场景尺度逻辑），颜色与拍照航点一致
        const sceneRadius = scene.bound.halfExtents.length();
        const radius = Math.max(sceneRadius * 0.002 / 3, 0.0005 / 3) * 0.8;

        const entity = new Entity('turnpoint');
        entity.addComponent('render', { type: 'sphere' });

        const material = new StandardMaterial();
        const color = levelColor(SafetyLevel.safe);
        material.diffuse = color;
        material.emissive = color;
        material.metalness = 0;
        material.update();

        entity.render.meshInstances[0].material = material;
        entity.render.layers = [scene.worldLayer.id];

        const s = radius * 2;
        entity.setLocalScale(s, s, s);
        entity.setLocalPosition(position);

        return entity;
    }

    // 转折点的休止色：与拍照航点同一套安全分级配色（正常蓝、危险红），
    // 视觉上只靠更小的尺寸区分类型
    private turnColor(level: SafetyLevel): Color {
        return levelColor(level);
    }

    // set a turn point marker's colour from its measured safety level
    private applyTurnLevel(marker: Entity, level: SafetyLevel) {
        this.markerLevels.set(marker, level);
        if (!marker.render) return;
        const material = marker.render.meshInstances[0].material as StandardMaterial;
        const color = this.turnColor(level);
        material.diffuse = color;
        material.emissive = color;
        material.update();
    }

    // 起飞点/返航点小球实体（未加入场景）：绿色，比拍照航点略小（80% 半径，
    // 与转折点同一套场景尺度逻辑）
    private makeHomePointEntity(position: Vec3): Entity {
        const { scene } = this;

        const sceneRadius = scene.bound.halfExtents.length();
        const radius = Math.max(sceneRadius * 0.002 / 3, 0.0005 / 3) * 0.8;

        const entity = new Entity('homepoint');
        entity.addComponent('render', { type: 'sphere' });

        const material = new StandardMaterial();
        material.diffuse = HOME_COLOR.clone();
        material.emissive = HOME_COLOR.clone();
        material.metalness = 0;
        material.update();

        entity.render.meshInstances[0].material = material;
        entity.render.layers = [scene.worldLayer.id];

        const s = radius * 2;
        entity.setLocalScale(s, s, s);
        entity.setLocalPosition(position);

        return entity;
    }

    // 在拾取命中点放置起飞点/返航点（route.home.requestPlace 进入的放置
    // 状态下点击场景触发），随后重绘航线并触发完整校验
    private placeHomePoint(position: Vec3) {
        if (this.homePoint || !this.routeEntity) return;

        // 挂在 routeEntity 下，与拍照航点同层，随航线一起清除
        this.homePoint = this.makeHomePointEntity(position);
        this.routeEntity.addChild(this.homePoint);

        // 退出放置状态并广播：先复位按钮，再通知列表切换为信息行
        this.homePlacing = false;
        this.events.fire('route.home.placing', false);
        this.events.fire('route.home.state', this.homePoint);

        // 重绘航线（含首尾起飞点接线）并走完整校验管线刷新报告
        this.updateRouteLine();
        this.scene.forceRender = true;
    }

    // highlight a marker: sky blue for waypoints / home point, orange for sample points
    private highlightMarker(marker: Entity) {
        if (!marker.render) return;
        const material = marker.render.meshInstances[0].material as StandardMaterial;
        const isWaypoint = marker.name === 'waypoint' || marker.name === 'turnpoint' || marker.name === 'homepoint';
        const color = isWaypoint ? new Color(0, 0.8, 1) : new Color(1, 0.5, 0);
        material.diffuse = color;
        material.emissive = color;
        material.update();
        this.scene.forceRender = true;
    }

    // unhighlight a marker: restore its base color (yellow for sample points,
    // safety-graded blue/amber/red for waypoints, orange/red for turn points,
    // green for the home point)
    private unhighlightMarker(marker: Entity) {
        if (!marker.render) return;
        const material = marker.render.meshInstances[0].material as StandardMaterial;
        let restore: Color;
        if (marker.name === 'homepoint') {
            restore = HOME_COLOR.clone();
        } else if (marker.name === 'turnpoint') {
            restore = this.turnColor(this.markerLevels.get(marker) ?? SafetyLevel.unknown);
        } else if (marker.name === 'waypoint') {
            restore = levelColor(this.markerLevels.get(marker) ?? SafetyLevel.unknown);
        } else {
            restore = new Color(1, 1, 0);
        }
        material.diffuse = restore;
        material.emissive = restore;
        material.update();
        this.scene.forceRender = true;
    }

    // fly the camera to a marker, keeping the current zoom when it is already
    // close enough to make out the marker
    private focusMarker(marker: Entity) {
        if (!marker) return;

        const { scene } = this;
        const camera = scene.camera;
        const sceneRadius = scene.bound.halfExtents.length();
        const currentRadius = camera.distance * sceneRadius / camera.fovFactor;
        const radius = Math.min(currentRadius, sceneRadius * 0.08);

        camera.focus({
            focalPoint: marker.getPosition(),
            radius,
            speed: 1
        });

        scene.forceRender = true;
    }

    // P2: keep a dragged waypoint out of danger. Returns the position actually
    // applied (snapped, or the previous one when no safe spot was reachable).
    private snapWaypoint(marker: Entity, previous: Vec3): Vec3 {
        if (!this.clearance.ready) {
            return marker.getLocalPosition().clone();
        }

        const { position, ok } = snapToSafe(this.clearance, marker.getLocalPosition(), this.clearance.config);
        marker.setLocalPosition(ok ? position : previous);

        return marker.getLocalPosition().clone();
    }

    // set a waypoint marker's colour from its measured safety level
    private applyMarkerLevel(marker: Entity, level: SafetyLevel) {
        this.markerLevels.set(marker, level);
        if (!marker.render) return;
        const material = marker.render.meshInstances[0].material as StandardMaterial;
        const color = levelColor(level);
        material.diffuse = color;
        material.emissive = color;
        material.update();
    }

    // create a marker and register it as an undoable operation
    private createMarker(position: Vec3, normal: Vec3) {
        if (!this.root) return;

        const marker = this.makeMarkerEntity(position);

        // compute WGS84 coordinates if geo metadata is available
        const wgs84 = this.sceneToWgs84(position);

        const data: SamplePointCreatedData = {
            position: position.clone(),
            normal: normal.clone(),
            wgs84: wgs84 ? { ...wgs84 } : null,
            markerEntity: marker
        };

        // edit.add calls op.do() which adds the marker to the scene and fires
        // 'samplePoint.created'; the edit history replays do()/undo() on
        // redo/undo so the panel row follows the marker both ways
        this.events.fire('edit.add', new AddSamplePointOp(this.root, marker, this.scene, this.events, data));
        this.scene.forceRender = true;

        if (wgs84) {
            // eslint-disable-next-line no-console
            console.log(
                `[SamplePoint] WGS84: lat=${wgs84.lat.toFixed(8)}, lon=${wgs84.lon.toFixed(8)}, alt=${wgs84.alt.toFixed(3)}`
            );
        } else {
            // eslint-disable-next-line no-console
            console.log(`[SamplePoint] scene pos: (${position.x.toFixed(3)}, ${position.y.toFixed(3)}, ${position.z.toFixed(3)}) — no geo metadata`);
        }
    }

    // convert a scene-space position to WGS84 (lat/lon/alt) using LCC geo metadata.
    // transform chain: scenePos → (inverse splat worldTransform) → LCC local pos
    //                  → (* scale + shift + offset) → EPSG projected pos
    //                  → proj4 → WGS84
    private sceneToWgs84(scenePos: Vec3): { lat: number; lon: number; alt: number } | null {
        const { scene } = this;
        if (!scene.geoMeta || scene.geoMeta.epsg === 0) {
            return null;
        }

        // get the first splat's entity to recover the LCC→scene rotation
        const splats = scene.getElementsByType(ElementType.splat);
        if (splats.length === 0) {
            return null;
        }
        const splatEntity = (splats[0] as Splat).entity;

        // inverse world transform: scene → LCC local coordinates
        const invTransform = new Mat4().invert(splatEntity.getWorldTransform());
        const lccLocal = new Vec3();
        invTransform.transformPoint(scenePos, lccLocal);

        // apply LCC geo transform: projected = local * scale + shift + offset
        const { epsg, offset, shift, scale } = scene.geoMeta;
        const projX = lccLocal.x * scale[0] + shift[0] + offset[0];
        const projY = lccLocal.y * scale[1] + shift[1] + offset[1];
        const projZ = lccLocal.z * scale[2] + shift[2] + offset[2];

        // convert from EPSG projection to WGS84
        const [lon, lat] = proj4(
            `EPSG:${epsg}`,
            'EPSG:4326',
            [projX, projY]
        );

        return { lat, lon, alt: projZ };
    }

    // 起飞点/返航点导出行：kind:'home'（仅坐标，无云台字段）
    private makeHomeExportRow(index: number): ExportRow {
        const wgs84 = this.sceneToWgs84(this.homePoint!.getLocalPosition());
        return {
            index,
            name: '起飞点/返航点',
            kind: 'home',
            lon: wgs84 ? +wgs84.lon.toFixed(8) : null,
            lat: wgs84 ? +wgs84.lat.toFixed(8) : null,
            alt: wgs84 ? +wgs84.alt.toFixed(3) : null
        };
    }

    // log the waypoint list to the console, each entry with its WGS84
    // lon/lat/alt. positions prefer the live (possibly dragged) marker
    // position, falling back to the generation-time position.
    private exportWaypoints(waypoints: { name: string; position: Vec3; markerEntity: Entity }[]) {
        if (waypoints.length === 0 && !this.homePoint) {
            // eslint-disable-next-line no-console
            console.log('[Waypoint] 没有可导出的航点');
            return;
        }

        // live marker positions keyed by entity (drag-aware); 拍照航点与转折点
        // 都取实体实时位置
        const live = new Map<Entity, Vec3>();
        for (const entry of this.routeEntries) {
            live.set(entry.entity, entry.entity.getLocalPosition().clone());
        }

        const rows: ExportRow[] = [];
        // 有起飞点时首尾各加一行起飞点（kind:'turn'，仅坐标无云台字段），
        // 后续拍照/转折点序号整体顺延
        if (this.homePoint) {
            rows.push(this.makeHomeExportRow(rows.length + 1));
        }
        for (const wp of waypoints) {
            const position = live.get(wp.markerEntity) ?? wp.position;
            const wgs84 = this.sceneToWgs84(position);
            const coord = {
                lon: wgs84 ? +wgs84.lon.toFixed(8) : null,
                lat: wgs84 ? +wgs84.lat.toFixed(8) : null,
                alt: wgs84 ? +wgs84.alt.toFixed(3) : null
            };
            if (wp.markerEntity.name === 'turnpoint') {
                // 转折点：仅位置信息，无云台姿态/拍摄任务
                rows.push({ index: rows.length + 1, name: wp.name, kind: 'turn', ...coord });
            } else {
                rows.push({
                    index: rows.length + 1,
                    name: wp.name,
                    kind: 'shot',
                    ...coord,
                    // gimbal attitude + distances (PRD P1)
                    gimbal: this.cameraRig.getExportData(wp.markerEntity)
                });
            }
        }
        if (this.homePoint) {
            rows.push(this.makeHomeExportRow(rows.length + 1));
        }

        // eslint-disable-next-line no-console
        console.log(`[Waypoint] 航点列表（共 ${rows.length} 个）:`);
        for (const row of rows) {
            const coord = row.lon === null
                ? '无地理元数据（场景坐标不可导出 lon/lat/alt）'
                : `lon=${row.lon}, lat=${row.lat}, alt=${row.alt}`;
            const detail = row.kind === 'shot'
                ? `yaw(相对航线)=${row.gimbal.yaw}° pitch=${row.gimbal.pitch}° focal=${row.gimbal.focal}mm | 对地=${row.gimbal.groundDist}m 拍摄=${row.gimbal.shootDist}m`
                : row.kind === 'turn'
                    ? '转折点（无云台任务）'
                    : '起飞点/返航点（无云台任务）';
            // eslint-disable-next-line no-console
            console.log(`[Waypoint] ${row.name}: ${coord} | ${detail}`);
        }
        // eslint-disable-next-line no-console
        console.log('[Waypoint] export:', rows);
    }

    private selectMarker(marker: Entity) {
        this.selectedMarker = marker;
        this.gizmo.attach(marker);
        if (marker.name === 'homepoint') {
            // 起飞点没有云台任务：云台 rig 不识别 homepoint（会被当作取消
            // 选中），先清掉上一个航点的视锥/画中画，再按转折点同款语义
            // （kind:'turn'）通知编辑面板进入仅位置调整模式
            this.cameraRig.deselect();
            const position = marker.getLocalPosition();
            const bound = this.scene.bound;
            this.events.fire('waypointAttitude.selected', {
                marker,
                position: position.clone(),
                groundDist: +(position.y - (bound.center.y - bound.halfExtents.y)).toFixed(3),
                kind: 'turn' as const
            });
        } else {
            // waypoints drive the gimbal rig (frustum + preview); sample points
            // just get the gizmo
            this.cameraRig.select(marker);
        }
        this.scene.forceRender = true;
    }

    private deselectMarker() {
        const wasHome = this.selectedMarker?.name === 'homepoint';
        this.selectedMarker = null;
        this.gizmo.detach();
        this.dragStartPos = null;
        this.cameraRig.deselect();
        if (wasHome) {
            // 起飞点选中未经过云台 rig，rig 的取消选中不会广播，这里补发
            // 取消选中让编辑面板收起
            this.events.fire('waypointAttitude.selected', { marker: null });
        }
        this.scene.forceRender = true;
    }

    // find the marker closest to the given screen-space pixel coordinate
    private pickMarker(px: number, py: number): Entity | null {
        const cameraPos = this.scene.camera.mainCamera.getPosition();
        const cameraFwd = this.scene.camera.mainCamera.forward;
        const w = this.canvasContainer.clientWidth;
        const h = this.canvasContainer.clientHeight;

        let closest: Entity | null = null;
        let closestDist = MARKER_PICK_RADIUS;

        const check = (marker: Entity) => {
            marker.getWorldTransform().getTranslation(tmpWorld);

            // ignore markers behind the camera (their projection is mirrored)
            tmpDir.sub2(tmpWorld, cameraPos);
            if (tmpDir.dot(cameraFwd) <= 0) {
                return;
            }

            this.scene.camera.worldToScreen(tmpWorld, tmpScreen);
            const sx = tmpScreen.x * w;
            const sy = tmpScreen.y * h;
            const dist = Math.hypot(sx - px, sy - py);

            if (dist < closestDist) {
                closestDist = dist;
                closest = marker;
            }
        };

        // check sample points
        if (this.root) {
            for (const child of this.root.children) {
                check(child as Entity);
            }
        }

        // check waypoints (photo waypoints + turn points + home point)
        if (this.routeEntity) {
            for (const child of this.routeEntity.children) {
                const name = (child as Entity).name;
                if (name === 'waypoint' || name === 'turnpoint' || name === 'homepoint') {
                    check(child as Entity);
                }
            }
        }

        return closest;
    }

    private clearMarkers() {
        this.deselectMarker();
        this.clearRoute();
        if (this.root) {
            for (const child of [...this.root.children]) {
                (child as Entity).destroy();
            }
        }
    }

    // remove an existing generated route
    private clearRoute() {
        this.deselectMarker();
        this.cameraRig.routeCleared();
        this.markerLevels.clear();
        this.legCache.clear();
        // 转折点条目随 routeEntity 一并销毁，扁平条目序列同步清空
        this.routeEntries = [];
        this.legKeys = [];
        // 起飞点随航线一并销毁；复位放置状态并广播给航点列表
        if (this.homePoint) {
            this.homePoint.destroy();
            this.homePoint = null;
        }
        this.homePlacing = false;
        this.events.fire('route.home.state', null);
        this.events.fire('route.home.placing', false);
        this.overlay.clear();
        this.debugPoints = null;
        this.debugNormals = null;
        this.lastReport = null;
        if (this.routeEntity) {
            this.routeEntity.destroy();
            this.routeEntity = null;
        }
        this.routeEditMode = false;
        this.scene.forceRender = true;
    }

    // 按航线顺序取当前全部条目（拍照航点 + 转折点），位置为实体实时位置
    private currentEntries(): { kind: 'shot' | 'turn'; entity: Entity; position: Vec3 }[] {
        return this.routeEntries.map((entry) => ({
            kind: entry.kind,
            entity: entry.entity,
            position: entry.entity.getLocalPosition().clone()
        }));
    }

    // leg 端点键（与 getLegPlan 的缓存键同一格式）
    private legKeyOf(a: Vec3, b: Vec3): string {
        return `${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}|${b.x.toFixed(3)},${b.y.toFixed(3)},${b.z.toFixed(3)}`;
    }

    // 绕行折线（a → detour → b）的顶点精简：以净空为准则贪心合并——从起点
    // 出发，只要"跳过当前顶点直连下一个顶点"的弦的实测净空低于硬性要求，
    // 就必须保留当前顶点作为转折点。旧的"夹角>20°才保留"规则会把小角度
    // 但必要的中继点/缓弯顶点丢掉，丢完后剩余直连弦直接切穿障碍——表现
    // 为最小间距骤降、航线上看不出任何绕行
    private significantTurns(a: Vec3, detour: Vec3[], b: Vec3): Vec3[] {
        const pts = [a, ...detour, b];
        if (pts.length <= 2) return [];
        const hard = hardClearance(this.clearance.config);
        const out: Vec3[] = [];
        let anchor = 0; // 最近一个保留顶点（或起点）的下标
        for (let i = 1; i < pts.length - 1; i++) {
            const chord = this.clearance.segmentMinClearance(pts[anchor], pts[i + 1]);
            if (chord.clearance < hard) {
                out.push(pts[i].clone());
                anchor = i;
            }
        }
        return out;
    }

    // 逐拍照航段规划并把显著转折顶点同步为转折点条目（与拍照航点按序混排）。
    // 返回条目集合是否发生了可见变化（创建/销毁/移动）。
    // 端点没动的航段直接跳过规划：拖动转折点后的重新校验因此不会把用户
    // 放置的位置覆盖回规划结果（重绕行只发生在拍照航点被拖动之后）。
    private reconcileTurnPoints(): boolean {
        const shots = this.routeEntries.filter(e => e.kind === 'shot');

        // 按拍照航点分段收集现有转折条目（尾部游离转折点按约定不应存在，销毁兜底）
        const oldsPerLeg: RouteEntry[][] = [];
        let pending: RouteEntry[] = [];
        for (const entry of this.routeEntries) {
            if (entry.kind === 'shot') {
                oldsPerLeg.push(pending);
                pending = [];
            } else {
                pending.push(entry);
            }
        }
        for (const stale of pending) {
            stale.entity.destroy();
        }

        const rebuilt: RouteEntry[] = [];
        let changed = false;
        for (let li = 0; li < shots.length; li++) {
            rebuilt.push(shots[li]);
            if (li === shots.length - 1) break;

            const a = shots[li].entity.getLocalPosition();
            const b = shots[li + 1].entity.getLocalPosition();
            const key = this.legKeyOf(a, b);
            const olds = oldsPerLeg[li] ?? [];

            if (this.legKeys[li] === key) {
                // 该航段端点未动：保留现有转折条目（含用户拖动后的位置）
                for (const old of olds) rebuilt.push(old);
                continue;
            }
            this.legKeys[li] = key;

            // 拍照航点被拖动后重新 planLeg：新 detour 的转折点替换旧转折条目
            const plan = this.getLegPlan(a, b);
            const desired = plan.detour && plan.detour.length > 0
                ? this.significantTurns(a, plan.detour, b)
                : [];

            if (olds.length === desired.length && desired.length > 0) {
                // 数量一致：原地复用实体并更新位置，保持选中态/材质等身份
                for (let k = 0; k < desired.length; k++) {
                    const entry = olds[k];
                    if (!entry.entity.getLocalPosition().equals(desired[k])) {
                        changed = true;
                    }
                    entry.entity.setLocalPosition(desired[k]);
                    rebuilt.push(entry);
                }
            } else {
                // 数量变化：销毁重建，保持段内顺序
                for (const old of olds) {
                    old.entity.destroy();
                    changed = true;
                }
                for (const p of desired) {
                    const entity = this.makeTurnPointEntity(p);
                    this.routeEntity!.addChild(entity);
                    rebuilt.push({ kind: 'turn', entity });
                    changed = true;
                }
            }
        }

        this.routeEntries = rebuilt;

        // 兜底清扫：routeEntity 下任何不在此序列里的转折点实体都是孤儿
        // （拖动重规划等任何路径导致序列与实体脱节时，旧小球会残留在场景
        // 里且无人销毁），统一销毁，保证场景与条目序列最终一致
        const tracked = new Set(this.routeEntries.map((e) => e.entity));
        for (const child of [...this.routeEntity!.children]) {
            if (child.name === 'turnpoint' && !tracked.has(child as Entity)) {
                (child as Entity).destroy();
                changed = true;
            }
        }
        return changed;
    }

    // 把当前条目序列（含转折点）按序广播给面板，供其重建航点列表行
    private fireRouteEntries() {
        const data: RouteEntryData[] = this.routeEntries.map((entry) => ({
            marker: entry.entity,
            kind: entry.kind,
            position: entry.entity.getLocalPosition().clone()
        }));
        this.events.fire('route.entries', data, this.routeSource);
    }

    // ── device bounding box (device ledger panel) ──

    // inverse of sceneToWgs84: EPSG projected coords (easting, northing, alt)
    // → LCC local pos → scene space. requires geoMeta and at least one splat.
    private projectedToScene(projX: number, projY: number, projZ: number, splatEntity: Entity): Vec3 {
        const { offset, shift, scale } = this.scene.geoMeta!;
        const local = new Vec3(
            (projX - offset[0] - shift[0]) / scale[0],
            (projY - offset[1] - shift[1]) / scale[1],
            (projZ - offset[2] - shift[2]) / scale[2]
        );
        return splatEntity.getWorldTransform().transformPoint(local);
    }

    // draw the 12-edge wireframe of the device bounding box given as 8 corner
    // points in EPSG projected coordinates (two quads: 0-3 and 4-7)
    private showDeviceBox(bounding: number[][]) {
        this.hideDeviceBox();

        const { scene } = this;
        if (!scene.geoMeta || scene.geoMeta.epsg === 0 || !bounding || bounding.length !== 8) {
            // eslint-disable-next-line no-console
            console.warn('[DeviceLedger] 无法绘制包围框：缺少地理元数据或数据格式不正确');
            return;
        }
        const splats = scene.getElementsByType(ElementType.splat);
        if (splats.length === 0) {
            return;
        }
        const splatEntity = (splats[0] as Splat).entity;

        const corners = bounding.map((p) => this.projectedToScene(p[0], p[1], p[2], splatEntity));

        const edgePairs = [
            [0, 1], [1, 2], [2, 3], [3, 0],
            [4, 5], [5, 6], [6, 7], [7, 4],
            [0, 4], [1, 5], [2, 6], [3, 7]
        ];
        const positions: number[] = [];
        for (const [a, b] of edgePairs) {
            positions.push(
                corners[a].x, corners[a].y, corners[a].z,
                corners[b].x, corners[b].y, corners[b].z
            );
        }

        const mesh = new Mesh(scene.graphicsDevice);
        mesh.setPositions(positions);
        mesh.update(PRIMITIVE_LINES);

        // overlay layer so the box stays visible through the gaussians
        const entity = new Entity('deviceBox');
        entity.addComponent('render', { meshInstances: [new MeshInstance(mesh, this.deviceBoxMaterial)] });
        entity.render.layers = [scene.overlayLayer.id];
        scene.app.root.addChild(entity);

        this.deviceBoxEntity = entity;
        this.deviceBoxMesh = mesh;

        // fly the camera to frame the device (AABB center, half-diagonal radius)
        const minC = new Vec3(Infinity, Infinity, Infinity);
        const maxC = new Vec3(-Infinity, -Infinity, -Infinity);
        for (const c of corners) {
            minC.x = Math.min(minC.x, c.x);
            minC.y = Math.min(minC.y, c.y);
            minC.z = Math.min(minC.z, c.z);
            maxC.x = Math.max(maxC.x, c.x);
            maxC.y = Math.max(maxC.y, c.y);
            maxC.z = Math.max(maxC.z, c.z);
        }
        const center = maxC.clone().add(minC).mulScalar(0.5);
        const halfExtents = maxC.clone().sub(minC).mulScalar(0.5);
        scene.camera.focus({
            focalPoint: center,
            radius: halfExtents.length() * 1.2,
            speed: 1
        });

        scene.forceRender = true;
    }

    private hideDeviceBox() {
        this.deviceBoxEntity?.destroy();
        this.deviceBoxMesh?.destroy();
        this.deviceBoxEntity = null;
        this.deviceBoxMesh = null;
        this.scene.forceRender = true;
    }

    // generate a route from device ledger sample points: convert each device's
    // projected sample coords to scene space (up-facing hover normals) and run
    // the same generateRoute pipeline as the sample point panel
    private generateForDevices(devices: { name: string; samplePoint: number[][] }[]) {
        const { scene } = this;
        if (!scene.geoMeta || scene.geoMeta.epsg === 0) {
            // eslint-disable-next-line no-console
            console.warn('[DeviceLedger] 无法生成航线：缺少地理元数据');
            return;
        }
        const splats = scene.getElementsByType(ElementType.splat);
        if (splats.length === 0) {
            return;
        }
        const splatEntity = (splats[0] as Splat).entity;

        const points: { position: Vec3; normal: Vec3 }[] = [];
        for (const device of devices) {
            for (const sp of device.samplePoint) {
                points.push({
                    position: this.projectedToScene(sp[0], sp[1], sp[2], splatEntity),
                    normal: new Vec3(0, 1, 0)
                });
            }
        }
        if (points.length === 0) {
            // eslint-disable-next-line no-console
            console.warn('[DeviceLedger] 所选设备没有采样点');
            return;
        }

        // generateRoute requires the lazy marker root; create it like activate()
        if (!this.root) {
            this.root = new Entity('samplePoints');
            scene.app.root.addChild(this.root);
        }

        // eslint-disable-next-line no-console
        console.log(`[DeviceLedger] 为 ${devices.length} 台设备生成航点及航线（${points.length} 个采样点）`);
        this.generateRoute(points, 'device');
    }

    // ── route planning + validation ──

    // plan a single leg: detour waypoints (null when it stays straight) plus the
    // measured worst clearance along the resulting polyline
    private planLeg(a: Vec3, b: Vec3): LegPlan {
        const detour = planDetour(this.clearance, a, b, this.clearance.config);

        const leg: Vec3[] = [a.clone()];
        if (detour) {
            for (const p of detour) {
                leg.push(p.clone());
            }
        }
        leg.push(b.clone());

        let min = Infinity;
        let minPoint = a;
        for (let k = 0; k < leg.length - 1; k++) {
            const result = this.clearance.segmentMinClearance(leg[k], leg[k + 1]);
            if (result.clearance >= 0 && result.clearance < min) {
                min = result.clearance;
                minPoint = result.point;
            }
        }

        return {
            detour: detour ? detour.map(p => p.clone()) : null,
            clearance: min === Infinity ? -1 : min,
            point: minPoint.clone()
        };
    }

    // cached leg lookup — this is what keeps dragging responsive: only the two
    // legs touching the moved waypoint miss the cache
    private getLegPlan(a: Vec3, b: Vec3): LegPlan {
        const key = this.legKeyOf(a, b);

        const cached = this.legCache.get(key);
        if (cached) return cached;

        const plan = this.planLeg(a, b);
        this.legCache.set(key, plan);

        // bound the cache (Map preserves insertion order, so the front is oldest)
        if (this.legCache.size > LEG_CACHE_LIMIT) {
            const keys = [...this.legCache.keys()].slice(0, LEG_CACHE_LIMIT >> 1);
            for (const k of keys) {
                this.legCache.delete(k);
            }
        }

        return plan;
    }

    // request a re-plan; collapses bursts into a single pending run
    private scheduleValidation() {
        if (this.validating) {
            this.validationQueued = true;
            return;
        }
        this.updateRoute();
    }

    // Plan the legs between the photo waypoints (P2), promote the significant
    // detour vertices to turn point entries, then measure and draw everything
    // along the flat entry sequence. Waypoint positions are only changed by
    // explicit snapping, never here.
    private async updateRoute() {
        if (this.validating) {
            this.validationQueued = true;
            return;
        }
        this.validating = true;

        try {
            const ready = await this.clearance.ensureBuilt(this.scene);

            // a rebuilt obstacle field invalidates every cached leg — and every
            // leg key, so all legs re-plan and the turn points follow the new
            // detours (unchanged endpoints would otherwise keep stale detours)
            if (this.clearance.version !== this.cachedFieldVersion) {
                this.cachedFieldVersion = this.clearance.version;
                this.legCache.clear();
                this.legKeys = [];
            }

            // the route may have been cleared while the field was building
            if (!this.routeEntity) return;

            const report: RouteSafetyReport = {
                ready,
                hardClearance: this.clearance.hardClearance,
                waypoints: [],
                segments: [],
                minClearance: -1,
                dangerCount: 0
            };

            if (!ready) {
                // nothing measurable — keep the existing entries (they are part
                // of the flat route) and tell the panel the measurement is
                // unavailable
                const entries = this.currentEntries();
                if (entries.length === 0) return;
                for (const entry of entries) {
                    report.waypoints.push({ entity: entry.entity, clearance: -1, level: SafetyLevel.unknown });
                }
                this.drawRoute(entries.map(e => e.position));
                this.overlay.drawDistanceIndicators(entries, report);
                this.fireRouteEntries();
                this.lastReport = report;
                this.events.fire('route.validated', report);
                return;
            }

            // plan each photo leg and sync its significant detour vertices as
            // turn point entries (results are cached by endpoints, so moving
            // one waypoint only re-plans the legs that actually changed)
            this.reconcileTurnPoints();

            // the route may have had no solvable waypoints at all
            const entries = this.currentEntries();
            if (entries.length === 0) return;

            // 每个条目（拍照航点 + 转折点）单独量测净空并着色
            for (const entry of entries) {
                const clearance = this.clearance.clearance(entry.position);
                const level = this.clearance.level(clearance);
                if (entry.kind === 'turn') {
                    this.applyTurnLevel(entry.entity, level);
                } else {
                    this.applyMarkerLevel(entry.entity, level);
                }
                report.waypoints.push({ entity: entry.entity, clearance, level });
            }

            // 相邻条目间的直线段逐一量测；每个拍照航段（两个拍照航点之间）
            // 的 report.segments 记录取其子段最小净空（结构与原实现一致）。
            // 画线路径 = 全部条目位置依次连线（转折点即绕行路径的骨架）
            const path: Vec3[] = entries.map(e => e.position.clone());
            let legIndex = -1;
            let legMin = Infinity;
            const legPoint = new Vec3();
            for (let i = 0; i < entries.length - 1; i++) {
                if (entries[i].kind === 'shot') {
                    // 遇到拍照航点：闭合上一拍照航段
                    if (legIndex >= 0) {
                        report.segments.push({
                            index: legIndex,
                            clearance: legMin === Infinity ? -1 : legMin,
                            level: this.clearance.level(legMin === Infinity ? -1 : legMin),
                            point: legPoint.clone()
                        });
                    }
                    legIndex++;
                    legMin = Infinity;
                    legPoint.copy(entries[i].position);
                }
                const result = this.clearance.segmentMinClearance(entries[i].position, entries[i + 1].position);
                if (result.clearance >= 0 && result.clearance < legMin) {
                    legMin = result.clearance;
                    legPoint.copy(result.point);
                }
            }
            // 闭合最后一个拍照航段
            if (legIndex >= 0) {
                report.segments.push({
                    index: legIndex,
                    clearance: legMin === Infinity ? -1 : legMin,
                    level: this.clearance.level(legMin === Infinity ? -1 : legMin),
                    point: legPoint.clone()
                });
            }

            const measured = [
                ...report.waypoints.map(w => w.clearance),
                ...report.segments.map(s => s.clearance)
            ].filter(c => c >= 0);

            report.minClearance = measured.length ? Math.min(...measured) : -1;
            report.dangerCount = report.waypoints.filter(x => x.level === SafetyLevel.danger).length;

            this.drawRoute(path);
            this.overlay.drawDistanceIndicators(entries, report);
            this.scene.forceRender = true;
            this.fireRouteEntries();
            this.lastReport = report;
            this.events.fire('route.validated', report);
        } finally {
            this.validating = false;
            if (this.validationQueued) {
                this.validationQueued = false;
                this.updateRoute();
            }
        }
    }

    // the route visuals (tube, arrows) are drawn by the overlay
    private drawRoute(path: Vec3[]) {
        // 起飞点接线：路径首尾各接起飞点（起飞→首个拍照点、末拍照点→返航，
        // overlay 里这两段以蓝色绘制）；没有拍照航点时只剩起飞点自身
        // （path 长度 1，overlay 只画关节球不画管）
        if (this.homePoint) {
            const home = this.homePoint.getLocalPosition().clone();
            path = path.length > 0 ? [home, ...path, home] : [home];
        }
        this.overlay.setRoute(path, !!this.homePoint);
    }

    // redraw the route from the current entry positions (含转折点) and re-plan it
    private updateRouteLine() {
        this.drawRoute(this.routeEntries.map(e => e.entity.getLocalPosition().clone()));
        this.scene.forceRender = true;
        this.scheduleValidation();
    }

    // 转折点移动后的轻量更新：重画航线（管线网格重建，开销小、不动任何
    // 条目），并只重测与该转折点相连的航段——它始终夹在两个拍照航点之间，
    // 即所属拍照航段的全部子段；其余航段沿用上次完整校验的结果。不重新
    // 规划、不重建条目、不整体重测
    private updateForTurnMove(turn: Entity) {
        const idx = this.routeEntries.findIndex((e) => e.entity === turn);
        const entries = this.currentEntries();
        if (idx < 0 || entries.length === 0) {
            this.updateRouteLine();
            return;
        }
        this.drawRoute(entries.map((e) => e.position.clone()));
        this.scene.forceRender = true;

        const report = this.lastReport;
        if (!report || !report.ready || report.waypoints.length !== entries.length) {
            // 没有可增量更新的报告（尚未完成过完整校验）：退回完整校验
            this.scheduleValidation();
            return;
        }

        // 转折点自身净空
        const own = this.clearance.clearance(entries[idx].position);
        const ownLevel = this.clearance.level(own);
        this.applyTurnLevel(turn, ownLevel);
        report.waypoints[idx] = { entity: turn, clearance: own, level: ownLevel };

        // 所属拍照航段：前后最近的拍照航点之间的全部子段重测取最小
        let prevShot = -1;
        for (let i = idx - 1; i >= 0; i--) {
            if (entries[i].kind === 'shot') { prevShot = i; break; }
        }
        let nextShot = -1;
        for (let i = idx + 1; i < entries.length; i++) {
            if (entries[i].kind === 'shot') { nextShot = i; break; }
        }
        if (prevShot >= 0 && nextShot >= 0) {
            // 航段序号 = 该拍照航点之前已有的拍照航段数
            let legIndex = 0;
            for (let i = 0; i < prevShot; i++) {
                if (entries[i].kind === 'shot') legIndex++;
            }
            let legMin = Infinity;
            const legPoint = new Vec3();
            for (let i = prevShot; i < nextShot; i++) {
                const result = this.clearance.segmentMinClearance(entries[i].position, entries[i + 1].position);
                if (result.clearance >= 0 && result.clearance < legMin) {
                    legMin = result.clearance;
                    legPoint.copy(result.point);
                }
            }
            report.segments[legIndex] = {
                index: legIndex,
                clearance: legMin === Infinity ? -1 : legMin,
                level: this.clearance.level(legMin === Infinity ? -1 : legMin),
                point: legPoint.clone()
            };
        }

        // 汇总指标与距离指示线刷新（指示线绘制便宜，全量重画保持一致）
        const measured = [
            ...report.waypoints.map((w) => w.clearance),
            ...report.segments.map((s) => s.clearance)
        ].filter((c) => c >= 0);
        report.minClearance = measured.length ? Math.min(...measured) : -1;
        report.dangerCount = report.waypoints.filter((w) => w.level === SafetyLevel.danger).length;

        this.overlay.drawDistanceIndicators(entries, report);
        this.fireRouteEntries();
        this.events.fire('route.validated', report);
    }

    // Generate waypoints from sample points.
    // P1: instead of a blind offset along the (camera-derived) normal, each
    // hover point is solved from the real surface normal with a cap search that
    // only accepts candidates satisfying the hard clearance and keeping sight of
    // their target. Points with no safe solution are skipped and reported.
    private async generateRoute(points: { position: Vec3; normal: Vec3; marker?: Entity }[], source: 'panel' | 'device' = 'panel') {
        this.clearRoute();

        if (!this.root || points.length === 0) return;

        const { scene } = this;
        const ready = await this.clearance.ensureBuilt(scene);

        // the tool or scene may have gone away while the field was building
        if (!this.root) return;

        // 当前航线来源随 route.generated / route.entries 广播，面板据此过滤
        this.routeSource = source;

        const routeEntity = new Entity('sampleRoute');

        // size for waypoint markers (same scale logic as sample points)
        const sceneRadius = scene.bound.halfExtents.length();
        const wpRadius = Math.max(sceneRadius * 0.002 / 3, 0.0005 / 3);
        const wpScale = wpRadius * 2;

        const waypointData: { position: Vec3; markerEntity: Entity; viewDir: Vec3; subject: Vec3; subjectMarker?: Entity }[] = [];
        const unsolvable: number[] = [];
        // per-point normal the solver oriented and searched around (debug draw)
        const debugNormals: Vec3[] = [];

        for (let i = 0; i < points.length; i++) {
            const point = points[i];

            let hoverPos: Vec3;
            if (ready) {
                const solved = solveHoverPoint(this.clearance, point.position, point.normal, this.clearance.config);
                // remember the oriented normal even for skipped points — that
                // is exactly where a wrong direction shows up
                debugNormals.push(solved.normal);
                if (!solved.ok) {
                    // no safe hover point exists: skip it rather than emitting a
                    // waypoint that would fly into the model
                    unsolvable.push(i);
                    continue;
                }
                hoverPos = solved.position;
            } else {
                debugNormals.push(point.normal);
                // no obstacle field: fall back to the plain normal offset
                const offset = this.clearance.config.hoverDistance;
                hoverPos = new Vec3(
                    point.position.x + point.normal.x * offset,
                    point.position.y + point.normal.y * offset,
                    point.position.z + point.normal.z * offset
                );
            }

            // waypoint marker (colour is set by the safety validation)
            const wp = new Entity('waypoint');
            wp.addComponent('render', { type: 'sphere' });
            const mat = new StandardMaterial();
            mat.diffuse = new Color(0, 0.5, 1);
            mat.emissive = new Color(0, 0.5, 1);
            mat.metalness = 0;
            mat.update();
            wp.render.meshInstances[0].material = mat;
            wp.render.layers = [scene.worldLayer.id];
            wp.setLocalScale(wpScale, wpScale, wpScale);
            wp.setLocalPosition(hoverPos);
            routeEntity.addChild(wp);
            // 扁平条目序列：拍照航点按生成顺序入列，转折点由校验阶段插入
            this.routeEntries.push({ kind: 'shot', entity: wp });

            // initial gimbal aim: from the hover point towards the sampled
            // surface point (the subject the waypoint is supposed to shoot)
            const viewDir = new Vec3().sub2(point.position, hoverPos).normalize();

            waypointData.push({ position: hoverPos.clone(), markerEntity: wp, viewDir, subject: point.position.clone(), subjectMarker: point.marker });
        }

        scene.app.root.addChild(routeEntity);
        this.routeEntity = routeEntity;

        this.overlay.setNormalDebug(points, debugNormals);
        this.debugPoints = points;
        this.debugNormals = debugNormals;
        this.debugFieldReady = ready;
        this.overlay.createDistEntity();

        scene.forceRender = true;

        // notify listeners of the generated waypoints ('panel' = sample point
        // panel folder, 'device' = device ledger panel)
        this.events.fire('route.generated', waypointData, source);
        if (unsolvable.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(`[SamplePoint] ${unsolvable.length} 个采样点找不到安全悬停点，已跳过：索引 ${unsolvable.join(', ')}`);
            this.events.fire('route.unsolvable', unsolvable);
        }

        // plan, draw and measure the route
        this.updateRouteLine();
    }
}

export { SamplePointTool };
