import { Container, Label } from '@playcanvas/pcui';

import towerData from '../../static/datas/distributionTower.json';
import { Events } from '../events';
import { i18n } from './localization';
import exportSvg from './svg/export.svg';
import routeSvg from './svg/route.svg';
import hiddenSvg from './svg/hidden.svg';
import shownSvg from './svg/shown.svg';
import { Tooltips } from './tooltips';

type DeviceEntry = (typeof towerData.data)[number];

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class DeviceLedgerPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'device-ledger-panel',
            class: 'panel'
        };

        super(args);

        // mutually exclusive with the scene panel (initially active)
        this.hidden = true;

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const header = new Container({
            class: 'panel-header'
        });

        const icon = new Label({
            text: '\uE344',
            class: 'panel-header-icon'
        });

        const label = new Label({
            class: 'panel-header-label'
        });
        i18n.bindText(label, 'panel.device-ledger');

        // generate route for the checked devices (same pipeline as the sample
        // point panel's generate button)
        const generateBtn = new Container({
            class: 'panel-header-button'
        });
        generateBtn.dom.appendChild(createSvg(routeSvg));

        // export the current route's waypoints (lon/lat/alt) to the console
        const exportBtn = new Container({
            class: 'panel-header-button'
        });
        exportBtn.dom.appendChild(createSvg(exportSvg));

        // show/hide the shortest-distance indicator lines
        let distVisible = true;
        const distBtn = new Container({
            class: 'panel-header-button'
        });
        distBtn.dom.appendChild(createSvg(distVisible ? shownSvg : hiddenSvg));

        header.append(icon);
        header.append(label);
        header.append(generateBtn);
        header.append(exportBtn);
        header.append(distBtn);

        // body: device ledger list (mocked from static/datas/distributionTower.json)
        const body = new Container({
            id: 'device-ledger-body'
        });

        this.append(header);
        this.append(body);

        // mock device ledger list bundled from static/datas/distributionTower.json
        // (rollup copies static/ selectively, so the file is imported instead
        // of fetched at runtime). clicking a row toggles its bounding box;
        // the checkbox marks the device for route generation.
        let selected: Container | null = null;
        const deselect = () => {
            if (selected) {
                selected.class.remove('selected');
                selected = null;
                events.fire('deviceLedger.deselect');
            }
        };

        const checkedDevices = new Set<DeviceEntry>();

        for (const device of towerData.data ?? []) {
            const row = new Container({ class: 'device-row' });

            // custom checkbox (no pcui checkbox styling in this app)
            const checkbox = new Container({ class: 'device-row-check' });
            const mark = new Container({ class: 'device-row-check-mark' });
            checkbox.append(mark);
            checkbox.dom.addEventListener('click', (e) => {
                e.stopPropagation();
                if (checkedDevices.has(device)) {
                    checkedDevices.delete(device);
                    checkbox.class.remove('checked');
                } else {
                    checkedDevices.add(device);
                    checkbox.class.add('checked');
                }
            });

            row.append(checkbox);
            row.append(new Label({ class: 'device-row-label', text: device.name }));
            row.on('click', () => {
                if (selected === row) {
                    deselect();
                    return;
                }
                deselect();
                selected = row;
                row.class.add('selected');
                events.fire('deviceLedger.select', {
                    name: device.name,
                    bounding: device.value.bounding
                });
            });
            body.append(row);
        }

        // ── generate route for the checked devices ──
        tooltips.register(generateBtn, () => i18n.t('tooltip.deviceLedger.generateRoute'), 'left');

        generateBtn.on('click', () => {
            const devices = [...checkedDevices];
            if (devices.length === 0) {
                // eslint-disable-next-line no-console
                console.log('[DeviceLedger] 未勾选任何设备');
                return;
            }
            events.fire('deviceLedger.generate', devices.map((d) => ({
                name: d.name,
                samplePoint: d.value.samplePoint ?? []
            })));
        });

        // ── export waypoints / toggle distance indicators ──
        tooltips.register(exportBtn, () => '导出航点信息', 'left');
        tooltips.register(distBtn, () => '显示/隐藏最短安全距离指示线', 'left');

        exportBtn.on('click', () => {
            events.fire('route.export');
        });

        distBtn.on('click', () => {
            distVisible = !distVisible;
            distBtn.dom.replaceChildren(createSvg(distVisible ? shownSvg : hiddenSvg));
            events.fire('route.distIndicators', distVisible);
        });

        // ── handle panel visibility (toggled from the right toolbar) ──
        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                this.hidden = !visible;
                // the indicator state is owned by the tool; resync the eye
                // icon in case it was toggled from the sample point panel
                if (visible) {
                    const state = events.invoke('route.distIndicators.state');
                    if (typeof state === 'boolean' && state !== distVisible) {
                        distVisible = state;
                        distBtn.dom.replaceChildren(createSvg(distVisible ? shownSvg : hiddenSvg));
                    }
                }
                events.fire('devicePanel.visible', visible);
            }
        };

        events.function('devicePanel.visible', () => {
            return !this.hidden;
        });

        events.on('devicePanel.setVisible', (visible: boolean) => {
            setVisible(visible);
        });

        events.on('devicePanel.toggleVisible', () => {
            setVisible(this.hidden);
        });
    }
}

export { DeviceLedgerPanel };
