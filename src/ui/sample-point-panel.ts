import { Container, Element, Label } from '@playcanvas/pcui';

import { Entity, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { i18n } from './localization';
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

let folderCounter = 0;
let pointCounter = 0;

interface SamplePointData {
    id: string;
    name: string;
    position: Vec3;
    normal: Vec3;
    wgs84: { lat: number; lon: number; alt: number } | null;
    markerEntity: Entity;
}

interface WaypointData {
    id: string;
    name: string;
    position: Vec3;
    markerEntity: Entity;
}

interface SampleFolder {
    id: string;
    name: string;
    expanded: boolean;
    addingPoints: boolean;
    routeActive: boolean;
    points: SamplePointData[];
    waypoints: WaypointData[];
}

class SamplePointPanel extends Container {
    private events: Events;
    private tooltips: Tooltips;

    private folders: SampleFolder[] = [];
    private activeFolderId: string | null = null;

    private folderListContainer: Container;
    private folderElements: Map<string, { header: Container; content: Container; items: Map<string, Container>; waypointSection: Container | null; waypointItems: Map<string, Container> }> = new Map();

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
        events.on('samplePoint.created', (data: { position: Vec3; normal: Vec3; wgs84: { lat: number; lon: number; alt: number } | null; markerEntity: Entity }) => {
            if (this.activeFolderId) {
                this.addPointToFolder(this.activeFolderId, data);
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

        folderEl.append(header);
        folderEl.append(content);

        this.folderListContainer.append(folderEl);

        this.folderElements.set(folder.id, { header, content, items: new Map(), waypointSection: null, waypointItems: new Map() });

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
    private startAddingPoints(folderId: string) {
        // stop any previous active folder
        if (this.activeFolderId) {
            this.setFolderAddingState(this.activeFolderId, false);
        }

        this.activeFolderId = folderId;
        this.setFolderAddingState(folderId, true);

        // hide bottom toolbar
        this.events.fire('bottomToolbar.hide');

        // activate the sample point tool
        this.events.fire('tool.samplePoint');
    }

    private stopAddingPoints() {
        if (!this.activeFolderId) return;

        this.setFolderAddingState(this.activeFolderId, false);
        this.activeFolderId = null;

        // show bottom toolbar
        this.events.fire('bottomToolbar.show');

        // deactivate the tool by activating a neutral tool (move)
        this.events.fire('tool.move');
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

        const pointNumber = folder.points.length + 1;
        const pointId = `point-${++pointCounter}`;
        const point: SamplePointData = {
            id: pointId,
            name: `Point ${pointNumber}`,
            position: data.position,
            normal: data.normal,
            wgs84: data.wgs84,
            markerEntity: data.markerEntity
        };

        folder.points.push(point);
        this.renderPoint(folder, point);
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

        // delete button
        const deleteBtn = new Container({ class: 'sample-point-delete' });
        deleteBtn.dom.appendChild(createSvg(deleteSvg));

        item.append(icon);
        item.append(name);
        item.append(info);
        item.append(deleteBtn);

        folderEl.content.append(item);
        folderEl.items.set(point.id, item);

        // expand folder if collapsed
        if (!folder.expanded) {
            folder.expanded = true;
            const folderDom = this.folderListContainer.dom.querySelector(`[data-folder-id="${folder.id}"]`);
            if (folderDom) {
                folderDom.classList.add('expanded');
            }
        }

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
    }

    private deletePoint(folderId: string, pointId: string) {
        const folder = this.folders.find(f => f.id === folderId);
        if (!folder) return;

        const idx = folder.points.findIndex(p => p.id === pointId);
        if (idx === -1) return;

        const point = folder.points[idx];

        // destroy marker entity
        if (point.markerEntity) {
            point.markerEntity.destroy();
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
        this.events.fire('tool.samplePoint');

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

        folder.waypoints = [];
        let wpCounter = 0;
        for (const wp of waypoints) {
            const id = `wp-${++pointCounter}`;
            const data: WaypointData = {
                id,
                name: `WP ${++wpCounter}`,
                position: wp.position,
                markerEntity: wp.markerEntity
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

        const section = new Container({ class: 'sample-waypoint-section' });

        // sub-folder header
        const wpHeader = new Container({ class: 'sample-waypoint-header' });
        const wpIcon = new Container({ class: 'sample-waypoint-icon' });
        wpIcon.dom.appendChild(createSvg(routeSvg));
        const wpName = new Label({
            class: 'sample-waypoint-name',
            text: '航点'
        });
        const wpDeleteBtn = new Container({ class: 'sample-waypoint-delete' });
        wpDeleteBtn.dom.appendChild(createSvg(deleteSvg));

        wpHeader.append(wpIcon);
        wpHeader.append(wpName);
        wpHeader.append(wpDeleteBtn);
        section.append(wpHeader);

        // waypoint rows
        const wpList = new Container({ class: 'sample-waypoint-list' });
        for (const wp of folder.waypoints) {
            const row = new Container({ class: 'sample-waypoint-row' });
            const name = new Label({
                class: 'sample-point-name',
                text: wp.name
            });
            row.append(name);
            wpList.append(row);

            // hover to highlight the waypoint
            row.dom.addEventListener('pointerenter', () => {
                this.events.fire('samplePoint.highlight', wp.markerEntity);
            });
            row.dom.addEventListener('pointerleave', () => {
                this.events.fire('samplePoint.unhighlight', wp.markerEntity);
            });
        }
        section.append(wpList);

        el.content.append(section);
        el.waypointSection = section;

        // delete handler
        wpDeleteBtn.on('click', () => {
            this.deleteWaypoints(folder.id);
        });

        this.tooltips.register(wpDeleteBtn, () => i18n.t('tooltip.samplePoint.deleteFolder'), 'left');
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
