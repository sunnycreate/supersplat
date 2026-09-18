import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { Tooltips } from './tooltips';

interface Attitude {
    yaw: number;
    pitch: number;
    focal: number;
}

// slider descriptor: which attitude field it edits and its allowed range.
// the yaw slider edits the RELATIVE gimbal yaw (body frame: 0 = along the
// route heading, + = right / clockwise, as in WPML gimbalYawRotateAngle)
interface SliderSpec {
    key: keyof Attitude;
    label: string;
    min: number;
    max: number;
    unit: string;
}

const sliders: SliderSpec[] = [
    { key: 'yaw', label: '偏航(相对航线)', min: -180, max: 180, unit: '°' },
    { key: 'pitch', label: '俯仰角', min: -90, max: 35, unit: '°' },
    { key: 'focal', label: '焦距', min: 2, max: 20, unit: 'mm' }
];

class WaypointEditPanel extends Container {
    private events: Events;
    private tooltips: Tooltips;

    // currently edited waypoint and its attitude
    private marker: any = null;
    private yaw = 0;
    private pitch = 0;
    private focal = 0;

    private ranges: Record<keyof Attitude, HTMLInputElement> = {} as Record<keyof Attitude, HTMLInputElement>;
    // numeric readouts: a label that turns into a text input on click
    private values: Record<keyof Attitude, { label: Label; input: HTMLInputElement }> = {} as Record<keyof Attitude, { label: Label; input: HTMLInputElement }>;

    private groundDistLabel: Label;
    private shootDistLabel: Label;

    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'waypoint-edit-panel',
            class: 'panel'
        };

        super(args);

        this.events = events;
        this.tooltips = tooltips;

        this.hidden = true;

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const header = new Container({
            class: 'panel-header'
        });

        const icon = new Label({
            text: '\uE302',
            class: 'panel-header-icon'
        });

        const label = new Label({
            text: '编辑航点',
            class: 'panel-header-label'
        });

        header.append(icon);
        header.append(label);
        this.append(header);

        // measured distances for the selected waypoint
        this.groundDistLabel = new Label({
            class: 'wp-edit-info',
            text: '对地距离: --'
        });

        this.shootDistLabel = new Label({
            class: 'wp-edit-info',
            text: '拍摄距离: --'
        });

        this.append(this.groundDistLabel);
        this.append(this.shootDistLabel);

        // yaw / pitch / focal sliders with ±0.1 step buttons
        sliders.forEach((spec) => {
            const row = new Container({
                class: 'wp-edit-slider-row'
            });

            row.append(new Label({
                class: 'wp-edit-slider-name',
                text: spec.label
            }));

            const minus = new Container({
                class: 'wp-edit-step'
            });
            minus.append(new Label({ text: '-' }));

            const plus = new Container({
                class: 'wp-edit-step'
            });
            plus.append(new Label({ text: '+' }));

            const range = document.createElement('input');
            range.type = 'range';
            range.min = spec.min.toString();
            range.max = spec.max.toString();
            range.step = '0.1';
            this.ranges[spec.key] = range;

            const valueLabel = new Label({
                class: 'wp-edit-value',
                text: '--'
            });

            // click the readout to edit it: the label is swapped for a text
            // input; Enter (or blur) commits with the slider range clamp,
            // Escape cancels
            const editInput = document.createElement('input');
            editInput.type = 'text';
            editInput.className = 'wp-edit-value-input';
            editInput.style.display = 'none';

            const endEdit = () => {
                editInput.style.display = 'none';
                valueLabel.hidden = false;
            };
            const commitEdit = () => {
                if (editInput.style.display === 'none') return;
                const parsed = parseFloat(editInput.value);
                if (this.marker !== null && !isNaN(parsed)) {
                    this[spec.key] = Math.min(spec.max, Math.max(spec.min, parsed));
                    this.refreshValues();
                    this.fireAttitudeSet();
                }
                endEdit();
            };
            editInput.addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                    commitEdit();
                } else if (e.key === 'Escape') {
                    endEdit();
                }
            });
            editInput.addEventListener('blur', commitEdit);
            valueLabel.on('click', () => {
                if (this.marker === null || editInput.style.display !== 'none') return;
                valueLabel.hidden = true;
                editInput.value = this[spec.key].toString();
                editInput.style.display = 'block';
                editInput.focus();
                editInput.select();
            });

            this.values[spec.key] = { label: valueLabel, input: editInput };

            row.append(minus);
            row.dom.appendChild(range);
            row.append(plus);
            row.append(valueLabel);
            row.dom.appendChild(editInput);

            const step = (delta: number) => {
                if (this.marker === null) {
                    return;
                }
                const current = this[spec.key];
                this[spec.key] = Math.min(spec.max, Math.max(spec.min, current + delta));
                range.value = this[spec.key].toString();
                this.refreshValues();
                this.fireAttitudeSet();
            };
            minus.on('click', () => step(-0.1));
            plus.on('click', () => step(0.1));

            range.addEventListener('input', () => {
                if (this.marker === null) {
                    return;
                }
                this[spec.key] = parseFloat(range.value);
                this.refreshValues();
                this.fireAttitudeSet();
            });

            this.append(row);
        });

        // arrow pad: hold to move the waypoint position (the keyboard arrows
        // drive the same move events; W/A/S/D stay with the editor camera)
        const wasd = new Container({
            class: 'wp-edit-wasd'
        });

        const moveButtons: { text: string; dir: string; posClass: string }[] = [
            { text: '\u2191', dir: 'forward', posClass: 'wp-edit-move-fwd' },
            { text: '\u2190', dir: 'left', posClass: 'wp-edit-move-left' },
            { text: '\u2193', dir: 'back', posClass: 'wp-edit-move-back' },
            { text: '\u2192', dir: 'right', posClass: 'wp-edit-move-right' }
        ];

        moveButtons.forEach((spec) => {
            const button = new Container({
                class: ['wp-edit-move', spec.posClass]
            });
            button.append(new Label({ text: spec.text }));

            // pcui elements only forward 'click' events, so pointer events are
            // bound directly on the dom (same as menu-panel)
            button.dom.addEventListener('pointerdown', () => {
                this.events.fire('waypointAttitude.moveStart', { marker: this.marker, dir: spec.dir });
            });
            button.dom.addEventListener('pointerup', () => {
                this.events.fire('waypointAttitude.moveEnd');
            });
            button.dom.addEventListener('pointerleave', () => {
                this.events.fire('waypointAttitude.moveEnd');
            });

            this.tooltips.register(button, '移动航点位置（按住）');

            wasd.append(button);
        });

        this.append(wasd);

        // selection: show / hide the panel and load the selected waypoint
        this.events.on('waypointAttitude.selected', (data: any) => {
            if (!data.marker) {
                this.marker = null;
                this.hidden = true;
                return;
            }

            this.marker = data.marker;
            this.applyAttitude(data.attitude);
            // this.yaw holds the RELATIVE gimbal yaw (panel semantics)
            this.yaw = data.relativeYaw ?? 0;

            sliders.forEach((spec) => {
                this.ranges[spec.key].value = this[spec.key].toString();
            });
            this.refreshValues();
            this.refreshInfo(data);

            this.hidden = false;
        });

        // external attitude updates: refresh labels without touching slider
        // positions so an in-progress drag is not interrupted
        this.events.on('waypointAttitude.updated', (data: any) => {
            if (data.marker !== this.marker) {
                return;
            }

            this.applyAttitude(data.attitude);
            this.yaw = data.relativeYaw ?? this.yaw;
            this.refreshValues();
            this.refreshInfo(data);
        });
    }

    // pitch/focal from the world-frame attitude; yaw is handled separately
    // via the relative value in the payload
    private applyAttitude(attitude: Attitude | undefined) {
        if (!attitude) {
            return;
        }
        this.pitch = attitude.pitch;
        this.focal = attitude.focal;
    }

    // numeric labels next to the sliders (1 decimal place + unit)
    private refreshValues() {
        sliders.forEach((spec) => {
            this.values[spec.key].label.text = `${this[spec.key].toFixed(1)}${spec.unit}`;
        });
    }

    // distance info lines; unmeasured (< 0) shows '未测量'
    private refreshInfo(data: any) {
        if (data.groundDist !== undefined && data.groundDist !== null) {
            this.groundDistLabel.text = data.groundDist < 0 ? '对地距离: 未测量' : `对地距离: ${data.groundDist.toFixed(2)} m`;
        }
        if (data.shootDist !== undefined && data.shootDist !== null) {
            this.shootDistLabel.text = data.shootDist < 0 ? '拍摄距离: 未测量' : `拍摄距离: ${data.shootDist.toFixed(2)} m`;
        }
    }

    private fireAttitudeSet() {
        this.events.fire('waypointAttitude.set', {
            marker: this.marker,
            yaw: this.yaw,
            pitch: this.pitch,
            focal: this.focal
        });
    }
}

export { WaypointEditPanel };
