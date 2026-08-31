import { Color, Entity, Mat4, Mesh, MeshInstance, PRIMITIVE_LINESTRIP, StandardMaterial, TranslateGizmo, Vec3 } from 'playcanvas';
import proj4 from 'proj4';

import { EditOp } from '../edit-ops';
import { ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;

// screen-space pick radius for selecting an existing marker (pixels)
const MARKER_PICK_RADIUS = 12;

// temp vectors (module-scope to avoid per-frame allocations)
const tmpScreen = new Vec3();
const tmpWorld = new Vec3();
const tmpDir = new Vec3();

// add a sample point marker to the scene (undo removes it)
class AddSamplePointOp implements EditOp {
    name = 'addSamplePoint';
    parent: Entity;
    marker: Entity;
    scene: Scene;

    constructor(parent: Entity, marker: Entity, scene: Scene) {
        this.parent = parent;
        this.marker = marker;
        this.scene = scene;
    }

    do() {
        this.parent.addChild(this.marker);
        this.scene.forceRender = true;
    }

    undo() {
        this.parent.removeChild(this.marker);
        this.scene.forceRender = true;
    }

    destroy() {
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

    constructor(marker: Entity, oldPos: Vec3, newPos: Vec3, scene: Scene) {
        this.marker = marker;
        this.oldPos = oldPos;
        this.newPos = newPos;
        this.scene = scene;
    }

    do() {
        this.marker.setLocalPosition(this.newPos);
        this.scene.forceRender = true;
    }

    undo() {
        this.marker.setLocalPosition(this.oldPos);
        this.scene.forceRender = true;
    }
}

class SamplePointTool {
    activate: () => void;
    deactivate: () => void;

    private events: Events;
    private scene: Scene;
    private canvasContainer: HTMLElement;

    // root entity that holds all sample point markers
    private root: Entity | null = null;
    // entity that holds generated waypoints and route line
    private routeEntity: Entity | null = null;
    // line mesh reference for updating positions when waypoints move
    private routeMesh: Mesh | null = null;
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

    constructor(events: Events, scene: Scene, canvasContainer: HTMLElement) {
        this.events = events;
        this.scene = scene;
        this.canvasContainer = canvasContainer;

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
                const newPos = this.selectedMarker.getLocalPosition().clone();
                // only record if the marker actually moved
                if (!newPos.equals(this.dragStartPos)) {
                    if (this.selectedMarker.name === 'waypoint') {
                        // update route line when a waypoint moves
                        this.updateRouteLine();
                        events.fire('waypoint.moved', this.selectedMarker, newPos.clone());
                    } else {
                        // suppress do because the gizmo already applied the move
                        events.fire('edit.add', new MoveSamplePointOp(
                            this.selectedMarker,
                            this.dragStartPos,
                            newPos,
                            scene
                        ), true);
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

        // highlight/unhighlight a marker (e.g. when hovering a panel row)
        events.on('samplePoint.highlight', (marker: Entity) => {
            this.highlightMarker(marker);
        });
        events.on('samplePoint.unhighlight', (marker: Entity) => {
            this.unhighlightMarker(marker);
        });

        // generate waypoints and route line from sample points
        events.on('samplePoint.generateRoute', (points: { position: Vec3; normal: Vec3 }[]) => {
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

    // unhighlight a marker: restore original color (yellow for sample points, blue for waypoints)
    private unhighlightMarker(marker: Entity) {
        if (!marker.render) return;
        const material = marker.render.meshInstances[0].material as StandardMaterial;
        const isWaypoint = marker.name === 'waypoint';
        const restore = isWaypoint ? new Color(0, 0.5, 1) : new Color(1, 1, 0);
        material.diffuse = restore;
        material.emissive = restore;
        material.update();
        this.scene.forceRender = true;
    }

    // create a marker and register it as an undoable operation
    private createMarker(position: Vec3, normal: Vec3) {
        if (!this.root) return;

        const marker = this.makeMarkerEntity(position);
        const op = new AddSamplePointOp(this.root, marker, this.scene);
        // edit.add calls op.do() which adds the marker to the scene
        this.events.fire('edit.add', op);
        this.scene.forceRender = true;

        // compute WGS84 coordinates if geo metadata is available
        const wgs84 = this.sceneToWgs84(position);

        // notify listeners (e.g. sample point panel) that a marker was created
        this.events.fire('samplePoint.created', {
            position: position.clone(),
            normal: normal.clone(),
            wgs84: wgs84 ? { ...wgs84 } : null,
            markerEntity: marker
        });

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

    private selectMarker(marker: Entity) {
        this.selectedMarker = marker;
        this.gizmo.attach(marker);
        this.scene.forceRender = true;
    }

    private deselectMarker() {
        this.selectedMarker = null;
        this.gizmo.detach();
        this.dragStartPos = null;
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
        if (this.routeEntity) {
            this.routeEntity.destroy();
            this.routeEntity = null;
        }
        this.routeMesh = null;
        this.routeEditMode = false;
        this.scene.forceRender = true;
    }

    // update the route line mesh when a waypoint moves
    private updateRouteLine() {
        if (!this.routeEntity || !this.routeMesh) return;

        const positions: number[] = [];
        for (const child of this.routeEntity.children) {
            if ((child as Entity).name === 'waypoint') {
                const pos = (child as Entity).getLocalPosition();
                positions.push(pos.x, pos.y, pos.z);
            }
        }

        this.routeMesh.setPositions(positions);
        this.routeMesh.update(PRIMITIVE_LINESTRIP);
        this.scene.forceRender = true;
    }

    // generate waypoints and a blue route line from sample points.
    // each waypoint is placed 10 units along the surface normal from the
    // corresponding sample point.
    private generateRoute(points: { position: Vec3; normal: Vec3 }[]) {
        this.clearRoute();

        if (!this.root || points.length === 0) return;

        const { scene } = this;
        const device = scene.graphicsDevice;
        const routeEntity = new Entity('sampleRoute');

        // size for waypoint markers (same scale logic as sample points)
        const sceneRadius = scene.bound.halfExtents.length();
        const wpRadius = Math.max(sceneRadius * 0.002 / 3, 0.0005 / 3);
        const wpScale = wpRadius * 2;

        // offset distance along the surface normal (10 m)
        const offset = 10;

        const hoverPositions: Vec3[] = [];
        const waypointData: { position: Vec3; markerEntity: Entity }[] = [];

        for (const point of points) {
            const hoverPos = new Vec3(
                point.position.x + point.normal.x * offset,
                point.position.y + point.normal.y * offset,
                point.position.z + point.normal.z * offset
            );
            hoverPositions.push(hoverPos);

            // waypoint marker (blue sphere)
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

            waypointData.push({ position: hoverPos.clone(), markerEntity: wp });
        }

        // create route line connecting all waypoints
        if (hoverPositions.length >= 2) {
            const positions: number[] = [];
            for (const pos of hoverPositions) {
                positions.push(pos.x, pos.y, pos.z);
            }

            const mesh = new Mesh(device);
            mesh.setPositions(positions);
            mesh.update(PRIMITIVE_LINESTRIP);
            this.routeMesh = mesh;

            const lineMat = new StandardMaterial();
            lineMat.diffuse = new Color(0, 0.5, 1);
            lineMat.emissive = new Color(0, 0.5, 1);
            lineMat.metalness = 0;
            lineMat.update();

            const meshInstance = new MeshInstance(mesh, lineMat);
            const lineEntity = new Entity('routeLine');
            lineEntity.addComponent('render', { meshInstances: [meshInstance] });
            lineEntity.render.layers = [scene.worldLayer.id];
            routeEntity.addChild(lineEntity);
        }

        scene.app.root.addChild(routeEntity);
        this.routeEntity = routeEntity;
        scene.forceRender = true;

        // notify listeners (panel) of the generated waypoints
        this.events.fire('route.generated', waypointData);
    }
}

export { SamplePointTool };
