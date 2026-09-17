import { Button, Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { i18n } from './localization';
import cameraFrameSelectionSvg from './svg/camera-frame-selection.svg';
import cameraResetSvg from './svg/camera-reset.svg';
import centersSvg from './svg/centers.svg';
import colorPanelSvg from './svg/color-panel.svg';
import deviceLedgerSvg from './svg/device-ledger.svg';
import flyCameraSvg from './svg/fly-camera.svg';
import orbitCameraSvg from './svg/orbit-camera.svg';
import ringsSvg from './svg/rings.svg';
import routeSvg from './svg/route.svg';
import sceneManagerSvg from './svg/scene-manager.svg';
import showHideSplatsSvg from './svg/show-hide-splats.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class RightToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'right-toolbar'
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const ringsModeToggle = new Button({
            id: 'right-toolbar-mode-toggle',
            class: 'right-toolbar-toggle'
        });

        const showHideSplats = new Button({
            id: 'right-toolbar-show-hide',
            class: ['right-toolbar-toggle', 'active']
        });

        const orbitMode = new Button({
            id: 'right-toolbar-orbit-mode',
            class: ['right-toolbar-toggle', 'active']
        });

        const flyMode = new Button({
            id: 'right-toolbar-fly-mode',
            class: 'right-toolbar-toggle'
        });

        const cameraFrameSelection = new Button({
            id: 'right-toolbar-frame-selection',
            class: 'right-toolbar-button'
        });

        const cameraReset = new Button({
            id: 'right-toolbar-camera-origin',
            class: 'right-toolbar-button'
        });

        const colorPanel = new Button({
            id: 'right-toolbar-color-panel',
            class: 'right-toolbar-toggle'
        });

        // group of mutually-exclusive panel toggles: device ledger,
        // sample points & route, scene manager
        const panelGroup = new Container({ class: 'right-toolbar-group' });
        const deviceLedger = new Button({
            id: 'right-toolbar-device-ledger',
            class: 'right-toolbar-toggle'
        });
        deviceLedger.dom.appendChild(createSvg(deviceLedgerSvg));

        const samplePoint = new Button({
            id: 'right-toolbar-sample-point',
            class: 'right-toolbar-toggle'
        });
        samplePoint.dom.appendChild(createSvg(routeSvg));

        const sceneManager = new Button({
            id: 'right-toolbar-scene-manager',
            class: ['right-toolbar-toggle', 'active']   // scene panel starts visible
        });
        sceneManager.dom.appendChild(createSvg(sceneManagerSvg));

        panelGroup.append(deviceLedger);
        panelGroup.append(samplePoint);
        panelGroup.append(sceneManager);

        const options = new Button({
            id: 'right-toolbar-options',
            class: 'right-toolbar-toggle',
            icon: 'E283'
        });

        const centersDom = createSvg(centersSvg);
        const ringsDom = createSvg(ringsSvg);
        ringsDom.style.display = 'none';

        ringsModeToggle.dom.appendChild(centersDom);
        ringsModeToggle.dom.appendChild(ringsDom);
        showHideSplats.dom.appendChild(createSvg(showHideSplatsSvg));
        orbitMode.dom.appendChild(createSvg(orbitCameraSvg));
        flyMode.dom.appendChild(createSvg(flyCameraSvg));
        cameraFrameSelection.dom.appendChild(createSvg(cameraFrameSelectionSvg));
        cameraReset.dom.appendChild(createSvg(cameraResetSvg));
        colorPanel.dom.appendChild(createSvg(colorPanelSvg));

        this.append(ringsModeToggle);
        this.append(showHideSplats);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(orbitMode);
        this.append(flyMode);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(cameraFrameSelection);
        this.append(cameraReset);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(panelGroup);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(colorPanel);
        this.append(options);

        // Helper to compose localized tooltip text with shortcut
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId?: string) => () => {
            const text = i18n.t(localeKey);
            if (shortcutId) {
                const shortcut = shortcutManager.formatShortcut(shortcutId);
                if (shortcut) {
                    return i18n.formatTooltipWithShortcut(text, shortcut);
                }
            }
            return text;
        };

        tooltips.register(ringsModeToggle, tooltip('tooltip.right-toolbar.splat-mode', 'camera.toggleMode'), 'left');
        tooltips.register(showHideSplats, tooltip('tooltip.right-toolbar.show-hide', 'camera.toggleOverlay'), 'left');
        tooltips.register(orbitMode, tooltip('tooltip.right-toolbar.orbit-camera', 'camera.toggleControlMode'), 'left');
        tooltips.register(flyMode, tooltip('tooltip.right-toolbar.fly-camera', 'camera.toggleControlMode'), 'left');
        tooltips.register(cameraFrameSelection, tooltip('tooltip.right-toolbar.frame-selection', 'camera.focus'), 'left');
        tooltips.register(cameraReset, tooltip('tooltip.right-toolbar.reset-camera', 'camera.reset'), 'left');
        tooltips.register(deviceLedger, tooltip('tooltip.right-toolbar.device-ledger'), 'left');
        tooltips.register(samplePoint, tooltip('tooltip.right-toolbar.sample-point'), 'left');
        tooltips.register(sceneManager, tooltip('tooltip.right-toolbar.scene-manager'), 'left');
        tooltips.register(colorPanel, tooltip('tooltip.right-toolbar.colors'), 'left');
        tooltips.register(options, tooltip('tooltip.right-toolbar.settings'), 'left');

        // add event handlers

        ringsModeToggle.on('click', () => {
            events.fire('camera.toggleMode');
            events.fire('camera.setOverlay', true);
        });
        showHideSplats.on('click', () => events.fire('camera.toggleOverlay'));
        orbitMode.on('click', () => events.fire('camera.setControlMode', 'orbit'));
        flyMode.on('click', () => events.fire('camera.setControlMode', 'fly'));
        cameraFrameSelection.on('click', () => events.fire('camera.focus'));
        cameraReset.on('click', () => events.fire('camera.reset'));
        deviceLedger.on('click', () => events.fire('devicePanel.toggleVisible'));
        samplePoint.on('click', () => events.fire('samplePointPanel.toggleVisible'));
        sceneManager.on('click', () => events.fire('scenePanel.toggleVisible'));
        colorPanel.on('click', () => events.fire('colorPanel.toggleVisible'));
        options.on('click', () => events.fire('settingsPanel.toggleVisible'));

        events.on('camera.mode', (mode: string) => {
            ringsModeToggle.class[mode === 'rings' ? 'add' : 'remove']('active');
            centersDom.style.display = mode === 'rings' ? 'none' : 'block';
            ringsDom.style.display = mode === 'rings' ? 'block' : 'none';
        });

        events.on('camera.overlay', (value: boolean) => {
            showHideSplats.class[value ? 'add' : 'remove']('active');
        });

        events.on('camera.controlMode', (mode: 'orbit' | 'fly') => {
            orbitMode.class[mode === 'orbit' ? 'add' : 'remove']('active');
            flyMode.class[mode === 'fly' ? 'add' : 'remove']('active');
        });

        events.on('devicePanel.visible', (visible: boolean) => {
            deviceLedger.class[visible ? 'add' : 'remove']('active');
        });

        events.on('samplePointPanel.visible', (visible: boolean) => {
            samplePoint.class[visible ? 'add' : 'remove']('active');
        });

        events.on('scenePanel.visible', (visible: boolean) => {
            sceneManager.class[visible ? 'add' : 'remove']('active');
        });

        events.on('colorPanel.visible', (visible: boolean) => {
            colorPanel.class[visible ? 'add' : 'remove']('active');
        });

        events.on('settingsPanel.visible', (visible: boolean) => {
            options.class[visible ? 'add' : 'remove']('active');
        });
    }
}

export { RightToolbar };
