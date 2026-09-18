import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import NM from 'gi://NM';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { Config } from './config.js';

export default class IpIndicatorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(600, 500);
        
        this._nmClient = null;
        this._nmSignalIds = [];
        this._interfaceRows = [];
        this._loadingRow = null;
        
        const page = new Adw.PreferencesPage({
            title: 'IP Indicator',
            icon_name: 'network-workgroup-symbolic'
        });
        window.add(page);

        this._interfacesGroup = new Adw.PreferencesGroup({
            title: 'Network Interfaces',
            description: 'Toggle visibility of each interface in the panel indicator'
        });
        page.add(this._interfacesGroup);

        this._loadingRow = new Adw.ActionRow({
            title: 'Loading interfaces...',
            subtitle: 'Please wait'
        });
        const spinner = new Gtk.Spinner({ spinning: true });
        this._loadingRow.add_suffix(spinner);
        this._interfacesGroup.add(this._loadingRow);

        this._initNmClient();

        const advancedGroup = new Adw.PreferencesGroup({
            title: 'Advanced Settings',
            description: 'Fine-tune the extension behavior'
        });
        page.add(advancedGroup);

        const config = Config.load();

        const rotationRow = new Adw.SpinRow({
            title: 'Rotation interval',
            subtitle: 'Seconds between interface carousel rotations',
            adjustment: new Gtk.Adjustment({
                lower: 2,
                upper: 60,
                step_increment: 1,
                value: config.rotationInterval || 5
            })
        });
        rotationRow.connect('notify::value', () => {
            Config.update({ rotationInterval: rotationRow.value });
        });
        advancedGroup.add(rotationRow);

        const timeoutRow = new Adw.SpinRow({
            title: 'Public IP timeout',
            subtitle: 'Maximum seconds to wait for public IP response',
            adjustment: new Gtk.Adjustment({
                lower: 2,
                upper: 30,
                step_increment: 1,
                value: config.publicIpTimeout || 5
            })
        });
        timeoutRow.connect('notify::value', () => {
            Config.update({ publicIpTimeout: timeoutRow.value });
        });
        advancedGroup.add(timeoutRow);

        const connectTimeoutRow = new Adw.SpinRow({
            title: 'Connect timeout',
            subtitle: 'Maximum seconds to establish connection per interface',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 15,
                step_increment: 1,
                value: config.publicIpConnectTimeout || 3
            })
        });
        connectTimeoutRow.connect('notify::value', () => {
            Config.update({ publicIpConnectTimeout: connectTimeoutRow.value });
        });
        advancedGroup.add(connectTimeoutRow);

        const resetGroup = new Adw.PreferencesGroup();
        page.add(resetGroup);
        
        const resetRow = new Adw.ActionRow({
            title: 'Reset all settings',
            subtitle: 'Show all interfaces and restore default timeouts'
        });
        const resetButton = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action']
        });
        resetButton.connect('clicked', () => {
            const freshConfig = {
                hiddenInterfaces: [],
                rotationInterval: 5,
                publicIpTimeout: 5,
                publicIpConnectTimeout: 3
            };
            Config.update(freshConfig);
            rotationRow.value = 5;
            timeoutRow.value = 5;
            connectTimeoutRow.value = 3;
            this._populateInterfaces();
        });
        resetRow.add_suffix(resetButton);
        resetGroup.add(resetRow);

        window.connect('close-request', () => {
            this._cleanup();
            return false;
        });
    }

    _initNmClient() {
        NM.Client.new_async(null, (client, result) => {
            try {
                this._nmClient = NM.Client.new_finish(result);
                
                this._populateInterfaces();
                
                const deviceAddedId = this._nmClient.connect('device-added', () => {
                    this._populateInterfaces();
                });
                this._nmSignalIds.push(deviceAddedId);
                
                const deviceRemovedId = this._nmClient.connect('device-removed', () => {
                    this._populateInterfaces();
                });
                this._nmSignalIds.push(deviceRemovedId);
                
                const activeConnsId = this._nmClient.connect('notify::active-connections', () => {
                    this._populateInterfaces();
                });
                this._nmSignalIds.push(activeConnsId);
                
            } catch (e) {
                console.log(`[IP Indicator Prefs] NM Client init failed: ${e}`);
                this._showError('Failed to connect to NetworkManager');
            }
        });
    }

    _populateInterfaces() {
        if (!this._nmClient) return;

        const previousStates = new Map();
        for (const { iface, toggle } of this._interfaceRows) {
            previousStates.set(iface.name, toggle.get_active());
        }

        for (const { row } of this._interfaceRows) {
            this._interfacesGroup.remove(row);
        }
        this._interfaceRows = [];

        if (this._loadingRow) {
            this._interfacesGroup.remove(this._loadingRow);
            this._loadingRow = null;
        }

        const devices = this._nmClient.get_devices() || [];
        const hiddenInterfaces = Config.getHiddenInterfaces();
        
        const allInterfaces = [];
        for (const device of devices) {
            const ifaceName = device.get_iface();
            if (!ifaceName) continue;
            
            const isVlan = device.get_device_type() === NM.DeviceType.VLAN;
            const ip4Config = device.get_ip4_config();
            let ip = null;
            if (ip4Config) {
                const addresses = ip4Config.get_addresses();
                if (addresses && addresses.length > 0) {
                    ip = addresses[0].get_address();
                }
            }
            
            allInterfaces.push({
                name: ifaceName,
                isVlan: isVlan,
                ip: ip
            });
        }

        for (const hidden of hiddenInterfaces) {
            if (!allInterfaces.find(i => i.name === hidden)) {
                allInterfaces.push({
                    name: hidden,
                    isVlan: false,
                    ip: null,
                    isStale: true
                });
            }
        }

        allInterfaces.sort((a, b) => {
            if (a.isVlan && !b.isVlan) return -1;
            if (!a.isVlan && b.isVlan) return 1;
            return a.name.localeCompare(b.name);
        });

        if (allInterfaces.length === 0) {
            this._showError('No network interfaces detected');
            return;
        }

        for (const iface of allInterfaces) {
            const isHidden = hiddenInterfaces.includes(iface.name);
            
            let subtitle;
            if (iface.isStale) {
                subtitle = 'Not currently detected (previously hidden)';
            } else if (iface.ip) {
                subtitle = `${iface.isVlan ? 'VLAN' : 'Interface'} • IP: ${iface.ip}`;
            } else {
                subtitle = `${iface.isVlan ? 'VLAN' : 'Interface'} • No IP assigned`;
            }
            
            const row = new Adw.ActionRow({
                title: iface.name,
                subtitle: subtitle
            });
            
            const wasVisible = previousStates.has(iface.name) 
                ? previousStates.get(iface.name) 
                : !isHidden;
            
            const toggle = new Gtk.Switch({
                active: wasVisible,
                valign: Gtk.Align.CENTER
            });
            
            toggle.connect('state-set', (widget, state) => {
                Config.setHidden(iface.name, !state);
            });
            
            row.add_suffix(toggle);
            row.set_activatable_widget(toggle);
            this._interfacesGroup.add(row);
            
            this._interfaceRows.push({ row, toggle, iface });
        }
    }

    _showError(message) {
        if (this._loadingRow) {
            this._interfacesGroup.remove(this._loadingRow);
            this._loadingRow = null;
        }
        for (const { row } of this._interfaceRows) {
            this._interfacesGroup.remove(row);
        }
        this._interfaceRows = [];
        
        const errorRow = new Adw.ActionRow({
            title: message,
            subtitle: 'Try reconnecting your network'
        });
        this._interfacesGroup.add(errorRow);
    }

    _cleanup() {
        if (this._nmClient) {
            for (const signalId of this._nmSignalIds) {
                try { this._nmClient.disconnect(signalId); } catch (e) {}
            }
            this._nmSignalIds = [];
            this._nmClient = null;
        }
        this._interfaceRows = [];
    }
}
