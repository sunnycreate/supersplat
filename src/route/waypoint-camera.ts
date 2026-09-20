import { BLEND_NORMAL, Color, Entity, Mat4, Mesh, MeshInstance, PIXELFORMAT_RGBA8, PRIMITIVE_LINES, PRIMITIVE_TRIANGLES, Quat, RenderTarget, StandardMaterial, Texture, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';

// gimbal parameter limits (DJI-like)
const YAW_LIMIT = 180;          // ±deg
const PITCH_MIN = -90;          // deg
const PITCH_MAX = 35;           // deg
const FOCAL_MIN = 2;            // mm
const FOCAL_MAX = 20;           // mm
const FOCAL_DEFAULT = 4.5;      // mm

// 1/1.8" class sensor, 4:3 stills
const SENSOR_WIDTH = 6.4;       // mm
const SENSOR_ASPECT = 4 / 3;

// frustum depth and per-waypoint direction line length (scene radius ratios)
const FRUSTUM_DEPTH_RATIO = 0.035;
const DIR_LINE_RATIO = 0.02;

// WASD move speed (scene radius per second) and preview refresh rate
const MOVE_SPEED_RATIO = 0.15;
const PIP_W = 320;
const PIP_H = 240;
const PIP_INTERVAL = 1 / 20;

interface Attitude {
    yaw: number;    // deg, around world up
    pitch: number;  // deg, negative looks down
    focal: number;  // mm
}

interface WaypointEntry {
    marker: Entity;
    position: Vec3;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// normalize an angle to [-180, 180)
const normAngle = (a: number) => ((a + 180) % 360 + 360) % 360 - 180;

// vertical/horizontal fov (deg) from focal length
const vFovDeg = (focal: number) => {
    return 2 * Math.atan(SENSOR_WIDTH / SENSOR_ASPECT / 2 / focal) * 180 / Math.PI;
};

const hFovDeg = (focal: number) => {
    return 2 * Math.atan(SENSOR_WIDTH / 2 / focal) * 180 / Math.PI;
};

const tmpQuat = new Quat();
const tmpMat = new Mat4();
const tmpZero = new Vec3();
const tmpOne = new Vec3(1, 1, 1);

// orientation of the gimbal: yaw around world up, then pitch around local X
const attitudeQuat = (attitude: Attitude, result: Quat) => {
    return result.setFromEulerAngles(attitude.pitch, attitude.yaw, 0);
};

const attitudeDir = (attitude: Attitude, result: Vec3) => {
    attitudeQuat(attitude, tmpQuat);
    tmpMat.setTRS(tmpZero, tmpQuat, tmpOne);
    result.set(0, 0, -1);
    tmpMat.transformVector(result, result);
    return result.normalize();
};

// inverse of attitudeDir: euler attitude whose forward (local -Z rotated by
// the gimbal quaternion) matches the given unit direction
const attitudeFromDir = (dir: Vec3): Attitude => {
    return {
        yaw: Math.atan2(-dir.x, -dir.z) * 180 / Math.PI,
        pitch: Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) * 180 / Math.PI,
        focal: FOCAL_DEFAULT
    };
};

// owns everything around waypoint gimbal attitude (PRD P1): per-waypoint
// attitude storage, frustum + direction indicator visuals, the WASD move
// interactions and the picture-in-picture first person preview.
class WaypointCameraRig {
    private events: Events;
    private scene: Scene;

    // attitude per waypoint marker
    private attitudes = new Map<Entity, Attitude>();

    // sampled surface point each waypoint is supposed to shoot (set at route
    // generation); drives the shooting-distance readout
    private subjects = new Map<Entity, Vec3>();

    // the sample point marker each subject came from, so dragging a sample
    // point marker can move the linked subject with it
    private subjectSamples = new Map<Entity, Entity>();

    // current waypoint list (kept in sync via events)
    private waypoints: WaypointEntry[] = [];

    // currently selected waypoint (drives frustum + preview)
    private selected: Entity | null = null;

    // frustum of the selected waypoint
    private frustumEntity: Entity | null = null;
    private frustumMeshes: { faces: Mesh; edges: Mesh } | null = null;
    private frustumFocal = -1;      // focal the meshes were built for
    private frustumMat: StandardMaterial;
    private frustumEdgeMat: StandardMaterial;

    // per-waypoint simplified direction indicators (line batch)
    private dirEntity: Entity | null = null;
    private dirMesh: Mesh | null = null;
    private dirMat: StandardMaterial;

    // picture-in-picture camera
    private pipEntity: Entity | null = null;
    private pipRt: RenderTarget | null = null;
    private pipAccum = 0;

    // active move directions (subset of forward/left/back/right)
    private moveDirs = new Set<string>();
    private moveMarker: Entity | null = null;
    private moveFwd = new Vec3();
    private moveRight = new Vec3();

    private tmpVec = new Vec3();

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;

        this.frustumMat = this.makeFrustumMaterial();
        this.frustumEdgeMat = this.makeLineMaterial(new Color(0.3, 1, 0.5));
        this.dirMat = this.makeLineMaterial(new Color(1, 0.8, 0.2));

        // ── gimbal parameter changes from the edit panel ──
        // the panel edits the RELATIVE yaw (body frame, WPML semantics:
        // 0 = along the route heading, + = right/clockwise); it is converted
        // to/from the world-frame yaw stored per waypoint
        events.on('waypointAttitude.set', (data: { marker: Entity; yaw: number; pitch: number; focal: number }) => {
            const attitude = this.attitudes.get(data.marker);
            if (!attitude) return;
            const relative = clamp(data.yaw, -YAW_LIMIT, YAW_LIMIT);
            attitude.yaw = normAngle(this.headingOrGimbal(data.marker) - relative);
            attitude.pitch = clamp(data.pitch, PITCH_MIN, PITCH_MAX);
            attitude.focal = clamp(data.focal, FOCAL_MIN, FOCAL_MAX);
            this.rebuildDirLines();
            if (data.marker === this.selected) {
                this.refreshFrustum();
                this.refreshPipPose();
            }
            // the editor renders on demand: make sure the changed frustum /
            // preview pose actually gets drawn this frame
            this.scene.forceRender = true;
            this.fireUpdated(data.marker);
        });

        // WASD from the edit panel buttons
        events.on('waypointAttitude.moveStart', (data: { marker: Entity; dir: string }) => {
            if (data.marker !== this.selected) return;
            this.beginMove(data.dir);
        });

        events.on('waypointAttitude.moveEnd', () => {
            this.endMove();
        });

        // safety report finished measuring → refresh the selected waypoint's
        // info line
        events.on('route.validated', () => {
            if (this.selected) {
                this.fireUpdated(this.selected);
            }
        });

        // route lifecycle
        events.on('route.generated', (waypoints: { position: Vec3; markerEntity: Entity; viewDir?: Vec3; subject?: Vec3; subjectMarker?: Entity }[]) => {
            this.waypoints = waypoints.map((wp) => ({ marker: wp.markerEntity, position: wp.position.clone() }));
            this.subjects.clear();
            this.subjectSamples.clear();
            for (const wp of waypoints) {
                if (wp.subject) {
                    this.subjects.set(wp.markerEntity, wp.subject.clone());
                }
                if (wp.subjectMarker) {
                    this.subjectSamples.set(wp.markerEntity, wp.subjectMarker);
                }
                if (!this.attitudes.has(wp.markerEntity)) {
                    // aim the gimbal at the sampled surface point when the
                    // tool supplies the view direction, else the fixed default
                    this.attitudes.set(wp.markerEntity, wp.viewDir
                        ? attitudeFromDir(wp.viewDir)
                        : { yaw: 0, pitch: -30, focal: FOCAL_DEFAULT });
                }
            }
            this.rebuildDirLines();
        });

        events.on('waypoint.moved', (marker: Entity, position: Vec3) => {
            const entry = this.waypoints.find(w => w.marker === marker);
            if (entry) {
                entry.position.copy(position);
            }
            this.rebuildDirLines();
            if (marker === this.selected) {
                this.refreshFrustum();
                this.refreshPipPose();
                this.fireUpdated(marker);
            }
        });

        // a sample point marker was dragged: move the linked subjects with it
        // and re-aim the gimbal so each waypoint keeps shooting its sample point
        events.on('samplePoint.moved', (data: { marker: Entity; position: Vec3 }) => {
            let changed = false;
            for (const [wpMarker, sampleMarker] of this.subjectSamples) {
                if (sampleMarker !== data.marker) continue;
                const subject = this.subjects.get(wpMarker);
                if (!subject) continue;
                subject.copy(data.position);
                // same aim rule as route generation: forward towards the subject
                const attitude = this.attitudes.get(wpMarker);
                if (attitude) {
                    const aim = attitudeFromDir(new Vec3().sub2(subject, wpMarker.getLocalPosition()).normalize());
                    attitude.yaw = aim.yaw;
                    attitude.pitch = aim.pitch;
                }
                changed = true;
            }
            if (changed) {
                this.rebuildDirLines();
                if (this.selected) {
                    this.refreshFrustum();
                    this.refreshPipPose();
                    this.fireUpdated(this.selected);
                }
                this.scene.forceRender = true;
            }
        });

        // WASD keyboard (same mapping as the panel buttons); ignored while
        // typing into inputs
        window.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.repeat) return;
            const target = document.activeElement;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
            const dir = this.keyToDir(e.key);
            if (dir && this.selected) {
                // the arrows are ours while a waypoint is selected: stop any
                // browser default (scrolling etc.)
                e.preventDefault();
                this.beginMove(dir);
            }
        });
        window.addEventListener('keyup', (e: KeyboardEvent) => {
            const dir = this.keyToDir(e.key);
            if (dir) {
                this.moveDirs.delete(dir);
                if (this.moveDirs.size === 0) {
                    this.endMove();
                }
            }
        });

        scene.app.on('update', (dt: number) => {
            this.update(dt);
        });
    }

    // ── selection (called by the sample point tool) ──

    select(marker: Entity) {
        if (marker.name !== 'waypoint') {
            this.deselect();
            return;
        }
        this.selected = marker;
        if (!this.attitudes.has(marker)) {
            this.attitudes.set(marker, { yaw: 0, pitch: -30, focal: FOCAL_DEFAULT });
        }
        this.ensureFrustum();
        this.ensurePip();
        this.refreshFrustum();
        this.refreshPipPose();
        this.frustumEntity.enabled = true;
        this.scene.app.root.addChild(this.pipEntity);
        this.events.fire('cameraPreview.visible', true);
        this.fireSelected(marker);
        this.scene.forceRender = true;
    }

    deselect() {
        if (!this.selected) return;
        this.selected = null;
        this.endMove();
        if (this.frustumEntity) {
            this.frustumEntity.enabled = false;
        }
        if (this.pipEntity) {
            this.scene.app.root.removeChild(this.pipEntity);
        }
        this.events.fire('cameraPreview.visible', false);
        // payload shape must match 'fireSelected': listeners read data.marker
        this.events.fire('waypointAttitude.selected', { marker: null });
        this.scene.forceRender = true;
    }

    // the whole route was destroyed
    routeCleared() {
        this.waypoints = [];
        this.attitudes.clear();
        this.subjects.clear();
        this.subjectSamples.clear();
        this.deselect();
        this.destroyDirLines();
    }

    // export payload for one waypoint. the yaw is the RELATIVE gimbal yaw
    // (body frame, WPML gimbalYawRotateAngle semantics: 0 = along the route
    // heading, + = right / clockwise)
    getExportData(marker: Entity): { yaw: number; pitch: number; focal: number; groundDist: number; shootDist: number } {
        const position = marker.getLocalPosition();
        const attitude = this.attitudes.get(marker);
        return {
            yaw: +this.relativeYaw(marker).toFixed(2),
            pitch: +(attitude?.pitch ?? 0).toFixed(2),
            focal: +(attitude?.focal ?? FOCAL_DEFAULT).toFixed(2),
            groundDist: +this.groundDist(position).toFixed(3),
            shootDist: +this.shootDist(position, marker).toFixed(3)
        };
    }

    // ── movement ──

    // arrow keys move the selected waypoint (W/A/S/D stay with the
    // editor camera fly)
    private keyToDir(key: string): string | null {
        switch (key) {
            case 'ArrowUp': return 'forward';
            case 'ArrowDown': return 'back';
            case 'ArrowLeft': return 'left';
            case 'ArrowRight': return 'right';
            default: return null;
        }
    }

    private beginMove(dir: string) {
        if (!this.selected) return;
        if (this.moveDirs.size === 0) {
            // cache the camera-relative move basis at move start:
            // forward = camera forward flattened onto XZ, right = fwd × up
            const camera = this.scene.camera.mainCamera;
            this.moveFwd.set(camera.forward.x, 0, camera.forward.z).normalize();
            this.moveRight.cross(this.moveFwd, Vec3.UP).normalize();
            this.moveMarker = this.selected;
        }
        this.moveDirs.add(dir);
    }

    private endMove() {
        if (this.moveDirs.size === 0) return;
        this.moveDirs.clear();
        const marker = this.moveMarker;
        this.moveMarker = null;
        if (marker) {
            // re-plan the route around the new position (same as gizmo drag)
            this.events.fire('route.redraw.request', marker, marker.getLocalPosition().clone());
        }
    }

    private update(dt: number) {
        // apply movement while any direction is held
        if (this.moveDirs.size > 0 && this.moveMarker) {
            const step = this.scene.bound.halfExtents.length() * MOVE_SPEED_RATIO * dt;
            this.tmpVec.set(0, 0, 0);
            if (this.moveDirs.has('forward')) this.tmpVec.add(this.moveFwd);
            if (this.moveDirs.has('back')) this.tmpVec.sub(this.moveFwd);
            if (this.moveDirs.has('right')) this.tmpVec.add(this.moveRight);
            if (this.moveDirs.has('left')) this.tmpVec.sub(this.moveRight);
            if (this.tmpVec.lengthSq() > 0) {
                this.tmpVec.normalize().mulScalar(step);
                this.moveMarker.setLocalPosition(
                    this.moveMarker.getLocalPosition().add(this.tmpVec)
                );
                this.refreshFrustum();
                this.refreshPipPose();
                this.scene.forceRender = true;
            }
        }

        // throttled preview copy
        if (this.pipEntity && this.pipEntity.parent && this.selected) {
            this.pipAccum += dt;
            if (this.pipAccum >= PIP_INTERVAL) {
                this.pipAccum = 0;
                this.copyPipFrame();
            }
        }
    }

    // ── route-relative yaw ──

    // world-frame heading (same convention as attitude yaw) of the route
    // direction at the given waypoint: towards the next waypoint, or from
    // the previous one at the end of the route. null when the route has no
    // horizontal direction (single waypoint or zero-length segment).
    // recomputed on demand so it stays correct while waypoints are dragged.
    private routeHeading(marker: Entity): number | null {
        const list = this.waypoints;
        if (list.length < 2) return null;
        const idx = list.findIndex(w => w.marker === marker);
        if (idx < 0) return null;
        const a = idx < list.length - 1 ? list[idx] : list[idx - 1];
        const b = idx < list.length - 1 ? list[idx + 1] : list[idx];
        const dir = new Vec3().sub2(b.position, a.position);
        dir.y = 0;
        if (dir.lengthSq() < 1e-12) return null;
        dir.normalize();
        return Math.atan2(-dir.x, -dir.z) * 180 / Math.PI;
    }

    // the heading, falling back to the gimbal's own yaw when the route has no
    // direction (relative yaw then reads 0 and stays editable)
    private headingOrGimbal(marker: Entity): number {
        const attitude = this.attitudes.get(marker);
        return this.routeHeading(marker) ?? attitude?.yaw ?? 0;
    }

    // gimbal yaw relative to the route heading (body frame, WPML semantics:
    // 0 = along the heading, + = right / clockwise)
    private relativeYaw(marker: Entity): number {
        const attitude = this.attitudes.get(marker);
        if (!attitude) return 0;
        return normAngle(this.headingOrGimbal(marker) - attitude.yaw);
    }

    // ── distances ──

    // height above the lowest point of the scene bounds
    private groundDist(position: Vec3): number {
        const bound = this.scene.bound;
        return position.y - (bound.center.y - bound.halfExtents.y);
    }

    // straight-line distance to the sampled surface point this waypoint
    // shoots (-1 when the tool did not supply a subject)
    private shootDist(position: Vec3, marker: Entity): number {
        const subject = this.subjects.get(marker);
        return subject ? position.distance(subject) : -1;
    }

    private firePayload(marker: Entity) {
        const attitude = this.attitudes.get(marker);
        const position = marker.getLocalPosition();
        return {
            marker,
            attitude: attitude ? { ...attitude } : null,
            // panel-facing relative yaw (body frame); the attitude.yaw above
            // stays in the world frame for rendering
            relativeYaw: attitude ? this.relativeYaw(marker) : null,
            groundDist: +this.groundDist(position).toFixed(3),
            shootDist: +this.shootDist(position, marker).toFixed(3)
        };
    }

    private fireSelected(marker: Entity) {
        this.events.fire('waypointAttitude.selected', this.firePayload(marker));
    }

    private fireUpdated(marker: Entity) {
        this.events.fire('waypointAttitude.updated', this.firePayload(marker));
    }

    // ── visuals ──

    private makeFrustumMaterial() {
        const mat = new StandardMaterial();
        mat.diffuse = new Color(0.1, 0.85, 0.35);
        mat.emissive = new Color(0.1, 0.85, 0.35);
        mat.metalness = 0;
        // kept faint: the double-sided winding duplicates overlap, and the
        // edge wireframe carries the shape
        mat.opacity = 0.13;
        mat.depthWrite = false;
        mat.blendType = BLEND_NORMAL;
        mat.update();
        return mat;
    }

    private makeLineMaterial(color: Color) {
        const mat = new StandardMaterial();
        mat.diffuse = color;
        mat.emissive = color;
        mat.metalness = 0;
        mat.update();
        return mat;
    }

    // frustum meshes: translucent side faces (apex at the origin, opening
    // towards -Z, both windings so the cull mode does not matter) plus a
    // bright edge wireframe (4 apex rays + the far rectangle) that gives the
    // cone its 3d read
    private buildFrustumMeshes(vFov: number, hFov: number, depth: number): { faces: Mesh; edges: Mesh } {
        const hh = Math.tan(vFov * Math.PI / 360) * depth;
        const hw = Math.tan(hFov * Math.PI / 360) * depth;
        const apex = [0, 0, 0];
        const c = [
            [-hw, -hh, -depth], [hw, -hh, -depth], [hw, hh, -depth], [-hw, hh, -depth]
        ];
        const tris: number[][][] = [];
        // 4 side faces (apex + adjacent corners)
        for (let i = 0; i < 4; i++) {
            tris.push([apex, c[i], c[(i + 1) % 4]]);
        }
        // front quad
        tris.push([c[0], c[1], c[2]], [c[0], c[2], c[3]]);

        const positions: number[] = [];
        const normals: number[] = [];
        const tmpA = new Vec3();
        const tmpB = new Vec3();
        const faceNormal = new Vec3();
        for (const tri of tris) {
            for (const winding of [tri, [tri[0], tri[2], tri[1]]]) {
                for (const p of winding) {
                    positions.push(p[0], p[1], p[2]);
                }
                tmpA.set(winding[1][0] - winding[0][0], winding[1][1] - winding[0][1], winding[1][2] - winding[0][2]);
                tmpB.set(winding[2][0] - winding[0][0], winding[2][1] - winding[0][1], winding[2][2] - winding[0][2]);
                faceNormal.cross(tmpA, tmpB).normalize();
                for (let i = 0; i < 3; i++) {
                    normals.push(faceNormal.x, faceNormal.y, faceNormal.z);
                }
            }
        }

        const faces = new Mesh(this.scene.graphicsDevice);
        faces.setPositions(positions);
        faces.setNormals(normals);
        faces.update(PRIMITIVE_TRIANGLES);

        // edge wireframe: apex rays + the far rectangle
        const lines: number[] = [];
        for (let i = 0; i < 4; i++) {
            lines.push(apex[0], apex[1], apex[2], c[i][0], c[i][1], c[i][2]);
            lines.push(c[i][0], c[i][1], c[i][2], c[(i + 1) % 4][0], c[(i + 1) % 4][1], c[(i + 1) % 4][2]);
        }
        const edges = new Mesh(this.scene.graphicsDevice);
        edges.setPositions(lines);
        edges.update(PRIMITIVE_LINES);

        return { faces, edges };
    }

    private ensureFrustum() {
        if (this.frustumEntity) return;
        this.frustumMeshes = this.buildFrustumMeshes(
            vFovDeg(FOCAL_DEFAULT), hFovDeg(FOCAL_DEFAULT),
            this.scene.bound.halfExtents.length() * FRUSTUM_DEPTH_RATIO
        );
        this.frustumEntity = new Entity('waypointFrustum');
        this.frustumEntity.addComponent('render', {
            meshInstances: [
                new MeshInstance(this.frustumMeshes.faces, this.frustumMat),
                new MeshInstance(this.frustumMeshes.edges, this.frustumEdgeMat)
            ]
        });
        this.frustumEntity.render.layers = [this.scene.overlayLayer.id];
        this.frustumEntity.enabled = false;
        this.scene.app.root.addChild(this.frustumEntity);
    }

    // rebuild the frustum meshes when the focal length changed and move it to
    // the selected waypoint with the current attitude
    private refreshFrustum() {
        if (!this.selected || !this.frustumEntity) return;
        const attitude = this.attitudes.get(this.selected);
        if (!attitude) return;

        if (this.frustumFocal !== attitude.focal) {
            this.frustumFocal = attitude.focal;
            const meshes = this.buildFrustumMeshes(
                vFovDeg(attitude.focal), hFovDeg(attitude.focal),
                this.scene.bound.halfExtents.length() * FRUSTUM_DEPTH_RATIO
            );
            this.frustumMeshes?.faces.destroy();
            this.frustumMeshes?.edges.destroy();
            this.frustumMeshes = meshes;
            const instances = this.frustumEntity.render.meshInstances;
            (instances[0] as MeshInstance).mesh = meshes.faces;
            (instances[1] as MeshInstance).mesh = meshes.edges;
        }

        this.frustumEntity.setLocalPosition(this.selected.getLocalPosition());
        attitudeQuat(attitude, tmpQuat);
        this.frustumEntity.setLocalRotation(tmpQuat);
    }

    // per-waypoint short direction lines (simplified indicator)
    private destroyDirLines() {
        this.dirEntity?.destroy();
        this.dirMesh?.destroy();
        this.dirEntity = null;
        this.dirMesh = null;
    }

    private rebuildDirLines() {
        this.destroyDirLines();
        if (this.waypoints.length === 0) return;

        const len = this.scene.bound.halfExtents.length() * DIR_LINE_RATIO;
        const positions: number[] = [];
        const dir = new Vec3();
        for (const wp of this.waypoints) {
            const attitude = this.attitudes.get(wp.marker);
            if (!attitude) continue;
            const start = wp.marker.getLocalPosition();
            // with a known subject the line spans exactly to it (its length
            // is the shooting distance); otherwise fall back to a short
            // attitude-direction tick
            let end: Vec3;
            const subject = this.subjects.get(wp.marker);
            if (subject) {
                end = subject;
            } else {
                attitudeDir(attitude, dir);
                end = new Vec3(
                    start.x + dir.x * len,
                    start.y + dir.y * len,
                    start.z + dir.z * len
                );
            }
            positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
        }
        if (positions.length === 0) return;

        this.dirMesh = new Mesh(this.scene.graphicsDevice);
        this.dirMesh.setPositions(positions);
        this.dirMesh.update(PRIMITIVE_LINES);
        this.dirEntity = new Entity('waypointDirs');
        this.dirEntity.addComponent('render', {
            meshInstances: [new MeshInstance(this.dirMesh, this.dirMat)]
        });
        this.dirEntity.render.layers = [this.scene.overlayLayer.id];
        this.scene.app.root.addChild(this.dirEntity);
        this.scene.forceRender = true;
    }

    // ── picture-in-picture ──

    private ensurePip() {
        if (this.pipEntity) return;

        const texture = new Texture(this.scene.graphicsDevice, {
            name: 'waypointPip',
            width: PIP_W,
            height: PIP_H,
            format: PIXELFORMAT_RGBA8
        });
        this.pipRt = new RenderTarget({
            colorBuffer: texture,
            depth: true
        });

        this.pipEntity = new Entity('waypointPipCamera');
        // world: environment/skybox, splat: the gaussians themselves (the
        // splat shader's MRT picking output is a legal no-op on a plain RT)
        this.pipEntity.addComponent('camera', {
            renderTarget: this.pipRt,
            layers: [this.scene.worldLayer.id, this.scene.splatLayer.id],
            clearColorBuffer: true,
            clearDepthBuffer: true
        });
        const camera = this.pipEntity.camera;
        camera.nearClip = 0.05;
        camera.farClip = this.scene.bound.halfExtents.length() * 40;
        camera.clearColor = this.scene.camera.mainCamera.camera.clearColor.clone();
    }

    private refreshPipPose() {
        if (!this.selected || !this.pipEntity) return;
        const attitude = this.attitudes.get(this.selected);
        if (!attitude) return;
        this.pipEntity.setLocalPosition(this.selected.getLocalPosition());
        attitudeQuat(attitude, tmpQuat);
        this.pipEntity.setLocalRotation(tmpQuat);
        this.pipEntity.camera.fov = vFovDeg(attitude.focal);
    }

    // copy the offscreen render target into the preview canvas (2d). the RT
    // rows come back bottom-up, so they are flipped while copying.
    private copyPipFrame() {
        const canvas = this.events.invoke('cameraPreview.canvas') as HTMLCanvasElement | null;
        if (!canvas || !this.pipRt) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const data = this.pipRt.colorBuffer.read(0, 0, PIP_W, PIP_H, { immediate: true });
        Promise.resolve(data as unknown as Uint8Array).then((pixels) => {
            const imageData = ctx.createImageData(PIP_W, PIP_H);
            const rowBytes = PIP_W * 4;
            for (let y = 0; y < PIP_H; y++) {
                imageData.data.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), (PIP_H - 1 - y) * rowBytes);
            }
            ctx.putImageData(imageData, 0, 0);
        }).catch(() => {});
    }
}

export { WaypointCameraRig };
