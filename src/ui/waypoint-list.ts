import { Container, Label } from '@playcanvas/pcui';
import { Entity, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { RouteSafetyReport } from '../route/clearance-field';
import { SafetyLevel } from '../route/safety-config';
import { i18n } from './localization';
import deleteSvg from './svg/delete.svg';
import exportSvg from './svg/export.svg';
import hiddenSvg from './svg/hidden.svg';
import routeSvg from './svg/route.svg';
import shownSvg from './svg/shown.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    let svg = svgString;
    if (svgString.startsWith('data:image/svg+xml,')) {
        svg = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    }
    return new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
};

// shield-with-check icon used by the safety validate button
const shieldSvg = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 1L10.5 2.5V6C10.5 8.5 8.5 10.4 6 11C3.5 10.4 1.5 8.5 1.5 6V2.5L6 1Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M4 6.1L5.4 7.5L8 4.9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// one waypoint in the list
interface WaypointEntry {
    name: string;
    position: Vec3;
    markerEntity: Entity;
    // measured distance to the closest obstacle (-1 = not measured)
    clearance: number;
    level: SafetyLevel;
}

// the waypoint sub-list shared by the sample point panel and the device
// ledger panel: header actions (validate / export / indicator toggle /
// delete), per-waypoint rows with clearance bars and a safety summary.
// rows highlight on hover and fly the camera on click.
class WaypointList extends Container {
    private events: Events;
    private tooltips: Tooltips;
    private onDelete: () => void;

    private entries: WaypointEntry[] = [];
    private rows = new Map<Entity, Container>();
    private clearanceLabels = new Map<Entity, Label>();
    private bars = new Map<Entity, { root: Container; fill: HTMLElement }>();

    private listBody: Container;
    private summary: Label;
    private staleHint: Label;
    private distBtn: Container;

    // visibility of the shortest-distance indicator lines; the tool owns the
    // authoritative state and broadcasts 'route.distIndicators.state'
    // (indicators start hidden when a route is generated)
    private distVisible = false;

    constructor(events: Events, tooltips: Tooltips, options: { onDelete?: () => void } = {}) {
        super({ class: 'sample-waypoint-section' });

        this.events = events;
        this.tooltips = tooltips;
        this.onDelete = options.onDelete ?? (() => {});

        // header: icon, title, validate / export / indicator / delete buttons
        const header = new Container({ class: 'sample-waypoint-header' });
        const icon = new Container({ class: 'sample-waypoint-icon' });
        icon.dom.appendChild(createSvg(routeSvg));
        const name = new Label({
            class: 'sample-waypoint-name',
            text: '航点'
        });
        const validateBtn = new Container({ class: 'sample-waypoint-validate' });
        validateBtn.dom.appendChild(createSvg(shieldSvg));
        const exportBtn = new Container({ class: 'sample-waypoint-export' });
        exportBtn.dom.appendChild(createSvg(exportSvg));
        this.distBtn = new Container({ class: 'sample-waypoint-dist' });
        this.distBtn.dom.appendChild(createSvg(this.distVisible ? shownSvg : hiddenSvg));
        const deleteBtn = new Container({ class: 'sample-waypoint-delete' });
        deleteBtn.dom.appendChild(createSvg(deleteSvg));

        header.append(icon);
        header.append(name);
        header.append(validateBtn);
        header.append(exportBtn);
        header.append(this.distBtn);
        header.append(deleteBtn);
        this.append(header);

        // shown when the source order changed after this route was made
        this.staleHint = new Label({
            class: 'sample-waypoint-stale',
            text: '采样点已变更，请重新生成航线',
            hidden: true
        });
        this.append(this.staleHint);

        // waypoint rows
        this.listBody = new Container({ class: 'sample-waypoint-list' });
        this.append(this.listBody);

        // safety summary
        this.summary = new Label({
            class: 'sample-waypoint-summary',
            text: ''
        });
        this.append(this.summary);

        // ── header actions ──
        deleteBtn.on('click', () => {
            this.events.fire('route.clear');
            this.clear();
            this.onDelete();
        });

        validateBtn.on('click', () => {
            this.events.fire('route.safety.request');
        });

        // export the waypoint list to the console; the tool prefers the live
        // marker positions (drag-aware) and converts them to WGS84
        exportBtn.on('click', () => {
            this.events.fire('waypoint.export', this.entries.map(wp => ({
                name: wp.name,
                position: wp.position,
                markerEntity: wp.markerEntity
            })));
        });

        this.distBtn.on('click', () => {
            this.setDistVisible(!this.distVisible);
            this.events.fire('route.distIndicators', this.distVisible);
        });

        // keep the eye icon in sync when toggled from another panel's list
        events.on('route.distIndicators.state', (visible: boolean) => {
            this.setDistVisible(visible);
        });

        tooltips.register(deleteBtn, () => i18n.t('tooltip.samplePoint.deleteFolder'), 'left');
        tooltips.register(validateBtn, () => '安全校验：测量航点与航线到模型的距离', 'left');
        tooltips.register(exportBtn, () => '导出航点信息', 'left');
        tooltips.register(this.distBtn, () => '显示/隐藏最短安全距离指示线', 'left');
    }

    // replace the waypoint rows
    setWaypoints(wps: { name: string; position: Vec3; markerEntity: Entity }[]) {
        this.clear();

        for (const wp of wps) {
            const entry: WaypointEntry = {
                name: wp.name,
                position: wp.position,
                markerEntity: wp.markerEntity,
                clearance: -1,
                level: SafetyLevel.unknown
            };
            this.entries.push(entry);

            const row = new Container({ class: 'sample-waypoint-row' });
            const name = new Label({
                class: 'sample-point-name',
                text: wp.name
            });
            const bar = this.makeClearanceBar();
            const clearance = new Label({
                class: 'sample-wp-clearance',
                text: this.clearanceText(entry.clearance)
            });
            row.append(name);
            row.append(bar.root);
            row.append(clearance);
            this.listBody.append(row);

            this.rows.set(wp.markerEntity, row);
            this.clearanceLabels.set(wp.markerEntity, clearance);
            this.bars.set(wp.markerEntity, bar);

            // hover to highlight the waypoint
            row.dom.addEventListener('pointerenter', () => {
                this.events.fire('samplePoint.highlight', wp.markerEntity);
            });
            row.dom.addEventListener('pointerleave', () => {
                this.events.fire('samplePoint.unhighlight', wp.markerEntity);
            });

            // click to fly the camera to this waypoint
            row.dom.addEventListener('click', () => {
                this.events.fire('samplePoint.focus', wp.markerEntity);
            });
        }
    }

    setStale(stale: boolean) {
        this.staleHint.hidden = !stale;
    }

    // apply a measurement report; returns true if any row was updated
    applySafetyReport(report: RouteSafetyReport): boolean {
        const byEntity = new Map<Entity, { clearance: number; level: SafetyLevel }>();
        for (const w of report.waypoints) {
            byEntity.set(w.entity, { clearance: w.clearance, level: w.level });
        }

        let dirty = false;
        for (const entry of this.entries) {
            const result = byEntity.get(entry.markerEntity);
            if (!result) continue;
            dirty = true;

            entry.clearance = result.clearance;
            entry.level = result.level;

            const label = this.clearanceLabels.get(entry.markerEntity);
            if (label) {
                label.text = this.clearanceText(entry.clearance);
                this.setLevelClass(label, entry.level);
            }

            const bar = this.bars.get(entry.markerEntity);
            if (bar) {
                this.updateClearanceBar(bar, entry.clearance, entry.level, report.hardClearance);
            }

            const row = this.rows.get(entry.markerEntity);
            if (row) {
                this.setLevelClass(row, entry.level);
            }
        }

        if (dirty) {
            this.updateSummary(report);
        }
        return dirty;
    }

    // remove all waypoints
    clear() {
        this.entries = [];
        this.rows.clear();
        this.clearanceLabels.clear();
        this.bars.clear();
        this.listBody.clear();
        this.summary.text = '';
        this.summary.class.remove('danger');
        this.setStale(false);
    }

    private setDistVisible(visible: boolean) {
        this.distVisible = visible;
        this.distBtn.dom.replaceChildren(createSvg(visible ? shownSvg : hiddenSvg));
    }

    // ── safety reporting ──

    private clearanceText(clearance: number) {
        return clearance < 0 ? '未测量' : `${clearance.toFixed(2)} m`;
    }

    // a small horizontal line whose length is the measured clearance. the scale
    // runs 0 → 2× hardClearance, with a tick marking the hard constraint, so a
    // bar reaching the tick is exactly at the limit and past it is safe.
    private makeClearanceBar(): { root: Container; fill: HTMLElement } {
        const root = new Container({ class: 'sample-wp-bar' });

        const fill = document.createElement('div');
        fill.className = 'sample-wp-bar-fill';
        root.dom.appendChild(fill);

        const tick = document.createElement('div');
        tick.className = 'sample-wp-bar-tick';
        root.dom.appendChild(tick);

        return { root, fill };
    }

    private updateClearanceBar(bar: { root: Container; fill: HTMLElement }, clearance: number, level: SafetyLevel, hardClearance: number) {
        const max = hardClearance * 2;
        const pct = clearance < 0 ? 0 : Math.max(2, Math.min(100, (clearance / max) * 100));
        bar.fill.style.width = `${pct}%`;
        bar.fill.classList.toggle('danger', level === SafetyLevel.danger);
        bar.root.dom.title = clearance < 0 ?
            '未测量' :
            `距最近模型 ${clearance.toFixed(2)} m（安全要求 ≥ ${hardClearance.toFixed(1)} m）`;
    }

    private setLevelClass(element: Container | Label, level: SafetyLevel) {
        element.class.remove('danger');
        if (level === SafetyLevel.danger) {
            element.class.add('danger');
        }
    }

    private updateSummary(report: RouteSafetyReport) {
        const summary = this.summary;
        summary.class.remove('danger');

        if (!report.ready) {
            summary.text = '安全校验不可用（无可测量模型）';
            summary.class.add('danger');
            return;
        }

        const min = report.minClearance;
        const minText = min < 0 ? '—' : `${min.toFixed(2)} m`;

        // unsafe when a waypoint is flagged, or when the tightest measured
        // spot anywhere on the route (waypoint or segment sample) falls
        // inside the hard clearance — segments never carry a danger level
        // themselves (detour failures keep the straight leg), so the min
        // value is the only witness for them
        const routeTooClose = min >= 0 && min < report.hardClearance;
        if (report.dangerCount > 0) {
            summary.text = `最小安全间距 ${minText} · 危险航点 ${report.dangerCount} 处（要求 ≥ ${report.hardClearance.toFixed(1)} m）`;
            summary.class.add('danger');
        } else if (routeTooClose) {
            summary.text = `最小安全间距 ${minText} · 航线间距不足（要求 ≥ ${report.hardClearance.toFixed(1)} m）`;
        } else {
            summary.text = `最小安全间距 ${minText} · 合格（要求 ≥ ${report.hardClearance.toFixed(1)} m）`;
        }
    }
}

export { WaypointList, createSvg };
