import { Container, Label } from '@playcanvas/pcui';
import { Entity, Vec3 } from 'playcanvas';

import towerData from '../../static/datas/distributionTower.json';
import { Events } from '../events';
import { RouteSafetyReport } from '../route/clearance-field';
import { i18n } from './localization';
import routeSvg from './svg/route.svg';
import { Tooltips } from './tooltips';
import { WaypointList, createSvg } from './waypoint-list';

type DeviceEntry = (typeof towerData.data)[number];

class DeviceLedgerPanel extends Container {
    private events: Events;
    private tooltips: Tooltips;

    // waypoint list for device-generated routes (created on first generation)
    private waypointList: WaypointList | null = null;

    // generate button: header icon (kept as a field for the active state)
    private generateBtn: Container;

    // route edit mode: true between generating the route and exiting via a
    // second button click / Escape / route deletion; in this state waypoints
    // are clickable and the waypoint edit panel shows
    private routeActive = false;

    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'device-ledger-panel',
            class: 'panel'
        };

        super(args);

        this.events = events;
        this.tooltips = tooltips;

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

        // generate waypoints & route for the checked devices (same pipeline as
        // the sample point panel's generate button)
        const generateBtn = new Container({
            class: 'panel-header-button'
        });
        generateBtn.dom.appendChild(createSvg(routeSvg));

        header.append(icon);
        header.append(label);
        header.append(generateBtn);

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

        // ── generate waypoints & route for the checked devices ──
        tooltips.register(generateBtn, () => i18n.t('tooltip.deviceLedger.generateRoute'), 'left');
        this.generateBtn = generateBtn;

        // toggle semantics (same as the sample point panel's route button):
        // first click generates + enters route edit mode; second click exits
        // edit mode (the route stays in the scene)
        generateBtn.on('click', () => {
            if (this.routeActive) {
                this.exitRouteMode();
                return;
            }

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

            // route edit mode: activate the sample point tool (waypoint
            // picking lives there) and let it know clicks are for picking,
            // not for placing new sample markers
            if (events.invoke('tool.active') !== 'samplePoint') {
                events.fire('tool.samplePoint');
            }
            events.fire('bottomToolbar.hide');
            events.fire('samplePoint.routeMode', true);
            this.setRouteActive(true);
        });

        // leaving the sample point tool (Escape / another tool selected)
        // exits route edit mode
        events.on('tool.activated', (toolName: string) => {
            if (toolName !== 'samplePoint' && this.routeActive) {
                this.exitRouteMode();
            }
        });

        // ── waypoint list for device-generated routes ──
        events.on('route.generated', (waypoints: { position: Vec3; markerEntity: Entity }[], source: string) => {
            if (source !== 'device') return;

            const list = this.ensureWaypointList();
            list.setWaypoints(waypoints.map((wp, i) => ({
                name: `WP ${i + 1}`,
                position: wp.position,
                markerEntity: wp.markerEntity
            })));
        });

        // ── 条目集合（含转折点）按序广播后重建航点列表行 ──
        // 转折点没有采样点与拍摄任务：只显示名称与坐标，行可点击选中
        events.on('route.entries', (entries: { marker: Entity; kind: 'shot' | 'turn'; position: Vec3 }[], source: string) => {
            if (source !== 'device') return;

            let shotCounter = 0;
            let turnCounter = 0;
            const list = this.ensureWaypointList();
            list.setEntries(entries.map((e) => e.kind === 'shot'
                ? { marker: e.marker, kind: e.kind, position: e.position, name: `WP ${++shotCounter}` }
                : { marker: e.marker, kind: e.kind, position: e.position, name: `转折点 ${++turnCounter}` }
            ));
        });

        events.on('route.validated', (report: RouteSafetyReport) => {
            this.waypointList?.applySafetyReport(report);
        });

        // ── handle panel visibility (toggled from the right toolbar) ──
        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                this.hidden = !visible;
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

    // create the waypoint list component on first generation
    private ensureWaypointList(): WaypointList {
        if (!this.waypointList) {
            this.waypointList = new WaypointList(this.events, this.tooltips, {
                onDelete: () => {
                    // the component already fired 'route.clear' and emptied
                    // itself; drop the empty section from the panel and exit
                    // route edit mode (nothing left to pick)
                    if (this.routeActive) {
                        this.exitRouteMode();
                    }
                    this.waypointList?.destroy();
                    this.waypointList = null;
                }
            });
            this.append(this.waypointList);
        }
        return this.waypointList;
    }

    private setRouteActive(active: boolean) {
        if (this.routeActive === active) return;
        this.routeActive = active;
        this.generateBtn?.class[active ? 'add' : 'remove']('active');
    }

    private exitRouteMode() {
        this.setRouteActive(false);
        this.events.fire('samplePoint.routeMode', false);
        this.events.fire('bottomToolbar.show');
        this.events.fire('tool.move');
    }
}

export { DeviceLedgerPanel };
