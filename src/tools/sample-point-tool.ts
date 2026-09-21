import { Color, Entity, Mat4, Mesh, MeshInstance, PRIMITIVE_LINES, StandardMaterial, TranslateGizmo, Vec3 } from 'playcanvas';
import proj4 from 'proj4';

import { EditOp } from '../edit-ops';
import { ElementType } from '../element';
import { Events } from '../events';
import { ClearanceField, RouteSafetyReport } from '../route/clearance-field';
import { planDetour, snapToSafe, solveHoverPoint } from '../route/route-planner';
import { SafetyLevel, levelColor } from '../route/safety-config';
import { WaypointCameraRig } from '../route/waypoint-camera';
import { Scene } from '../scene';
import { Splat } from '../splat';

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;

// screen-space pick radius for selecting an existing marker (pixels)
const MARKER_PICK_RADIUS = 12;

// direction chevrons along the route, all relative to the scene extent:
// spacing between chevrons, included angle between the two arms (degrees),
// and the length of each arm; the count is capped as a runaway guard
const ARROW_SPACING = 0.02;     // 箭头间距（场景半径的 1%）
const ARROW_ANGLE = 60;         // 箭头两条边的夹角（度），新增常量
const ARROW_ARM = 0.00061;      // 每条边的长度（场景半径的比例）
const ARROW_MAX_COUNT = 512;   // 数量上限

// temp vectors (module-scope to avoid per-frame allocations)
const tmpScreen = new Vec3();
const tmpWorld = new Vec3();
const tmpDir = new Vec3();
const tmpSide = new Vec3();

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
    // the route connector is drawn as a single line batch (leg safety is not
    // flagged: the drone flies the waypoints in sequence)
    private routeLine: { entity: Entity | null; mesh: Mesh | null } = { entity: null, mesh: null };
    private lineMaterial: StandardMaterial;

    // per-waypoint distance indicators: a line from the waypoint to the closest
    // obstacle point plus a small anchor marker on the model. drawn in the tool
    // overlay layer so they stay visible through the gaussians.
    private distEntity: Entity | null = null;
    private distLine: { entity: Entity | null; mesh: Mesh | null } = { entity: null, mesh: null };
    private distLineDanger: { entity: Entity | null; mesh: Mesh | null } = { entity: null, mesh: null };
    private distMaterial: StandardMaterial;
    private distDangerMaterial: StandardMaterial;
    private distAnchors: Entity[] = [];
    // visibility of the distance indicators (green/red lines + anchors),
    // toggled from the panel and preserved across route regeneration
    private distIndicatorsVisible = true;

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
    // obstacle field version the cache was built against
    private cachedFieldVersion = '';
    // when true, surface clicks don't create new markers; waypoint dragging is enabled
    private routeEditMode = false;
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

        // line materials (created once and reused across rebuilds)
        this.lineMaterial = this.makeLineMaterial(new Color(0, 0.5, 1));
        this.distMaterial = this.makeLineMaterial(new Color(0.098, 1, 0.137));
        this.distDangerMaterial = this.makeLineMaterial(new Color(1, 0.15, 0.1));
        this.deviceBoxMaterial = this.makeLineMaterial(new Color(1, 0.55, 0.05));

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
        events.on('samplePoint.highlight', (marker: Entity) => {
            this.highlightMarker(marker);
        });
        events.on('samplePoint.unhighlight', (marker: Entity) => {
            this.unhighlightMarker(marker);
        });

        // generate waypoints and route line from sample points
        events.on('samplePoint.generateRoute', (points: { position: Vec3; normal: Vec3; marker?: Entity }[]) => {
            this.generateRoute(points);
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
        // position (same handling as a gizmo drag)
        events.on('route.redraw.request', (marker: Entity, position: Vec3) => {
            this.updateRouteLine();
            events.fire('waypoint.moved', marker, position);
        });

        // export the waypoint list (lon/lat/alt) to the console (panel button)
        events.on('waypoint.export', (waypoints: { name: string; position: Vec3; markerEntity: Entity }[]) => {
            this.exportWaypoints(waypoints);
        });

        // show/hide the shortest-distance indicator lines (panel eye button);
        // broadcast the new state so every panel's eye icon stays in sync
        events.on('route.distIndicators', (visible: boolean) => {
            this.distIndicatorsVisible = visible;
            if (this.distEntity) {
                this.distEntity.enabled = visible;
            }
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

    // highlight a marker: sky blue for waypoints, orange for sample points
    private highlightMarker(marker: Entity) {
        if (!marker.render) return;
        const material = marker.render.meshInstances[0].material as StandardMaterial;
        const isWaypoint = marker.name === 'waypoint';
        const color = isWaypoint ? new Color(0, 0.8, 1) : new Color(1, 0.5, 0);
        material.diffuse = color;
        material.emissive = color;
        material.update();
        this.scene.forceRender = true;
    }

    // unhighlight a marker: restore its base color (yellow for sample points,
    // safety-graded blue/amber/red for waypoints)
    private unhighlightMarker(marker: Entity) {
        if (!marker.render) return;
        const material = marker.render.meshInstances[0].material as StandardMaterial;
        const isWaypoint = marker.name === 'waypoint';
        const restore = isWaypoint ?
            levelColor(this.markerLevels.get(marker) ?? SafetyLevel.unknown) :
            new Color(1, 1, 0);
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

    // log the waypoint list to the console, each entry with its WGS84
    // lon/lat/alt. positions prefer the live (possibly dragged) marker
    // position, falling back to the generation-time position.
    private exportWaypoints(waypoints: { name: string; position: Vec3; markerEntity: Entity }[]) {
        if (waypoints.length === 0) {
            // eslint-disable-next-line no-console
            console.log('[Waypoint] 没有可导出的航点');
            return;
        }

        // live marker positions keyed by entity (drag-aware)
        const live = new Map<Entity, Vec3>();
        for (const wp of this.waypointPositions()) {
            live.set(wp.entity, wp.position);
        }

        const rows = waypoints.map((wp, i) => {
            const position = live.get(wp.markerEntity) ?? wp.position;
            const wgs84 = this.sceneToWgs84(position);
            const gimbal = this.cameraRig.getExportData(wp.markerEntity);
            return {
                index: i + 1,
                name: wp.name,
                lon: wgs84 ? +wgs84.lon.toFixed(8) : null,
                lat: wgs84 ? +wgs84.lat.toFixed(8) : null,
                alt: wgs84 ? +wgs84.alt.toFixed(3) : null,
                // gimbal attitude + distances (PRD P1)
                gimbal
            };
        });

        // eslint-disable-next-line no-console
        console.log(`[Waypoint] 航点列表（共 ${rows.length} 个）:`);
        for (const row of rows) {
            const coord = row.lon === null
                ? '无地理元数据（场景坐标不可导出 lon/lat/alt）'
                : `lon=${row.lon}, lat=${row.lat}, alt=${row.alt}`;
            // eslint-disable-next-line no-console
            console.log(`[Waypoint] ${row.name}: ${coord} | yaw(相对航线)=${row.gimbal.yaw}° pitch=${row.gimbal.pitch}° focal=${row.gimbal.focal}mm | 对地=${row.gimbal.groundDist}m 拍摄=${row.gimbal.shootDist}m`);
        }
        // eslint-disable-next-line no-console
        console.log('[Waypoint] export:', rows);
    }

    private selectMarker(marker: Entity) {
        this.selectedMarker = marker;
        this.gizmo.attach(marker);
        // waypoints drive the gimbal rig (frustum + preview); sample points
        // just get the gizmo
        this.cameraRig.select(marker);
        this.scene.forceRender = true;
    }

    private deselectMarker() {
        this.selectedMarker = null;
        this.gizmo.detach();
        this.dragStartPos = null;
        this.cameraRig.deselect();
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

        // check waypoints
        if (this.routeEntity) {
            for (const child of this.routeEntity.children) {
                if ((child as Entity).name === 'waypoint') {
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
        this.disposeLine(this.routeLine);
        this.disposeLine(this.distLine);
        this.disposeLine(this.distLineDanger);
        this.distAnchors.length = 0;
        if (this.routeEntity) {
            this.routeEntity.destroy();
            this.routeEntity = null;
        }
        if (this.distEntity) {
            this.distEntity.destroy();
            this.distEntity = null;
        }
        this.routeEditMode = false;
        this.scene.forceRender = true;
    }

    // ordered list of the waypoints currently in the route
    private waypointPositions(): { entity: Entity; position: Vec3 }[] {
        const result: { entity: Entity; position: Vec3 }[] = [];
        if (!this.routeEntity) return result;
        for (const child of this.routeEntity.children) {
            if ((child as Entity).name === 'waypoint') {
                result.push({
                    entity: child as Entity,
                    position: (child as Entity).getLocalPosition().clone()
                });
            }
        }
        return result;
    }

    // ── route line batches ──

    private makeLineMaterial(color: Color) {
        const material = new StandardMaterial();
        material.diffuse = color;
        material.emissive = color;
        material.metalness = 0;
        material.update();
        return material;
    }

    private disposeLine(line: { entity: Entity | null; mesh: Mesh | null }) {
        if (line.entity) {
            line.entity.destroy();
        }
        if (line.mesh) {
            line.mesh.destroy();
        }
        line.entity = null;
        line.mesh = null;
    }

    // (re)create one line batch. PRIMITIVE_LINES consumes vertex pairs so the
    // safe and unsafe portions of the route can be drawn as separate batches.
    private setLine(parent: Entity | null, line: { entity: Entity | null; mesh: Mesh | null }, name: string, positions: number[], material: StandardMaterial, layerId?: number) {
        this.disposeLine(line);
        if (!parent || positions.length < 2) return;

        const mesh = new Mesh(this.scene.graphicsDevice);
        mesh.setPositions(positions);
        mesh.update(PRIMITIVE_LINES);

        const entity = new Entity(name);
        entity.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)] });
        entity.render.layers = [layerId ?? this.scene.worldLayer.id];
        parent.addChild(entity);

        line.entity = entity;
        line.mesh = mesh;
    }

    private setRouteLine(positions: number[]) {
        if (!this.routeEntity) return;
        this.setLine(this.routeEntity, this.routeLine, 'routeLine', positions, this.lineMaterial);
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
        const key = `${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}|${b.x.toFixed(3)},${b.y.toFixed(3)},${b.z.toFixed(3)}`;

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

    // Plan the legs between waypoints (P2), then measure and draw everything.
    // Waypoint positions are only changed by explicit snapping, never here.
    private async updateRoute() {
        if (this.validating) {
            this.validationQueued = true;
            return;
        }
        this.validating = true;

        try {
            const ready = await this.clearance.ensureBuilt(this.scene);

            // a rebuilt obstacle field invalidates every cached leg
            if (this.clearance.version !== this.cachedFieldVersion) {
                this.cachedFieldVersion = this.clearance.version;
                this.legCache.clear();
            }

            // the route may have been cleared while the field was building
            if (!this.routeEntity) return;

            const waypoints = this.waypointPositions();
            if (waypoints.length === 0) return;

            const report: RouteSafetyReport = {
                ready,
                hardClearance: this.clearance.hardClearance,
                waypoints: [],
                segments: [],
                minClearance: -1,
                dangerCount: 0
            };

            if (!ready) {
                // nothing measurable — tell the panel the measurement is unavailable
                for (const wp of waypoints) {
                    report.waypoints.push({ entity: wp.entity, clearance: -1, level: SafetyLevel.unknown });
                }
                this.drawRoute(waypoints.map(w => w.position));
                this.drawDistanceIndicators(waypoints, report);
                this.events.fire('route.validated', report);
                return;
            }

            for (const wp of waypoints) {
                const clearance = this.clearance.clearance(wp.position);
                const level = this.clearance.level(clearance);
                this.applyMarkerLevel(wp.entity, level);
                report.waypoints.push({ entity: wp.entity, clearance, level });
            }

            // plan each leg; the polyline we draw follows the safe path.
            // results are cached by endpoints, so moving one waypoint only
            // re-plans the two legs that actually changed
            const path: Vec3[] = [];
            for (let i = 0; i < waypoints.length; i++) {
                const a = waypoints[i].position;
                path.push(a.clone());

                if (i === waypoints.length - 1) break;

                const b = waypoints[i + 1].position;
                const plan = this.getLegPlan(a, b);

                if (plan.detour) {
                    for (const p of plan.detour) {
                        path.push(p.clone());
                    }
                }

                // legs carry their measured level: a leg whose detour search
                // failed keeps the straight line and now shows up as danger
                report.segments.push({
                    index: i,
                    clearance: plan.clearance,
                    level: this.clearance.level(plan.clearance),
                    point: plan.point.clone()
                });
            }

            const measured = [
                ...report.waypoints.map(w => w.clearance),
                ...report.segments.map(s => s.clearance)
            ].filter(c => c >= 0);

            report.minClearance = measured.length ? Math.min(...measured) : -1;
            report.dangerCount = report.waypoints.filter(x => x.level === SafetyLevel.danger).length;

            this.drawRoute(path);
            this.drawDistanceIndicators(waypoints, report);
            this.scene.forceRender = true;
            this.events.fire('route.validated', report);
        } finally {
            this.validating = false;
            if (this.validationQueued) {
                this.validationQueued = false;
                this.updateRoute();
            }
        }
    }

    // draw the route connector through the given polyline, with "<"-style
    // chevrons showing the travel direction
    private drawRoute(path: Vec3[]) {
        const positions: number[] = [];
        for (let i = 0; i < path.length - 1; i++) {
            const a = path[i];
            const b = path[i + 1];
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
        this.appendRouteChevrons(positions, path);
        this.setRouteLine(positions);
    }

    // append "<"-style direction chevrons (two line segments each) at regular
    // spacing along the flight polyline. drawn into the same line batch as the
    // route, so they share its material, layer and lifecycle.
    private appendRouteChevrons(positions: number[], path: Vec3[]) {
        if (path.length < 2) return;

        const sceneRadius = this.scene.bound.halfExtents.length();
        const spacing = Math.max(sceneRadius * ARROW_SPACING, 1e-4);
        // chevron geometry: two arms of `armLen` meeting at the tip, swept
        // back symmetrically by half the included angle around the anchor
        const armLen = Math.max(sceneRadius * ARROW_ARM, 1e-4);
        const halfAngle = ARROW_ANGLE * 0.5 * Math.PI / 180;
        const fwd = armLen * Math.cos(halfAngle);
        const sideOff = armLen * Math.sin(halfAngle);

        // walk the polyline, dropping a chevron every `spacing` metres; the
        // leftover distance carries over across segment corners
        let carry = spacing * 0.5;
        let placed = 0;
        for (let i = 0; i < path.length - 1; i++) {
            const a = path[i];
            const b = path[i + 1];
            tmpDir.sub2(b, a);
            const segLen = tmpDir.length();
            if (segLen < 1e-9) continue;
            tmpDir.normalize();

            // side direction for the swept-back arms; degenerate for vertical
            // segments, where any horizontal axis will do
            tmpSide.cross(Vec3.UP, tmpDir);
            if (tmpSide.lengthSq() < 1e-12) {
                tmpSide.set(1, 0, 0);
            }
            tmpSide.normalize();

            const count = segLen >= carry ? Math.floor((segLen - carry) / spacing) + 1 : 0;
            for (let k = 0; k < count; k++) {
                const d = carry + k * spacing;
                const px = a.x + tmpDir.x * d;
                const py = a.y + tmpDir.y * d;
                const pz = a.z + tmpDir.z * d;
                const tx = px + tmpDir.x * fwd;     // tip, ahead of the anchor
                const ty = py + tmpDir.y * fwd;
                const tz = pz + tmpDir.z * fwd;
                const mx = px - tmpDir.x * fwd;     // arm roots, behind it
                const my = py - tmpDir.y * fwd;
                const mz = pz - tmpDir.z * fwd;
                positions.push(
                    tx, ty, tz,
                    mx + tmpSide.x * sideOff, my + tmpSide.y * sideOff, mz + tmpSide.z * sideOff,
                    tx, ty, tz,
                    mx - tmpSide.x * sideOff, my - tmpSide.y * sideOff, mz - tmpSide.z * sideOff
                );

                if (++placed >= ARROW_MAX_COUNT) return;
            }
            carry = carry + count * spacing - segLen;
        }
    }

    // one line per waypoint from the waypoint to the closest obstacle point,
    // plus a small anchor marker on the model, so the measured distance can be
    // seen — and steered — in space instead of only read in the panel.
    // drawn in the tool overlay layer so it stays visible through the gaussians.
    private drawDistanceIndicators(waypoints: { entity: Entity; position: Vec3 }[], report: RouteSafetyReport) {
        // drop the previous indicators
        this.disposeLine(this.distLine);
        this.disposeLine(this.distLineDanger);
        if (this.distEntity) {
            for (const child of [...this.distEntity.children]) {
                (child as Entity).destroy();
            }
        }
        this.distAnchors.length = 0;

        if (!this.distEntity || !report.ready) return;

        const safe: number[] = [];
        const danger: number[] = [];
        const anchor = new Vec3();

        const sceneRadius = this.scene.bound.halfExtents.length();
        // half the waypoint marker size
        const anchorScale = Math.max(sceneRadius * 0.002 / 3, 0.0005 / 3);

        for (let i = 0; i < waypoints.length; i++) {
            const wp = waypoints[i];
            const info = report.waypoints[i];
            const d = this.clearance.nearestObstacle(wp.position, anchor);
            if (d < 0 || d >= this.clearance.config.maxClearance) {
                continue;   // nothing measurable within range
            }

            const isDanger = info.level === SafetyLevel.danger;
            const target = isDanger ? danger : safe;
            target.push(wp.position.x, wp.position.y, wp.position.z, anchor.x, anchor.y, anchor.z);

            const marker = new Entity('distAnchor');
            marker.addComponent('render', { type: 'sphere' });
            marker.render.meshInstances[0].material = isDanger ? this.distDangerMaterial : this.distMaterial;
            marker.render.layers = [this.scene.overlayLayer.id];
            marker.setLocalScale(anchorScale, anchorScale, anchorScale);
            marker.setLocalPosition(anchor);
            this.distEntity.addChild(marker);
            this.distAnchors.push(marker);
        }

        this.setLine(this.distEntity, this.distLine, 'distLineSafe', safe, this.distMaterial, this.scene.overlayLayer.id);
        this.setLine(this.distEntity, this.distLineDanger, 'distLineDanger', danger, this.distDangerMaterial, this.scene.overlayLayer.id);
    }

    // redraw the route from the current waypoint positions and re-plan it
    private updateRouteLine() {
        this.drawRoute(this.waypointPositions().map(w => w.position));
        this.scene.forceRender = true;
        this.scheduleValidation();
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

        const routeEntity = new Entity('sampleRoute');

        // size for waypoint markers (same scale logic as sample points)
        const sceneRadius = scene.bound.halfExtents.length();
        const wpRadius = Math.max(sceneRadius * 0.002 / 3, 0.0005 / 3);
        const wpScale = wpRadius * 2;

        const waypointData: { position: Vec3; markerEntity: Entity; viewDir: Vec3; subject: Vec3; subjectMarker?: Entity }[] = [];
        const unsolvable: number[] = [];

        for (let i = 0; i < points.length; i++) {
            const point = points[i];

            let hoverPos: Vec3;
            if (ready) {
                const solved = solveHoverPoint(this.clearance, point.position, point.normal, this.clearance.config);
                if (!solved.ok) {
                    // no safe hover point exists: skip it rather than emitting a
                    // waypoint that would fly into the model
                    unsolvable.push(i);
                    continue;
                }
                hoverPos = solved.position;
            } else {
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

            // initial gimbal aim: from the hover point towards the sampled
            // surface point (the subject the waypoint is supposed to shoot)
            const viewDir = new Vec3().sub2(point.position, hoverPos).normalize();

            waypointData.push({ position: hoverPos.clone(), markerEntity: wp, viewDir, subject: point.position.clone(), subjectMarker: point.marker });
        }

        scene.app.root.addChild(routeEntity);
        this.routeEntity = routeEntity;

        // container for the per-waypoint distance indicators
        const distEntity = new Entity('sampleDistances');
        distEntity.enabled = this.distIndicatorsVisible;
        scene.app.root.addChild(distEntity);
        this.distEntity = distEntity;

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
