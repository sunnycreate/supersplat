import { Entity, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';

const world = new Vec3();
const screen = new Vec3();
const toPoint = new Vec3();

// Floating name label anchored above the marker whose list row is hovered
// (sample point rows and waypoint rows). Panels announce the hovered marker
// via 'samplePoint.highlight' / 'samplePoint.unhighlight'; the label follows
// the marker by projecting its world position to screen space each prerender,
// so it tracks the ball while the camera moves.
class SceneHoverLabel {
    private el: HTMLDivElement | null = null;
    private scene: Scene | null = null;
    private anchor: Entity | null = null;

    init(events: Events, scene: Scene, container: HTMLElement) {
        if (this.el) return;
        this.scene = scene;

        this.el = document.createElement('div');
        this.el.className = 'scene-hover-label';
        container.appendChild(this.el);

        events.on('samplePoint.highlight', (data: { marker: Entity; name: string }) => {
            this.anchor = data.marker;
            this.el.textContent = data.name;
            this.el.style.display = 'block';
        });
        events.on('samplePoint.unhighlight', () => {
            this.anchor = null;
            this.el.style.display = 'none';
        });

        events.on('prerender', () => this.update());
    }

    private update() {
        const el = this.el;
        const scene = this.scene;
        if (!el || !scene || !this.anchor) return;

        // marker destroyed (row deleted while hovered) or behind the camera
        const camera = scene.camera;
        let visible = !!this.anchor.parent;
        if (visible) {
            this.anchor.getWorldTransform().getTranslation(world);
            toPoint.sub2(world, camera.mainCamera.getPosition());
            if (toPoint.dot(camera.mainCamera.forward) <= 0) visible = false;
        }
        if (!visible) {
            el.style.display = 'none';
            return;
        }

        camera.worldToScreen(world, screen);
        const width = el.parentElement.clientWidth;
        const height = el.parentElement.clientHeight;

        // centered above the ball, with a small gap
        const x = screen.x * width - el.offsetWidth * 0.5;
        const y = screen.y * height - el.offsetHeight - 14;
        el.style.left = `${Math.min(Math.max(x, 4), Math.max(4, width - el.offsetWidth - 4)).toFixed(1)}px`;
        el.style.top = `${Math.max(y, 4).toFixed(1)}px`;
        el.style.display = 'block';
    }
}

const sceneHoverLabel = new SceneHoverLabel();
export { sceneHoverLabel };
