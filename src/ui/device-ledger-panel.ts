import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

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

        header.append(icon);
        header.append(label);

        // body: placeholder for the future device ledger content
        const body = new Container({
            id: 'device-ledger-body'
        });

        this.append(header);
        this.append(body);

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
}

export { DeviceLedgerPanel };
