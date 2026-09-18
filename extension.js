import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import NM from 'gi://NM';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Config } from './config.js';

export default class IpIndicatorExtension extends Extension {
    enable() {
        this._box = new St.BoxLayout({
            style_class: 'panel-button',
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            can_focus: true,
            x_expand: false
        });

        // Abrir preferências ao clicar no indicador
        this._box.connect('button-press-event', () => {
            this.openPreferences();
            return Clutter.EVENT_STOP;
        });

        this._displayLabel = new St.Label({ 
            text: "Loading...", 
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            style: 'min-width: 400px;'
        });

        this._box.add_child(this._displayLabel);
        Main.panel._leftBox.insert_child_at_index(this._box, 1);

        this._lastDisplayText = '';
        this._pendingProcesses = new Map();
        
        this._isUpdating = false;
        this._updateQueue = [];
        this._refreshTimeoutId = null;
        this._startupRetryIds = [];
        this._deviceIp4Ids = new Map();
        this._idleSourceId = null;
        this._rotationTimeoutId = null;
        this._rotationIndex = 0;
        this._interfacesList = [];
        
        this._nmClient = null;
        this._nmStateId = null;
        this._nmActiveId = null;
        this._timeoutId = null;

        // Carregar configuração e iniciar monitorização para actualizações em tempo real
        Config.load();
        Config.startMonitoring(() => {
            this._rotationIndex = 0;
            this._rebuildInterfacesList();
        });

        NM.Client.new_async(null, (client, result) => {
            try {
                this._nmClient = NM.Client.new_finish(result);
                this._setupSignals();
                this._scheduleRefresh();
                this._startStartupPolling();
                this._startRotation();
            } catch (e) {
                console.log(`[IP Indicator] NM Client async init failed: ${e}`);
            }
        });
    }

    _startStartupPolling() {
        const delays = [0.5, 1, 2, 4, 8, 16];
        delays.forEach(delay => {
            const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                this._scheduleRefresh();
                return GLib.SOURCE_REMOVE;
            });
            this._startupRetryIds.push(id);
        });
    }

    _setupSignals() {
        if (!this._nmClient) return;
        
        this._nmStateId = this._nmClient.connect('notify::state', () => {
            this._scheduleRefresh();
        });
        
        this._nmActiveId = this._nmClient.connect('notify::active-connections', () => {
            this._monitorDevicesIp4();
            this._scheduleRefresh();
            this._rebuildInterfacesList();
        });
        
        this._monitorDevicesIp4();
        
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._scheduleRefresh();
            this._rebuildInterfacesList();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _monitorDevicesIp4() {
        if (!this._nmClient) return;
        
        for (const [device, signalId] of this._deviceIp4Ids) {
            try { device.disconnect(signalId); } catch (e) {}
        }
        this._deviceIp4Ids.clear();
        
        const devices = this._nmClient.get_devices() || [];
        for (const device of devices) {
            const signalId = device.connect('notify::ip4-config', () => {
                this._scheduleRefresh();
                this._rebuildInterfacesList();
            });
            this._deviceIp4Ids.set(device, signalId);
        }
    }

    _rebuildInterfacesList() {
        if (!this._nmClient || this._nmClient.get_state() !== NM.State.CONNECTED_GLOBAL) {
            this._interfacesList = [];
            this._cancelAllPendingProcesses();
            this._updateDisplay();
            return;
        }

        const hiddenInterfaces = Config.getHiddenInterfaces();
        const newInterfaces = [];
        const devices = this._nmClient.get_devices() || [];
        
        for (const device of devices) {
            const ifaceName = device.get_iface();
            if (!ifaceName) continue;
            
            if (hiddenInterfaces.includes(ifaceName)) continue;
            
            const ip4Config = device.get_ip4_config();
            if (!ip4Config) continue;
            
            const addresses = ip4Config.get_addresses();
            if (!addresses || addresses.length === 0) continue;
            
            const ip = addresses[0].get_address();
            if (!ip || ip === '0.0.0.0') continue;
            
            const isVlan = device.get_device_type() === NM.DeviceType.VLAN;
            
            const existingEntry = this._interfacesList.find(e => e.name === ifaceName);
            const publicIp = existingEntry ? existingEntry.publicIp : null;
            
            newInterfaces.push({
                name: ifaceName,
                ip: ip,
                isVlan: isVlan,
                publicIp: publicIp
            });
        }

        newInterfaces.sort((a, b) => {
            if (a.isVlan && !b.isVlan) return -1;
            if (!a.isVlan && b.isVlan) return 1;
            return a.name.localeCompare(b.name);
        });

        const oldKey = JSON.stringify(this._interfacesList.map(e => ({name: e.name, ip: e.ip, isVlan: e.isVlan})));
        const newKey = JSON.stringify(newInterfaces.map(e => ({name: e.name, ip: e.ip, isVlan: e.isVlan})));
        
        if (oldKey !== newKey) {
            this._interfacesList = newInterfaces;
            this._rotationIndex = 0;
            
            this._updateDisplay();
            this._fetchAllPublicIps();
        }
    }

    _fetchAllPublicIps() {
        const currentNames = new Set(this._interfacesList.map(e => e.name));
        for (const [name, proc] of this._pendingProcesses) {
            if (!currentNames.has(name)) {
                try { proc.force_exit(); } catch (e) {}
                this._pendingProcesses.delete(name);
            }
        }

        const config = Config.load();
        const connectTimeout = config.publicIpConnectTimeout || 3;
        const maxTime = config.publicIpTimeout || 5;

        for (const entry of this._interfacesList) {
            if (entry.publicIp === null || entry.publicIp === '...') {
                this._fetchPublicIpForInterface(entry, connectTimeout, maxTime);
            }
        }
    }

    _fetchPublicIpForInterface(entry, connectTimeout, maxTime) {
        if (this._pendingProcesses.has(entry.name)) {
            try { this._pendingProcesses.get(entry.name).force_exit(); } catch (e) {}
            this._pendingProcesses.delete(entry.name);
        }

        entry.publicIp = '...';
        this._updateDisplay();

        const proc = new Gio.Subprocess({
            argv: [
                'curl',
                '--silent',
                '--max-time', String(maxTime),
                '--connect-timeout', String(connectTimeout),
                '--interface', entry.name,
                'https://api.ipify.org?format=json'
            ],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        });

        try {
            proc.init(null);
            this._pendingProcesses.set(entry.name, proc);
            
            proc.communicate_utf8_async(null, null, (proc, res) => {
                this._pendingProcesses.delete(entry.name);
                
                const currentEntry = this._interfacesList.find(e => e.name === entry.name);
                if (!currentEntry) return;

                try {
                    const [success, stdout] = proc.communicate_utf8_finish(res);
                    const exitStatus = proc.get_exit_status();
                    
                    if (success && exitStatus === 0 && stdout) {
                        const json = JSON.parse(stdout.trim());
                        if (json && json.ip) {
                            currentEntry.publicIp = json.ip;
                        } else {
                            throw new Error('Invalid response');
                        }
                    } else {
                        currentEntry.publicIp = '—';
                    }
                } catch (e) {
                    currentEntry.publicIp = '—';
                }
                
                this._updateDisplay();
            });
        } catch (e) {
            console.log(`[IP Indicator] Failed to spawn curl for ${entry.name}: ${e}`);
            entry.publicIp = '—';
            this._updateDisplay();
        }
    }

    _cancelAllPendingProcesses() {
        for (const [name, proc] of this._pendingProcesses) {
            try { proc.force_exit(); } catch (e) {}
        }
        this._pendingProcesses.clear();
    }

    _startRotation() {
        if (this._rotationTimeoutId) {
            GLib.source_remove(this._rotationTimeoutId);
        }
        const interval = Config.load().rotationInterval || 5;
        this._rotationTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            if (this._interfacesList.length > 1) {
                this._rotationIndex = (this._rotationIndex + 1) % this._interfacesList.length;
                this._updateDisplay();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateDisplay() {
        if (this._interfacesList.length === 0) {
            this._setDisplayText('No active interfaces');
            return;
        }

        const current = this._interfacesList[this._rotationIndex % this._interfacesList.length];
        const publicIp = current.publicIp || '...';
        
        const displayText = `[${current.name}] ${current.ip} → ${publicIp}`;
        
        this._setDisplayText(displayText);
    }

    _setDisplayText(newText) {
        if (newText !== this._lastDisplayText) {
            this._displayLabel.set_text(newText);
            this._lastDisplayText = newText;
        }
    }

    disable() {
        Config.stopMonitoring();
        
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }
        
        if (this._idleSourceId) {
            GLib.source_remove(this._idleSourceId);
            this._idleSourceId = null;
        }
        
        if (this._rotationTimeoutId) {
            GLib.source_remove(this._rotationTimeoutId);
            this._rotationTimeoutId = null;
        }
        
        for (const id of this._startupRetryIds) {
            GLib.source_remove(id);
        }
        this._startupRetryIds = [];
        
        this._cancelAllPendingProcesses();
        
        for (const [device, signalId] of this._deviceIp4Ids) {
            try { device.disconnect(signalId); } catch (e) {}
        }
        this._deviceIp4Ids.clear();
        
        if (this._nmClient) {
            if (this._nmStateId) this._nmClient.disconnect(this._nmStateId);
            if (this._nmActiveId) this._nmClient.disconnect(this._nmActiveId);
            this._nmClient = null;
        }
        
        if (this._displayLabel) { this._displayLabel.destroy(); this._displayLabel = null; }
        if (this._box) { this._box.destroy(); this._box = null; }
    }

    _scheduleRefresh() {
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
        }
        this._refreshTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._refreshTimeoutId = null;
            this._executeRefresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _executeRefresh() {
        if (this._isUpdating) {
            this._updateQueue.push(() => this._executeRefresh());
            return;
        }

        this._isUpdating = true;

        try {
            this._refreshAll();
        } catch (e) {
            console.log(`[IP Indicator] Error during refresh: ${e}`);
        } finally {
            this._isUpdating = false;
            
            if (this._updateQueue.length > 0) {
                const nextUpdate = this._updateQueue.shift();
                this._idleSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._idleSourceId = null;
                    nextUpdate();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    _refreshAll() {
        const state = this._nmClient ? this._nmClient.get_state() : NM.State.UNKNOWN;
        
        if (state !== NM.State.CONNECTED_GLOBAL) {
            this._cancelAllPendingProcesses();
            this._interfacesList = [];
            this._setDisplayText('Network disconnected');
            return;
        }

        this._rebuildInterfacesList();
    }
}
