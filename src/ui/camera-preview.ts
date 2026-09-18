import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';

// picture-in-picture window rendering the simulated camera shot; the actual
// drawing is done by consumers via the 'cameraPreview.canvas' function which
// exposes the raw canvas element
class CameraPreview extends Container {
    private events: Events;
    private canvasDom: HTMLCanvasElement;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'camera-preview',
            class: 'panel'
        };

        super(args);

        this.events = events;

        this.hidden = true;

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const header = new Container({
            class: 'panel-header'
        });

        const icon = new Label({
            text: '\uE314',
            class: 'panel-header-icon'
        });

        const label = new Label({
            text: '模拟拍摄画面',
            class: 'panel-header-label'
        });

        header.append(icon);
        header.append(label);
        this.append(header);

        const body = new Container({
            id: 'camera-preview-body'
        });

        const canvas = document.createElement('canvas');
        canvas.id = 'camera-preview-canvas';
        canvas.width = 320;
        canvas.height = 240;
        canvas.style.width = '320px';
        canvas.style.height = '240px';
        canvas.style.display = 'block';
        this.canvasDom = canvas;

        body.dom.appendChild(canvas);
        this.append(body);

        // expose the raw canvas element to consumers
        events.function('cameraPreview.canvas', () => this.canvasDom);

        events.on('cameraPreview.visible', (visible: boolean) => {
            this.hidden = !visible;
        });
    }
}

export { CameraPreview };
