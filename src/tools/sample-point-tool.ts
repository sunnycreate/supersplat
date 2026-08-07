import { Color, Entity, StandardMaterial, TranslateGizmo, Vec3 } from 'playcanvas';

import { EditOp } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';

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
                    // suppress do because the gizmo already applied the move
                    events.fire('edit.add', new MoveSamplePointOp(
                        this.selectedMarker,
                        this.dragStartPos,
                        newPos,
                        scene
                    ), true);
                }
                this.dragStartPos = null;
            }
        });

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };

        const pointerdown = (e: PointerEvent) => {
            console.log(e)
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
                } else {
                    // try to place a new marker on the model surface
                    const x = this.clickX / this.canvasContainer.clientWidth;
                    const y = this.clickY / this.canvasContainer.clientHeight;
                    const result = await scene.camera.intersect(x, y);
                    console.log('result camera intersect', result)
                    if (result) {
                        this.deselectMarker();
                        this.createMarker(result.position);
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
    }

    // build a yellow sphere entity (not yet added to the scene)
    private makeMarkerEntity(position: Vec3): Entity {
        const { scene } = this;

        // size relative to the scene so the marker is visible at any scale.
        // kept small (under half the previous size) per design.
        const sceneRadius = scene.bound.halfExtents.length();
        const radius = Math.max(sceneRadius * 0.002, 0.0005);

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

    // create a marker and register it as an undoable operation
    private createMarker(position: Vec3) {
        if (!this.root) return;

        const marker = this.makeMarkerEntity(position);
        const op = new AddSamplePointOp(this.root, marker, this.scene);
        // edit.add calls op.do() which adds the marker to the scene
        this.events.fire('edit.add', op);
        this.scene.forceRender = true;
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
        if (!this.root || this.root.children.length === 0) {
            return null;
        }

        const cameraPos = this.scene.camera.mainCamera.getPosition();
        const cameraFwd = this.scene.camera.mainCamera.forward;
        const w = this.canvasContainer.clientWidth;
        const h = this.canvasContainer.clientHeight;

        let closest: Entity | null = null;
        let closestDist = MARKER_PICK_RADIUS;

        for (const child of this.root.children) {
            const marker = child as Entity;
            marker.getWorldTransform().getTranslation(tmpWorld);

            // ignore markers behind the camera (their projection is mirrored)
            tmpDir.sub2(tmpWorld, cameraPos);
            if (tmpDir.dot(cameraFwd) <= 0) {
                continue;
            }

            this.scene.camera.worldToScreen(tmpWorld, tmpScreen);
            const sx = tmpScreen.x * w;
            const sy = tmpScreen.y * h;
            const dist = Math.hypot(sx - px, sy - py);

            if (dist < closestDist) {
                closestDist = dist;
                closest = marker;
            }
        }

        return closest;
    }

    private clearMarkers() {
        this.deselectMarker();
        if (this.root) {
            for (const child of [...this.root.children]) {
                (child as Entity).destroy();
            }
        }
    }
}

export { SamplePointTool };
