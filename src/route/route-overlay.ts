import { BLEND_NORMAL, Color, Entity, Mesh, MeshInstance, PRIMITIVE_LINES, PRIMITIVE_TRIANGLES, StandardMaterial, Texture, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { ClearanceField, RouteSafetyReport } from './clearance-field';
import { SafetyLevel } from './safety-config';

// direction chevrons along the route, all relative to the scene extent:
// spacing between chevrons, included angle between the two arms (degrees),
// and the length of each arm; the count is capped as a runaway guard
const ARROW_SPACING = 0.012;    // arrow spacing (fraction of the scene radius)
const ARROW_HALF_SIZE = 0.00033; // arrow billboard quad half-size (scene radius fraction)
const ARROW_MAX_COUNT = 512;   // 数量上限

// route connector tube radius as a fraction of the scene radius. the tube
// replaces 1px PRIMITIVE_LINES so the route stays readable from any distance
const ROUTE_TUBE_RADIUS = 0.00027;
// optional operator-provided arrow image (white arrow, transparent background,
// tip pointing up). a procedural white chevron is used until it loads.
const ARROW_IMAGE_URL = 'static/images/route-arrow.png';

// temp vectors (module-scope to avoid per-frame allocations)
const tmpDir = new Vec3();
const tmpFwd = new Vec3();
const tmpRight = new Vec3();
const tmpUp = new Vec3();
const tmpToCam = new Vec3();

// append one 6-sided cylinder (no caps) between a and b to the buffers
function pushCylinder(positions: number[], normals: number[], indices: number[], a: Vec3, b: Vec3, radius: number) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) return;
    const nx = dx / len, ny = dy / len, nz = dz / len;

    // orthonormal cross-section basis from the segment direction:
    // right = dir × ref (ref not parallel to dir), up = right × dir
    const refx = Math.abs(ny) > 0.99 ? 1 : 0;
    const refy = 0;
    const refz = Math.abs(ny) > 0.99 ? 0 : 1;
    let rxx = ny * refz - nz * refy;
    let rxy = nz * refx - nx * refz;
    let rxz = nx * refy - ny * refx;
    const rl = Math.hypot(rxx, rxy, rxz) || 1;
    rxx /= rl; rxy /= rl; rxz /= rl;
    const uxx = rxy * nz - rxz * ny;
    const uxy = rxz * nx - rxx * nz;
    const uxz = rxx * ny - rxy * nx;

    const SIDES = 6;
    const base = positions.length / 3;
    for (let s = 0; s < SIDES; s++) {
        const ang = s / SIDES * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const mx = rxx * ca + uxx * sa;
        const my = rxy * ca + uxy * sa;
        const mz = rxz * ca + uxz * sa;
        positions.push(a.x + mx * radius, a.y + my * radius, a.z + mz * radius);
        positions.push(b.x + mx * radius, b.y + my * radius, b.z + mz * radius);
        normals.push(mx, my, mz, mx, my, mz);
    }
    for (let s = 0; s < SIDES; s++) {
        const s2 = (s + 1) % SIDES;
        const a0 = base + s * 2, b0 = base + s * 2 + 1;
        const a1 = base + s2 * 2, b1 = base + s2 * 2 + 1;
        indices.push(a0, b0, b1, a0, b1, a1);
    }
}

// append one low-poly UV sphere: rounded joints and end caps for tubes
function pushSphere(positions: number[], normals: number[], indices: number[], v: Vec3, radius: number) {
    const LAT = 4, LON = 6;
    const base = positions.length / 3;
    for (let i = 0; i <= LAT; i++) {
        const phi = i / LAT * Math.PI;
        const sy = Math.cos(phi);
        const sr = Math.sin(phi);
        for (let j = 0; j < LON; j++) {
            const theta = j / LON * Math.PI * 2;
            const mx = sr * Math.cos(theta);
            const my = sy;
            const mz = sr * Math.sin(theta);
            positions.push(v.x + mx * radius, v.y + my * radius, v.z + mz * radius);
            normals.push(mx, my, mz);
        }
    }
    for (let i = 0; i < LAT; i++) {
        for (let j = 0; j < LON; j++) {
            const j2 = (j + 1) % LON;
            const r0 = base + i * LON;
            const r1 = base + (i + 1) * LON;
            indices.push(r0 + j, r1 + j, r1 + j2, r0 + j, r1 + j2, r0 + j2);
        }
    }
}

// unlit emissive material used for the route lines and overlays
function makeLineMaterial(color: Color) {
    const material = new StandardMaterial();
    material.diffuse = color;
    material.emissive = color;
    material.metalness = 0;
    material.update();
    return material;
}

// draws the sample point tool's route visuals: the green connector tube, the
// white direction arrow billboards riding it, the per-waypoint distance
// indicators and the red normal debug lines. pure drawing — all interaction
// (picking, dragging, gizmos, editing) stays in the tool, which drives this
// class from its route lifecycle.
class RouteOverlay {
    // the route polyline is drawn as a green triangle tube (1px lines are too
    // faint); direction arrows ride on it as camera-facing quads
    private routeTube: { entity: Entity | null; mesh: Mesh | null } = { entity: null, mesh: null };
    // 起飞点接线的蓝色管段批次（与绿色拍照航段分开构建，材质各自独立）
    private homeTube: { entity: Entity | null; mesh: Mesh | null } = { entity: null, mesh: null };
    private routeArrows: { entity: Entity | null; mesh: Mesh | null } = { entity: null, mesh: null };
    private lineMaterial: StandardMaterial;
    // 起飞点接线（起飞→首个拍照点、末拍照点→返航）的蓝色材质：
    // 与绿色管线同一套配置，仅改色
    private homeLineMaterial: StandardMaterial;
    private arrowMaterial: StandardMaterial;
    // per-arrow anchor + forward direction (6 floats each) for the billboards
    private arrowData: number[] = [];
    private arrowHalf = 0;
    private arrowPositions: Float32Array | null = null;
    private arrowNormals: Float32Array | null = null;
    private arrowIndices: Uint16Array | null = null;

    // per-waypoint distance indicators: a line from the waypoint to the closest
    // obstacle point plus a small anchor marker on the model. drawn in the tool
    // overlay layer so they stay visible through the gaussians.
    private distEntity: Entity | null = null;
    private distLine: { entity: Entity | null; mesh: Mesh | null } = { entity: null, mesh: null };
    private distLineDanger: { entity: Entity | null; mesh: Mesh | null } = { entity: null, mesh: null };
    private distMaterial: StandardMaterial;
    private distDangerMaterial: StandardMaterial;
    private distAnchors: Entity[] = [];
    // debug: red lines showing the oriented surface normal the solver actually
    // used per sample point (drawn during route generation)
    private normalLine: { entity: Entity | null; mesh: Mesh | null } = { entity: null, mesh: null };
    private normalMaterial: StandardMaterial;
    // visibility of the distance indicators (green/red lines + anchors),
    // toggled from the panel and preserved across route regeneration;
    // shortest-distance indicator lines start hidden (eye button toggles)
    private distIndicatorsVisible = false;

    private scene: Scene;
    private events: Events;
    private clearance: ClearanceField;
    // the route entity the tube, arrows and normal debug lines attach to; the
    // tool creates it lazily during route generation, hence the accessor
    private getParent: () => Entity | null;

    constructor(scene: Scene, parent: () => Entity | null, events: Events, clearance: ClearanceField) {
        this.scene = scene;
        this.getParent = parent;
        this.events = events;
        this.clearance = clearance;

        // line materials (created once and reused across rebuilds)
        this.lineMaterial = makeLineMaterial(new Color(0.16, 0.75, 0.32));
        // the route tube is triangle geometry: twoSidedLighting disables
        // backface culling, so faces whose winding ends up away from the
        // camera would not vanish
        this.lineMaterial.twoSidedLighting = true;
        // 起飞点接线的蓝色材质（克隆绿色管线的配置，仅改色）
        this.homeLineMaterial = makeLineMaterial(new Color(0.15, 0.45, 1));
        this.homeLineMaterial.twoSidedLighting = true;
        // direction arrows: unlit textured quads, cut out with alphaTest so no
        // transparency sorting against the route tube is needed. note: the
        // diffuse map's alpha is ignored by the engine — the opacity must come
        // from an explicit opacity map (same texture, alpha channel)
        this.arrowMaterial = makeLineMaterial(new Color(1, 1, 1));
        this.arrowMaterial.useLighting = false;
        this.arrowMaterial.alphaTest = 0.15;
        // arrows form an always-visible navigation overlay riding the route
        // axis: drawn in the transparent pass (after the opaque tube) with
        // depth testing off, so the tube can never clip them from any view
        // angle — the same always-on-top behavior the tube itself has over
        // the splat field
        this.arrowMaterial.blendType = BLEND_NORMAL;
        this.arrowMaterial.depthWrite = false;
        this.arrowMaterial.depthTest = false;
        const fallbackTexture = this.makeFallbackArrowTexture();
        this.arrowMaterial.diffuseMap = fallbackTexture;
        this.arrowMaterial.opacityMap = fallbackTexture;
        this.arrowMaterial.opacityMapChannel = 'a';
        this.arrowMaterial.update();
        this.loadArrowImage(ARROW_IMAGE_URL);

        // keep the arrow billboards camera-facing on every frame
        events.on('prerender', this.updateBillboards, this);
        this.distMaterial = makeLineMaterial(new Color(0.098, 1, 0.137));
        this.distDangerMaterial = makeLineMaterial(new Color(1, 0.15, 0.1));
        this.normalMaterial = makeLineMaterial(new Color(1, 0.1, 0.1));
    }

    // ── route line batches ──

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

    // draw the route connector through the given polyline, with "<"-style
    // chevrons showing the travel direction. homeLegs 为 true 时首尾两段
    // （起飞点↔拍照航点）以蓝色单独成批绘制
    setRoute(path: Vec3[], homeLegs?: boolean) {
        this.setRouteTube(path, homeLegs);

        // white direction arrows ride on the green tube as camera-facing quads
        const sceneRadius = this.scene.bound.halfExtents.length();
        this.arrowHalf = Math.max(sceneRadius * ARROW_HALF_SIZE, 1e-4);
        this.arrowData.length = 0;
        this.collectArrows(this.arrowData, path);
        this.ensureArrowMesh();
        this.updateBillboards();
    }

    // build the route connector as a green triangle tube following the
    // polyline: a 6-sided cylinder per segment plus a low-poly sphere per
    // vertex for rounded joints and caps. PRIMITIVE_LINES is hard-capped at
    // 1px width in WebGL, which makes the route nearly invisible.
    // homeLegs 为 true 时首段与末段是起飞点接线，以蓝色单独构建网格；
    // path 长度为 1（只有起飞点、没有拍照航点）时只画关节球不画管
    private setRouteTube(path: Vec3[], homeLegs?: boolean) {
        const line = this.routeTube;
        const parent = this.getParent();
        this.disposeLine(line);
        this.disposeLine(this.homeTube);
        if (!parent || path.length < 1) return;

        const radius = Math.max(this.scene.bound.halfExtents.length() * ROUTE_TUBE_RADIUS, 1e-4);
        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        // 起飞点接线两段的蓝色批次（与绿色拍照航段分开，材质互不影响）
        const homePositions: number[] = [];
        const homeNormals: number[] = [];
        const homeIndices: number[] = [];
        for (let i = 0; i < path.length - 1; i++) {
            const homeLeg = !!homeLegs && (i === 0 || i === path.length - 2);
            const pos = homeLeg ? homePositions : positions;
            const nor = homeLeg ? homeNormals : normals;
            const idx = homeLeg ? homeIndices : indices;
            pushCylinder(pos, nor, idx, path[i], path[i + 1], radius);
        }
        for (const v of path) {
            pushSphere(positions, normals, indices, v, radius);
        }
        this.finishTube(line, parent, 'routeTube', positions, normals, indices, this.lineMaterial);
        if (homePositions.length > 0) {
            this.finishTube(this.homeTube, parent, 'routeTubeHome', homePositions, homeNormals, homeIndices, this.homeLineMaterial);
        }
    }

    // upload accumulated tube geometry as a triangle mesh under the route entity
    private finishTube(
        line: { entity: Entity | null; mesh: Mesh | null },
        parent: Entity,
        name: string,
        positions: number[],
        normals: number[],
        indices: number[],
        material: StandardMaterial
    ) {
        if (!positions.length) return;
        const mesh = new Mesh(this.scene.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setNormals(normals);
        mesh.setIndices(indices);
        mesh.update(PRIMITIVE_TRIANGLES);

        const entity = new Entity(name);
        entity.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)] });
        // overlay layer: keeps the tube out of the simulated camera's picture
        // (the pip camera renders only world + splat layers) while the main
        // view still draws it after the splats
        entity.render.layers = [this.scene.overlayLayer.id];
        parent.addChild(entity);

        line.entity = entity;
        line.mesh = mesh;
    }

    // collect billboard anchors and forward directions (6 floats per arrow)
    // at regular spacing along the flight polyline; leftover distance carries
    // across segment corners
    private collectArrows(out: number[], path: Vec3[]) {
        if (path.length < 2) return;

        const spacing = Math.max(this.scene.bound.halfExtents.length() * ARROW_SPACING, 1e-4);

        let carry = spacing * 0.5;
        let placed = 0;
        for (let i = 0; i < path.length - 1; i++) {
            const a = path[i];
            const b = path[i + 1];
            tmpDir.sub2(b, a);
            const segLen = tmpDir.length();
            if (segLen < 1e-9) continue;
            tmpDir.normalize();

            const count = segLen >= carry ? Math.floor((segLen - carry) / spacing) + 1 : 0;
            for (let k = 0; k < count; k++) {
                const d = carry + k * spacing;
                out.push(
                    a.x + tmpDir.x * d,
                    a.y + tmpDir.y * d,
                    a.z + tmpDir.z * d,
                    tmpDir.x, tmpDir.y, tmpDir.z
                );

                if (++placed >= ARROW_MAX_COUNT) return;
            }
            carry = carry + count * spacing - segLen;
        }
    }

    // white direction arrows as camera-facing textured quads. each quad
    // contains the route forward direction and tilts toward the camera, so
    // the arrow reads like a road marking from any viewing angle.
    private ensureArrowMesh() {
        const parent = this.getParent();
        if (this.routeArrows.mesh || !parent) return;

        const mesh = new Mesh(this.scene.graphicsDevice);
        const maxVerts = ARROW_MAX_COUNT * 4;
        this.arrowPositions = new Float32Array(maxVerts * 3);
        this.arrowNormals = new Float32Array(maxVerts * 3);
        this.arrowIndices = new Uint16Array(ARROW_MAX_COUNT * 12); // 2 tris, both facings

        // static UVs: v grows along the route direction, so an arrow image
        // with its tip pointing up points along the flight direction
        const uvs = new Float32Array(maxVerts * 2);
        for (let q = 0; q < ARROW_MAX_COUNT; q++) {
            const u = q * 8;
            uvs[u + 0] = 0; uvs[u + 1] = 0;
            uvs[u + 2] = 1; uvs[u + 3] = 0;
            uvs[u + 4] = 1; uvs[u + 5] = 1;
            uvs[u + 6] = 0; uvs[u + 7] = 1;
        }
        mesh.setPositions(this.arrowPositions);
        mesh.setNormals(this.arrowNormals);
        // NOTE: the first argument is the UV *channel*, not a vertex count
        mesh.setUvs(0, uvs);
        mesh.setIndices(this.arrowIndices);
        mesh.update(PRIMITIVE_TRIANGLES);

        const entity = new Entity('routeArrows');
        const meshInstance = new MeshInstance(mesh, this.arrowMaterial);
        // positions are rebuilt every frame, so keep culling off — the mesh
        // bounding box is not refreshed and geo-shifted scenes sit far from
        // the origin, which would cull the arrows away entirely
        meshInstance.cull = false;
        entity.addComponent('render', { meshInstances: [meshInstance] });
        entity.render.layers = [this.scene.overlayLayer.id];
        parent.addChild(entity);

        this.routeArrows.entity = entity;
        this.routeArrows.mesh = mesh;
    }

    // reorient every arrow quad toward the camera; bound to the prerender
    // event so side views keep a readable arrow while orbiting
    updateBillboards() {
        const mesh = this.routeArrows.mesh;
        const positions = this.arrowPositions;
        const normals = this.arrowNormals;
        const indices = this.arrowIndices;
        if (!mesh || !positions || !normals || !indices || this.arrowData.length < 6) return;

        const camPos = this.scene.camera.mainCamera.getPosition();
        const half = this.arrowHalf;
        let quads = 0;
        for (let i = 0; i + 5 < this.arrowData.length && quads < ARROW_MAX_COUNT; i += 6, quads++) {
            const px = this.arrowData[i], py = this.arrowData[i + 1], pz = this.arrowData[i + 2];
            tmpDir.set(this.arrowData[i + 3], this.arrowData[i + 4], this.arrowData[i + 5]);
            tmpToCam.set(camPos.x - px, camPos.y - py, camPos.z - pz).normalize();
            // no positional offset: the quad stays centered on the route axis;
            // render-state layering (tube writes no depth, arrows render in
            // the transparent pass) keeps the arrows visible on top
            const ax = px, ay = py, az = pz;

            // true screen-space billboard: project the route direction onto the
            // view plane so the arrow always reads as a full arrow. projecting
            // is essential — building the quad from the raw route direction
            // collapses it edge-on when the view runs parallel to the route
            const dot = tmpDir.dot(tmpToCam);
            // tmpFwd = dir - toCam * dot (project onto the view plane); written
            // out because scale() would mutate the shared tmpToCam in place
            tmpFwd.set(
                tmpDir.x - tmpToCam.x * dot,
                tmpDir.y - tmpToCam.y * dot,
                tmpDir.z - tmpToCam.z * dot
            );
            if (tmpFwd.lengthSq() < 1e-8) {
                // view runs exactly along the route: point the arrow screen-up
                const dy = tmpToCam.y;
                tmpFwd.set(-tmpToCam.x * dy, 1 - dy * dy, -tmpToCam.z * dy);
                if (tmpFwd.lengthSq() < 1e-8) tmpFwd.set(1, 0, 0);
            }
            tmpFwd.normalize();
            tmpRight.cross(tmpFwd, tmpToCam).normalize();
            tmpUp.cross(tmpRight, tmpFwd).normalize();

            const vi = quads * 12;
            const ni = quads * 12;
            const rx = tmpRight.x * half, ry = tmpRight.y * half, rz = tmpRight.z * half;
            const fx = tmpFwd.x * half, fy = tmpFwd.y * half, fz = tmpFwd.z * half;
            positions[vi + 0] = ax - rx - fx; positions[vi + 1] = ay - ry - fy; positions[vi + 2] = az - rz - fz;
            positions[vi + 3] = ax + rx - fx; positions[vi + 4] = ay + ry - fy; positions[vi + 5] = az + rz - fz;
            positions[vi + 6] = ax + rx + fx; positions[vi + 7] = ay + ry + fy; positions[vi + 8] = az + rz + fz;
            positions[vi + 9] = ax - rx + fx; positions[vi + 10] = ay - ry + fy; positions[vi + 11] = az - rz + fz;
            for (let n = 0; n < 4; n++) {
                normals[ni + n * 3 + 0] = tmpToCam.x;
                normals[ni + n * 3 + 1] = tmpToCam.y;
                normals[ni + n * 3 + 2] = tmpToCam.z;
            }
            const qi = quads * 4;
            const ti = quads * 12;
            indices[ti + 0] = qi; indices[ti + 1] = qi + 1; indices[ti + 2] = qi + 2;
            indices[ti + 3] = qi; indices[ti + 4] = qi + 2; indices[ti + 5] = qi + 3;
            // reversed winding so the quad is visible from both facings
            indices[ti + 6] = qi; indices[ti + 7] = qi + 2; indices[ti + 8] = qi + 1;
            indices[ti + 9] = qi; indices[ti + 10] = qi + 3; indices[ti + 11] = qi + 2;
        }

        mesh.setPositions(positions.subarray(0, quads * 12));
        mesh.setNormals(normals.subarray(0, quads * 12));
        mesh.setIndices(indices.subarray(0, quads * 12));
        mesh.update(PRIMITIVE_TRIANGLES);
    }

    // procedural white chevron used until/unless the custom image loads
    private makeFallbackArrowTexture(): Texture {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        const g = canvas.getContext('2d');
        if (g) {
            g.clearRect(0, 0, 128, 128);
            g.strokeStyle = '#ffffff';
            g.lineWidth = 16;
            g.lineCap = 'round';
            g.lineJoin = 'round';
            g.beginPath();
            g.moveTo(28, 86);
            g.lineTo(64, 42);
            g.lineTo(100, 86);
            g.stroke();
        }
        const texture = new Texture(this.scene.graphicsDevice, { name: 'routeArrowFallback', flipY: true });
        texture.setSource(canvas);
        return texture;
    }

    // pick up the operator-provided arrow image if present: a white arrow on
    // a transparent background with its tip pointing up
    private loadArrowImage(url: string) {
        const img = new Image();
        img.onload = () => {
            const texture = new Texture(this.scene.graphicsDevice, { name: 'routeArrow', flipY: true });
            texture.setSource(img);
            this.arrowMaterial.diffuseMap = texture;
            this.arrowMaterial.opacityMap = texture;
            this.arrowMaterial.opacityMapChannel = 'a';
            this.arrowMaterial.update();
            this.scene.forceRender = true;
        };
        img.src = url;
    }

    // container for the per-waypoint distance indicators
    createDistEntity() {
        const distEntity = new Entity('sampleDistances');
        distEntity.enabled = this.distIndicatorsVisible;
        this.scene.app.root.addChild(distEntity);
        this.distEntity = distEntity;
    }

    // one line per waypoint from the waypoint to the closest obstacle point,
    // plus a small anchor marker on the model, so the measured distance can be
    // seen — and steered — in space instead of only read in the panel.
    // drawn in the tool overlay layer so it stays visible through the gaussians.
    drawDistanceIndicators(waypoints: { entity: Entity; position: Vec3 }[], report: RouteSafetyReport) {
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

    // debug: draw the oriented surface normal of every sample point as a red
    // line (length = the solver's primary search distance), so a wrong
    // direction is visible right where the waypoint went wrong
    setNormalDebug(points: { position: Vec3; normal: Vec3; marker?: Entity }[], debugNormals: Vec3[]) {
        const normalLen = this.clearance.config.hoverDistance;
        const normalPositions: number[] = [];
        for (let i = 0; i < points.length; i++) {
            const p = points[i].position;
            const n = debugNormals[i];
            if (!n) continue;
            normalPositions.push(
                p.x, p.y, p.z,
                p.x + n.x * normalLen, p.y + n.y * normalLen, p.z + n.z * normalLen
            );
        }
        this.setLine(this.getParent(), this.normalLine, 'normalLines', normalPositions, this.normalMaterial, this.scene.overlayLayer.id);
    }

    // apply the panel's visibility toggle to the indicator container
    setDistVisible(visible: boolean) {
        this.distIndicatorsVisible = visible;
        if (this.distEntity) {
            this.distEntity.enabled = visible;
        }
    }

    getDistVisible() {
        return this.distIndicatorsVisible;
    }

    // destroy the route visuals (tube, arrows, indicator and debug lines);
    // called by the tool's clearRoute before the route entity itself (which
    // owns the waypoint markers) is destroyed
    clear() {
        this.disposeLine(this.routeTube);
        this.disposeLine(this.homeTube);
        this.disposeLine(this.routeArrows);
        this.arrowData.length = 0;
        this.disposeLine(this.distLine);
        this.disposeLine(this.distLineDanger);
        this.disposeLine(this.normalLine);
        this.distAnchors.length = 0;
        if (this.distEntity) {
            this.distEntity.destroy();
            this.distEntity = null;
        }
    }

    // unregister the per-frame updates and release every visual resource
    destroy() {
        this.events.off('prerender', this.updateBillboards, this);
        this.clear();
        this.lineMaterial.destroy();
        this.homeLineMaterial.destroy();
        this.arrowMaterial.destroy();
        this.distMaterial.destroy();
        this.distDangerMaterial.destroy();
        this.normalMaterial.destroy();
    }
}

export { makeLineMaterial, RouteOverlay };
