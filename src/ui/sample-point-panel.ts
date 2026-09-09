import { Container, Element, Label } from '@playcanvas/pcui';

import { Entity, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { RouteSafetyReport } from '../route/clearance-field';
import { SafetyLevel } from '../route/safety-config';
import { i18n } from './localization';
import { MenuPanel } from './menu-panel';
import { Tooltips } from './tooltips';
import deleteSvg from './svg/delete.svg';
import folderNewSvg from './svg/folder-new.svg';
import folderSvg from './svg/folder.svg';
import routeSvg from './svg/route.svg';
import samplePointSvg from './svg/sample-point-small.svg';

const createSvg = (svgString: string) => {
    let svg = svgString;
    if (svgString.startsWith('data:image/svg+xml,')) {
        svg = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    }
    return new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
};

// shield-with-check icon used by the safety validate button
const shieldSvg = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 1L10.5 2.5V6C10.5 8.5 8.5 10.4 6 11C3.5 10.4 1.5 8.5 1.5 6V2.5L6 1Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M4 6.1L5.4 7.5L8 4.9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// plus icon used by the per-point insert button
const plusSvg = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 2V10M2 6H10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

let folderCounter = 0;
let pointCounter = 0;

interface SamplePointData {
    id: string;
    name: string;
    position: Vec3;
    normal: Vec3;
    wgs84: { lat: number; lon: number; alt: number } | null;
    markerEntity: Entity;
    // no safe hover point could be found for this sample point (P1)
    unsolvable: boolean;
}

interface WaypointData {
    id: string;
    name: string;
    position: Vec3;
    markerEntity: Entity;
    // measured distance to the closest obstacle (-1 = not measured)
    clearance: number;
    level: SafetyLevel;
}

interface SampleFolder {
    id: string;
    name: string;
    expanded: boolean;
    addingPoints: boolean;
    routeActive: boolean;
    // the sample point order changed after the route was generated, so the
    // waypoint order no longer matches
    routeStale: boolean;
    points: SamplePointData[];
    waypoints: WaypointData[];
}

class SamplePointPanel extends Container {
    private events: Events;
    private tooltips: Tooltips;

    private folders: SampleFolder[] = [];
    private activeFolderId: string | null = null;

    private folderListContainer: Container;
    private folderElements: Map<string, {
        header: Container;
        content: Container;
        items: Map<string, Container>;
        emptyRow: Container | null;
        waypointSection: Container | null;
        waypointItems: Map<string, Container>;
        waypointClearance: Map<string, Label>;
        waypointBars: Map<string, { root: Container; fill: HTMLElement }>;
        waypointSummary: Label | null;
        waypointStale: Label | null;
    }> = new Map();

    // latest measurement reported by the tool
    private safetyReport: RouteSafetyReport | null = null;

    // marker → folder it was created in, so an undone point can be restored to
    // the same folder on redo
    private markerFolders = new Map<Entity, string>();

    // marker → index it was created at, so a redone point is inserted back in
    // place instead of appended
    private insertIndexByMarker = new Map<Entity, number>();

    // where the next sample point will be inserted (-1 = append). set when the
    // user picks 前插/后插 from a row's dropdown
    private pendingInsertIndex = -1;

    // shared dropdown behind each row's insert button
    private insertMenu: MenuPanel;
    private insertTarget: { folderId: string; index: number } | null = null;

    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'sample-point-panel',
            class: 'panel'
        };

        super(args);

        this.events = events;
        this.tooltips = tooltips;

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // ── shared dropdown behind each row's insert button ──
        // appended to body so the scrollable panel can't clip it
        this.insertMenu = new MenuPanel([
            {
                text: () => '在此点之前插入',
                onSelect: () => this.beginInsert(0)
            },
            {
                text: () => '在此点之后插入',
                onSelect: () => this.beginInsert(1)
            }
        ]);

        // #app-container is appended to body after this panel is created, and it
        // is a positioned full-viewport element with an auto z-index, so it would
        // paint over the menu without an explicit one
        this.insertMenu.dom.style.zIndex = '100';
        document.body.appendChild(this.insertMenu.dom);

        // close the dropdown when clicking anywhere else (same pattern as menu.ts)
        const closeInsertMenu = (event: Event) => {
            if (this.insertMenu.hidden) return;
            const target = event.target as HTMLElement;
            if (this.insertMenu.dom.contains(target)) return;
            // clicking another row's insert button just moves the menu
            if (target?.closest?.('.sample-point-insert')) return;
            this.insertMenu.hidden = true;
        };
        window.addEventListener('pointerdown', closeInsertMenu, true);
        window.addEventListener('pointerup', closeInsertMenu, true);
        window.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                this.insertMenu.hidden = true;
            }
        });

        // ── panel header ──
        const header = new Container({ class: 'panel-header' });

        const headerIcon = new Label({
            text: '\uE344',
            class: 'panel-header-icon'
        });

        const headerLabel = new Label({
            class: 'panel-header-label'
        });
        i18n.bindText(headerLabel, 'panel.samplePoint');

        const addFolderBtn = new Container({
            class: 'panel-header-button'
        });
        addFolderBtn.dom.appendChild(createSvg(folderNewSvg));

        addFolderBtn.on('click', () => {
            this.addFolder();
        });

        header.append(headerIcon);
        header.append(headerLabel);
        header.append(addFolderBtn);

        tooltips.register(addFolderBtn, () => i18n.t('tooltip.samplePoint.addFolder'), 'top');

        // ── folder list (scrollable) ──
        this.folderListContainer = new Container({
            class: 'sample-folder-list'
        });

        // empty state hint
        const emptyHint = new Label({
            class: 'sample-empty-hint',
            text: 'Click + to create a folder'
        });
        this.folderListContainer.append(emptyHint);

        this.append(header);
        this.append(this.folderListContainer);

        // ── listen for sample point creation from the tool ──
        // fired by AddSamplePointOp.do(), so it also covers redo
        events.on('samplePoint.created', (data: { position: Vec3; normal: Vec3; wgs84: { lat: number; lon: number; alt: number } | null; markerEntity: Entity }) => {
            // on redo the user may no longer be in 'adding points' mode, so fall
            // back to the folder the marker originally belonged to
            const folderId = this.activeFolderId ?? this.markerFolders.get(data.markerEntity);
            if (!folderId) return;
            this.markerFolders.set(data.markerEntity, folderId);
            this.addPointToFolder(folderId, data);
        });

        // ── undo (or a discarded op) removed a marker: drop its row ──
        events.on('samplePoint.removed', (marker: Entity) => {
            for (const folder of this.folders) {
                const point = folder.points.find(p => p.markerEntity === marker);
                if (point) {
                    this.deletePoint(folder.id, point.id, false);
                    return;
                }
            }
        });

        // ── listen for tool deactivation (e.g. user pressed Escape or switched tool) ──
        events.on('tool.activated', (toolName: string) => {
            if (toolName !== 'samplePoint') {
                if (this.activeFolderId) {
                    this.stopAddingPoints();
                }
                // exit route editing for any active route folder
                for (const folder of this.folders) {
                    if (folder.routeActive) {
                        this.stopRouteEditing(folder.id);
                    }
                }
            }
        });

        // ── listen for generated waypoints from the tool ──
        events.on('route.generated', (waypoints: { position: Vec3; markerEntity: Entity }[]) => {
            this.addWaypointsToFolder(waypoints);
        });

        // ── listen for the obstacle measurement of the route ──
        events.on('route.validated', (report: RouteSafetyReport) => {
            this.safetyReport = report;
            this.applySafetyReport(report);
        });

        // ── sample points that got no safe hover point (P1) ──
        events.on('route.unsolvable', (indices: number[]) => {
            const folder = this.folders.find(f => f.routeActive);
            if (!folder) return;
            const el = this.folderElements.get(folder.id);
            if (!el) return;

            for (const i of indices) {
                const point = folder.points[i];
                if (!point) continue;
                point.unsolvable = true;

                const row = el.items.get(point.id);
                if (row) {
                    row.class.add('danger');
                    row.dom.title = '无法找到安全悬停点，未生成航点';
                }
            }
        });
    }

    // ── position the panel below scene-panel ──
    updatePosition(scenePanelDom: HTMLElement) {
        const rect = scenePanelDom.getBoundingClientRect();
        this.dom.style.top = `${rect.bottom + 8}px`;
    }

    // ── folder management ──
    private addFolder() {
        const id = `folder-${++folderCounter}`;
        const folder: SampleFolder = {
            id,
            name: `Folder ${folderCounter}`,
            expanded: true,
            addingPoints: false,
            routeActive: false,
            routeStale: false,
            points: [],
            waypoints: []
        };
        this.folders.push(folder);
        this.renderFolder(folder);

        // hide empty hint
        const hint = this.folderListContainer.dom.querySelector('.sample-empty-hint');
        if (hint) {
            (hint as HTMLElement).style.display = 'none';
        }
    }

    private renderFolder(folder: SampleFolder) {
        const folderEl = new Container({
            class: ['sample-folder', folder.expanded ? 'expanded' : 'collapsed']
        });
        folderEl.dom.dataset.folderId = folder.id;

        // folder header
        const header = new Container({ class: 'sample-folder-header' });

        // expand/collapse toggle
        const toggle = new Container({ class: 'sample-folder-toggle' });
        toggle.dom.appendChild(createSvg('<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'));

        // folder icon
        const icon = new Container({ class: 'sample-folder-icon' });
        icon.dom.appendChild(createSvg(folderSvg));

        // folder name
        const name = new Label({
            class: 'sample-folder-name',
            text: folder.name
        });

        // add sample point button
        const addPointBtn = new Container({ class: 'sample-folder-add-point' });
        addPointBtn.dom.appendChild(createSvg(samplePointSvg));

        // generate route button
        const routeBtn = new Container({ class: 'sample-folder-route' });
        routeBtn.dom.appendChild(createSvg(routeSvg));

        // delete folder button
        const deleteBtn = new Container({ class: 'sample-folder-delete' });
        deleteBtn.dom.appendChild(createSvg(deleteSvg));

        header.append(toggle);
        header.append(icon);
        header.append(name);
        header.append(addPointBtn);
        header.append(routeBtn);
        header.append(deleteBtn);

        // folder content (point list)
        const content = new Container({ class: 'sample-folder-content' });

        // shown when the folder has no points yet, so there is something to
        // click before the first point exists
        const emptyRow = new Container({
            class: 'sample-point-empty-row',
            hidden: folder.points.length > 0
        });
        const emptyRowLabel = new Label({
            class: 'sample-point-empty-row-label',
            text: '＋ 新增第一个采样点'
        });
        emptyRow.append(emptyRowLabel);
        content.append(emptyRow);

        folderEl.append(header);
        folderEl.append(content);

        this.folderListContainer.append(folderEl);

        this.folderElements.set(folder.id, {
            header,
            content,
            items: new Map(),
            emptyRow,
            waypointSection: null,
            waypointItems: new Map(),
            waypointClearance: new Map(),
            waypointBars: new Map(),
            waypointSummary: null,
            waypointStale: null
        });

        // ── event handlers ──
        toggle.on('click', () => {
            folder.expanded = !folder.expanded;
            folderEl.class[folder.expanded ? 'add' : 'remove']('expanded');
        });

        addPointBtn.on('click', () => {
            if (folder.addingPoints) {
                // stop adding
                this.stopAddingPoints();
            } else {
                this.startAddingPoints(folder.id);
            }
        });

        emptyRow.on('click', () => {
            this.startAddingPoints(folder.id, 0);
        });

        deleteBtn.on('click', () => {
            this.deleteFolder(folder.id);
        });

        routeBtn.on('click', () => {
            this.toggleRouteMode(folder.id);
        });

        this.tooltips.register(addPointBtn, () => i18n.t('tooltip.samplePoint.addPoint'), 'left');
        this.tooltips.register(routeBtn, () => i18n.t('tooltip.samplePoint.generateRoute'), 'left');
        this.tooltips.register(deleteBtn, () => i18n.t('tooltip.samplePoint.deleteFolder'), 'left');
    }

    private deleteFolder(folderId: string) {
        const folder = this.folders.find(f => f.id === folderId);
        if (!folder) return;

        // stop adding if this folder was active
        if (this.activeFolderId === folderId) {
            this.stopAddingPoints();
        }

        // stop route editing and clear route if active
        if (folder.routeActive) {
            this.stopRouteEditing(folderId);
        }
        if (folder.waypoints.length > 0) {
            this.events.fire('route.clear');
        }

        // destroy all marker entities
        for (const point of folder.points) {
            if (point.markerEntity) {
                point.markerEntity.destroy();
                this.markerFolders.delete(point.markerEntity);
                this.insertIndexByMarker.delete(point.markerEntity);
            }
        }

        // remove UI - find the folder root element and remove it
        const folderDom = this.folderListContainer.dom.querySelector(`[data-folder-id="${folderId}"]`);
        if (folderDom) {
            folderDom.remove();
        }

        this.folders = this.folders.filter(f => f.id !== folderId);
        this.folderElements.delete(folderId);

        this.events.fire('samplePoint.forceRender');

        // show empty hint if no folders left
        if (this.folders.length === 0) {
            const hint = this.folderListContainer.dom.querySelector('.sample-empty-hint');
            if (hint) {
                (hint as HTMLElement).style.display = '';
            }
        }
    }

    // ── adding points mode ──

    // enter adding mode. insertIndex >= 0 means the next point goes at that
    // position in the list (from a row's 前插/后插 dropdown); -1 appends.
    private startAddingPoints(folderId: string, insertIndex = -1) {
        // stop any previous active folder
        if (this.activeFolderId) {
            this.setFolderAddingState(this.activeFolderId, false);
        }

        this.activeFolderId = folderId;
        this.setFolderAddingState(folderId, true);
        this.setInsertHint(insertIndex);
        this.pendingInsertIndex = insertIndex;

        // hide bottom toolbar
        this.events.fire('bottomToolbar.hide');

        this.activateSamplePointTool();
    }

    // Switch to the sample point tool, unless it is already the active one.
    // Firing tool.samplePoint while it is active toggles it off (see
    // ToolManager.activate), which would immediately cancel the mode we just
    // entered — that is what happened when picking 前插/后插 while already marking.
    private activateSamplePointTool() {
        if (this.events.invoke('tool.active') !== 'samplePoint') {
            this.events.fire('tool.samplePoint');
        }
    }

    private stopAddingPoints() {
        if (!this.activeFolderId) return;

        this.setFolderAddingState(this.activeFolderId, false);
        this.setInsertHint(-1);
        this.pendingInsertIndex = -1;
        this.activeFolderId = null;

        // show bottom toolbar
        this.events.fire('bottomToolbar.show');

        // deactivate the tool by activating a neutral tool (move)
        this.events.fire('tool.move');
    }

    // highlight the row the next point will be inserted before
    private setInsertHint(index: number) {
        for (const folder of this.folders) {
            const el = this.folderElements.get(folder.id);
            if (!el) continue;
            for (const row of el.items.values()) {
                row.class.remove('insert-hint');
                row.dom.title = '';
            }
        }

        if (index < 0 || !this.activeFolderId) return;
        const folder = this.folders.find(f => f.id === this.activeFolderId);
        const el = folder && this.folderElements.get(folder.id);
        const next = folder?.points[index];
        const row = next && el?.items.get(next.id);
        if (row) {
            row.class.add('insert-hint');
            row.dom.title = '下一个采样点将插入到此点之前';
        }
    }

    // ── insert dropdown ──

    private openInsertMenu(anchor: HTMLElement, folderId: string, index: number) {
        this.insertTarget = { folderId, index };
        this.insertMenu.position(anchor, 'bottom', 2);
        this.insertMenu.hidden = false;

        // keep the menu inside the viewport (measured after it is shown, since a
        // hidden element reports a zero-sized rect)
        const rect = this.insertMenu.dom.getBoundingClientRect();
        if (rect.bottom > window.innerHeight) {
            this.insertMenu.dom.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
        }
        if (rect.right > window.innerWidth) {
            this.insertMenu.dom.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
        }
    }

    // offset 0 = before the target point, 1 = after it
    private beginInsert(offset: number) {
        const target = this.insertTarget;
        this.insertTarget = null;
        this.insertMenu.hidden = true;
        if (!target) return;

        this.startAddingPoints(target.folderId, target.index + offset);
    }

    // show the placeholder row only while the folder has no points
    private updateEmptyRow(folder: SampleFolder) {
        const el = this.folderElements.get(folder.id);
        if (el?.emptyRow) {
            el.emptyRow.hidden = folder.points.length > 0;
        }
    }

    // the sample point order no longer matches the generated waypoint order
    private markRouteStale(folder: SampleFolder) {
        if (folder.waypoints.length === 0) return;
        folder.routeStale = true;
        const el = this.folderElements.get(folder.id);
        if (el?.waypointStale) {
            el.waypointStale.hidden = false;
        }
    }

    private setFolderAddingState(folderId: string, adding: boolean) {
        const folder = this.folders.find(f => f.id === folderId);
        if (!folder) return;

        folder.addingPoints = adding;

        const el = this.folderElements.get(folderId);
        if (el) {
            el.header.class[adding ? 'add' : 'remove']('adding');
        }
    }

    // ── point management ──
    private addPointToFolder(folderId: string, data: { position: Vec3; normal: Vec3; wgs84: { lat: number; lon: number; alt: number } | null; markerEntity: Entity }) {
        const folder = this.folders.find(f => f.id === folderId);
        if (!folder) return;

        // a redone point goes back where it was created; otherwise the pending
        // index from the 前插/后插 dropdown decides (-1 appends)
        const recorded = this.insertIndexByMarker.get(data.markerEntity);
        const index = recorded !== undefined ? recorded : this.pendingInsertIndex;
        const insertAt = (index >= 0 && index <= folder.points.length) ? index : folder.points.length;

        const pointId = `point-${++pointCounter}`;
        const point: SamplePointData = {
            id: pointId,
            name: `Point ${insertAt + 1}`,
            position: data.position,
            normal: data.normal,
            wgs84: data.wgs84,
            markerEntity: data.markerEntity,
            unsolvable: false
        };

        folder.points.splice(insertAt, 0, point);
        this.insertIndexByMarker.set(point.markerEntity, insertAt);
        this.renderPoint(folder, point);
        this.renumberPoints(folder);
        this.updateEmptyRow(folder);

        // a fresh point invalidates the generated waypoint order
        this.markRouteStale(folder);

        // consecutive points keep stacking at the same spot, in click order
        if (recorded === undefined && this.pendingInsertIndex >= 0) {
            this.pendingInsertIndex = insertAt + 1;
            this.setInsertHint(this.pendingInsertIndex);
        }
    }

    private renderPoint(folder: SampleFolder, point: SamplePointData) {
        const folderEl = this.folderElements.get(folder.id);
        if (!folderEl) return;

        const item = new Container({ class: 'sample-point-item' });
        item.dom.dataset.pointId = point.id;

        // point icon
        const icon = new Container({ class: 'sample-point-icon' });
        icon.dom.appendChild(createSvg(samplePointSvg));

        // point name
        const name = new Label({
            class: 'sample-point-name',
            text: point.name
        });

        // point info (WGS84 or scene coords)
        const infoText = point.wgs84
            ? `lat:${point.wgs84.lat.toFixed(6)}, lon:${point.wgs84.lon.toFixed(6)}, alt:${point.wgs84.alt.toFixed(1)}`
            : `(${point.position.x.toFixed(1)}, ${point.position.y.toFixed(1)}, ${point.position.z.toFixed(1)})`;
        const info = new Label({
            class: 'sample-point-info',
            text: infoText
        });

        // insert button (before/after this point)
        const insertBtn = new Container({ class: 'sample-point-insert' });
        insertBtn.dom.appendChild(createSvg(plusSvg));

        // delete button
        const deleteBtn = new Container({ class: 'sample-point-delete' });
        deleteBtn.dom.appendChild(createSvg(deleteSvg));

        item.append(icon);
        item.append(name);
        item.append(info);
        item.append(insertBtn);
        item.append(deleteBtn);

        // place the row at the point's list position, before the waypoint section
        const index = folder.points.indexOf(point);
        const nextPoint = folder.points[index + 1];
        const refDom = (nextPoint && folderEl.items.get(nextPoint.id)?.dom) || folderEl.waypointSection?.dom || null;
        if (refDom && refDom.parentNode === folderEl.content.dom) {
            folderEl.content.dom.insertBefore(item.dom, refDom);
        } else {
            folderEl.content.append(item);
        }
        folderEl.items.set(point.id, item);

        // expand folder if collapsed
        if (!folder.expanded) {
            folder.expanded = true;
            const folderDom = this.folderListContainer.dom.querySelector(`[data-folder-id="${folder.id}"]`);
            if (folderDom) {
                folderDom.classList.add('expanded');
            }
        }

        // ── insert dropdown ──
        insertBtn.dom.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            const idx = folder.points.indexOf(point);
            this.openInsertMenu(insertBtn.dom, folder.id, idx);
        });

        // ── delete handler ──
        deleteBtn.on('click', () => {
            this.deletePoint(folder.id, point.id);
        });

        // ── hover: highlight the corresponding marker in 3D ──
        item.dom.addEventListener('pointerenter', () => {
            this.events.fire('samplePoint.highlight', point.markerEntity);
        });
        item.dom.addEventListener('pointerleave', () => {
            this.events.fire('samplePoint.unhighlight', point.markerEntity);
        });

        // ── click: fly the camera to this sample point ──
        item.dom.addEventListener('click', (e: Event) => {
            // ignore clicks that landed on the delete or insert buttons
            if ((e.target as HTMLElement)?.closest('.sample-point-delete')) return;
            if ((e.target as HTMLElement)?.closest('.sample-point-insert')) return;
            this.events.fire('samplePoint.focus', point.markerEntity);
        });
    }

    // remove a point row. destroyEntity is false when reacting to an undo so the
    // marker survives for a redo
    private deletePoint(folderId: string, pointId: string, destroyEntity = true) {
        const folder = this.folders.find(f => f.id === folderId);
        if (!folder) return;

        const idx = folder.points.findIndex(p => p.id === pointId);
        if (idx === -1) return;

        const point = folder.points[idx];

        // destroy the marker entity unless the caller is reacting to an undo:
        // the edit history re-adds the same entity on redo
        if (destroyEntity && point.markerEntity) {
            point.markerEntity.destroy();
            this.markerFolders.delete(point.markerEntity);
            this.insertIndexByMarker.delete(point.markerEntity);
        }

        folder.points.splice(idx, 1);

        // remove UI
        const el = this.folderElements.get(folderId);
        if (el) {
            const item = el.items.get(pointId);
            if (item) {
                el.content.remove(item);
                el.items.delete(pointId);
            }
        }

        // re-number remaining points in the folder
        this.renumberPoints(folder);
        this.updateEmptyRow(folder);
        this.markRouteStale(folder);

        this.events.fire('samplePoint.forceRender');
    }

    // re-assign sequential numbers (from 1) to all points in a folder
    private renumberPoints(folder: SampleFolder) {
        const el = this.folderElements.get(folder.id);
        folder.points.forEach((point, i) => {
            const number = i + 1;
            point.name = `Point ${number}`;
            // update UI label
            if (el) {
                const item = el.items.get(point.id);
                if (item) {
                    const nameDom = item.dom.querySelector('.sample-point-name') as HTMLElement | null;
                    if (nameDom) {
                        nameDom.textContent = point.name;
                    }
                }
            }
        });
    }

    // ── route management ──

    // toggle the route button: first click generates + enters edit mode,
    // second click exits edit mode (route stays in the scene)
    private toggleRouteMode(folderId: string) {
        const folder = this.folders.find(f => f.id === folderId);
        if (!folder) return;

        if (folder.routeActive) {
            this.stopRouteEditing(folderId);
        } else {
            this.startRouteEditing(folderId);
        }
    }

    private startRouteEditing(folderId: string) {
        const folder = this.folders.find(f => f.id === folderId);
        if (!folder || folder.points.length === 0) return;

        // stop sample point creation if active
        if (this.activeFolderId) {
            this.stopAddingPoints();
        }

        // stop any other folder's route editing
        for (const f of this.folders) {
            if (f.routeActive) {
                this.stopRouteEditing(f.id);
            }
        }

        folder.routeActive = true;
        this.setFolderRouteState(folderId, true);

        // hide bottom toolbar and activate the sample point tool
        this.events.fire('bottomToolbar.hide');
        this.activateSamplePointTool();

        // generate route (tool fires route.generated when done)
        const points = folder.points.map(p => ({
            position: p.position,
            normal: p.normal
        }));
        this.events.fire('samplePoint.generateRoute', points);

        // enter route edit mode in the tool
        this.events.fire('samplePoint.routeMode', true);
    }

    private stopRouteEditing(folderId: string) {
        const folder = this.folders.find(f => f.id === folderId);
        if (!folder) return;

        folder.routeActive = false;
        this.setFolderRouteState(folderId, false);

        this.events.fire('samplePoint.routeMode', false);
        this.events.fire('bottomToolbar.show');
        this.events.fire('tool.move');
    }

    private setFolderRouteState(folderId: string, active: boolean) {
        const el = this.folderElements.get(folderId);
        if (el) {
            el.header.class[active ? 'add' : 'remove']('route-active');
        }
    }

    // add generated waypoints to the folder that has routeActive = true
    private addWaypointsToFolder(waypoints: { position: Vec3; markerEntity: Entity }[]) {
        const folder = this.folders.find(f => f.routeActive);
        if (!folder) return;

        // a fresh generation clears previous 'no safe hover point' marks
        const el = this.folderElements.get(folder.id);
        for (const point of folder.points) {
            point.unsolvable = false;
            const row = el?.items.get(point.id);
            if (row) {
                row.class.remove('danger');
                row.dom.title = '';
            }
        }

        // and the stale-order hint
        folder.routeStale = false;
        if (el?.waypointStale) {
            el.waypointStale.hidden = true;
        }

        folder.waypoints = [];
        let wpCounter = 0;
        for (const wp of waypoints) {
            const id = `wp-${++pointCounter}`;
            const data: WaypointData = {
                id,
                name: `WP ${++wpCounter}`,
                position: wp.position,
                markerEntity: wp.markerEntity,
                clearance: -1,
                level: SafetyLevel.unknown
            };
            folder.waypoints.push(data);
        }

        this.renderWaypointSection(folder);
    }

    // render the waypoint sub-folder inside the folder content
    private renderWaypointSection(folder: SampleFolder) {
        const el = this.folderElements.get(folder.id);
        if (!el) return;

        // remove existing section
        if (el.waypointSection) {
            el.content.remove(el.waypointSection);
        }
        el.waypointItems.clear();
        el.waypointClearance.clear();
        el.waypointBars.clear();
        el.waypointSummary = null;

        const section = new Container({ class: 'sample-waypoint-section' });

        // sub-folder header
        const wpHeader = new Container({ class: 'sample-waypoint-header' });
        const wpIcon = new Container({ class: 'sample-waypoint-icon' });
        wpIcon.dom.appendChild(createSvg(routeSvg));
        const wpName = new Label({
            class: 'sample-waypoint-name',
            text: '航点'
        });
        const wpValidateBtn = new Container({ class: 'sample-waypoint-validate' });
        wpValidateBtn.dom.appendChild(createSvg(shieldSvg));
        const wpDeleteBtn = new Container({ class: 'sample-waypoint-delete' });
        wpDeleteBtn.dom.appendChild(createSvg(deleteSvg));

        wpHeader.append(wpIcon);
        wpHeader.append(wpName);
        wpHeader.append(wpValidateBtn);
        wpHeader.append(wpDeleteBtn);
        section.append(wpHeader);

        // shown when the sample point order changed after this route was made
        const staleHint = new Label({
            class: 'sample-waypoint-stale',
            text: '采样点已变更，请重新生成航线',
            hidden: !folder.routeStale
        });
        section.append(staleHint);
        el.waypointStale = staleHint;

        // waypoint rows
        const wpList = new Container({ class: 'sample-waypoint-list' });
        for (const wp of folder.waypoints) {
            const row = new Container({ class: 'sample-waypoint-row' });
            const name = new Label({
                class: 'sample-point-name',
                text: wp.name
            });
            // line segment visualising the measured clearance
            const bar = this.makeClearanceBar();
            const clearance = new Label({
                class: 'sample-wp-clearance',
                text: this.clearanceText(wp.clearance)
            });
            row.append(name);
            row.append(bar.root);
            row.append(clearance);
            wpList.append(row);

            el.waypointItems.set(wp.id, row);
            el.waypointClearance.set(wp.id, clearance);
            el.waypointBars.set(wp.id, bar);

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
        section.append(wpList);

        // safety summary
        const summary = new Label({
            class: 'sample-waypoint-summary',
            text: ''
        });
        section.append(summary);
        el.waypointSummary = summary;

        el.content.append(section);
        el.waypointSection = section;

        // delete handler
        wpDeleteBtn.on('click', () => {
            this.deleteWaypoints(folder.id);
        });

        // re-run the obstacle measurement
        wpValidateBtn.on('click', () => {
            this.events.fire('route.safety.request');
        });

        this.tooltips.register(wpDeleteBtn, () => i18n.t('tooltip.samplePoint.deleteFolder'), 'left');
        this.tooltips.register(wpValidateBtn, () => '安全校验：测量航点与航线到模型的距离', 'left');

        // render whatever has already been measured
        if (this.safetyReport) {
            this.applySafetyReport(this.safetyReport);
        }
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

    private applySafetyReport(report: RouteSafetyReport) {
        const byEntity = new Map<Entity, { clearance: number; level: SafetyLevel }>();
        for (const w of report.waypoints) {
            byEntity.set(w.entity, { clearance: w.clearance, level: w.level });
        }

        for (const folder of this.folders) {
            const el = this.folderElements.get(folder.id);
            if (!el) continue;

            let dirty = false;
            for (const wp of folder.waypoints) {
                const result = byEntity.get(wp.markerEntity);
                if (!result) continue;
                dirty = true;

                wp.clearance = result.clearance;
                wp.level = result.level;

                const label = el.waypointClearance.get(wp.id);
                if (label) {
                    label.text = this.clearanceText(wp.clearance);
                    this.setLevelClass(label, wp.level);
                }

                const bar = el.waypointBars.get(wp.id);
                if (bar) {
                    this.updateClearanceBar(bar, wp.clearance, wp.level, report.hardClearance);
                }

                const row = el.waypointItems.get(wp.id);
                if (row) {
                    this.setLevelClass(row, wp.level);
                }
            }

            if (dirty) {
                this.updateSummary(folder, report);
            }
        }
    }

    private setLevelClass(element: Container | Label, level: SafetyLevel) {
        element.class.remove('danger');
        if (level === SafetyLevel.danger) {
            element.class.add('danger');
        }
    }

    private updateSummary(folder: SampleFolder, report: RouteSafetyReport) {
        const el = this.folderElements.get(folder.id);
        if (!el || !el.waypointSummary) return;

        const summary = el.waypointSummary;
        summary.class.remove('danger');

        if (!report.ready) {
            summary.text = '安全校验不可用（无可测量模型）';
            summary.class.add('danger');
            return;
        }

        const min = report.minClearance;
        const minText = min < 0 ? '—' : `${min.toFixed(2)} m`;

        if (report.dangerCount > 0) {
            summary.text = `最小安全间距 ${minText} · 危险航点 ${report.dangerCount} 处（要求 ≥ ${report.hardClearance.toFixed(1)} m）`;
            summary.class.add('danger');
        } else {
            summary.text = `最小安全间距 ${minText} · 合格（要求 ≥ ${report.hardClearance.toFixed(1)} m）`;
        }
    }

    // delete the waypoint sub-folder and clear the route from the scene
    private deleteWaypoints(folderId: string) {
        const folder = this.folders.find(f => f.id === folderId);
        if (!folder) return;

        // exit route editing if active
        if (folder.routeActive) {
            this.stopRouteEditing(folderId);
        }

        // clear route from the tool
        this.events.fire('route.clear');

        folder.waypoints = [];

        // remove UI section
        const el = this.folderElements.get(folderId);
        if (el && el.waypointSection) {
            el.content.remove(el.waypointSection);
            el.waypointSection = null;
        }
    }
}

export { SamplePointPanel };
