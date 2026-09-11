import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import NM from 'gi://NM';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class IpIndicatorExtension extends Extension {
    enable() {
        this._box = new St.BoxLayout({
            style_class: 'panel-button',
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
            can_focus: false,
            x_expand: false
        });

        this._publicIpLabel = new St.Label({ 
            text: "Public: ...", 
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            style: 'min-width: 160px;'
        });
        
        this._separator = new St.Label({ 
            text: " | ", 
            y_align: Clutter.ActorAlign.CENTER 
        });
        
        this._localIpLabel = new St.Label({ 
            text: "Local: ...", 
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            style: 'min-width: 260px;' // Aumentado para acomodar nomes como "enp0s31f6.4094"
        });

        this._box.add_child(this._publicIpLabel);
        this._box.add_child(this._separator);
        this._box.add_child(this._localIpLabel);

        Main.panel._leftBox.insert_child_at_index(this._box, 1);

        this._lastPublicIp = '';
        this._lastLocalIp = '';
        this._pendingMessage = null;
        
        this._isUpdating = false;
        this._updateQueue = [];
        this._refreshTimeoutId = null;
        this._retryPublicId = null;
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

    // Constrói a lista de todas as interfaces com IP válido
    // O nome da interface já inclui o sufixo VLAN (ex: eth0.10, enp0s31f6.50)
    _rebuildInterfacesList() {
        if (!this._nmClient || this._nmClient.get_state() !== NM.State.CONNECTED_GLOBAL) {
            this._interfacesList = [];
            return;
        }

        const newInterfaces = [];
        const devices = this._nmClient.get_devices() || [];
        
        for (const device of devices) {
            const ip4Config = device.get_ip4_config();
            if (!ip4Config) continue;
            
            const addresses = ip4Config.get_addresses();
            if (!addresses || addresses.length === 0) continue;
            
            const ip = addresses[0].get_address();
            if (!ip || ip === '0.0.0.0') continue;
            
            // get_iface() já devolve o nome completo: "eth0" ou "eth0.10" para VLANs
            const ifaceName = device.get_iface();
            if (!ifaceName) continue;
            
            // Detetar VLAN pelo tipo de dispositivo (mais fiável que pelo nome)
            const isVlan = device.get_device_type() === NM.DeviceType.VLAN;
            
            newInterfaces.push({
                name: ifaceName,
                ip: ip,
                isVlan: isVlan
            });
        }

        // Ordenar: VLANs primeiro, depois por nome
        newInterfaces.sort((a, b) => {
            if (a.isVlan && !b.isVlan) return -1;
            if (!a.isVlan && b.isVlan) return 1;
            return a.name.localeCompare(b.name);
        });

        // Só atualizar se a lista realmente mudou
        const oldKey = JSON.stringify(this._interfacesList);
        const newKey = JSON.stringify(newInterfaces);
        if (oldKey !== newKey) {
            this._interfacesList = newInterfaces;
            this._rotationIndex = 0;
            this._updateLocalIpDisplay();
        }
    }

    _startRotation() {
        if (this._rotationTimeoutId) {
            GLib.source_remove(this._rotationTimeoutId);
        }
        // Ciclar a cada 5 segundos
        this._rotationTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            if (this._interfacesList.length > 1) {
                this._rotationIndex = (this._rotationIndex + 1) % this._interfacesList.length;
                this._updateLocalIpDisplay();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateLocalIpDisplay() {
        if (this._interfacesList.length === 0) {
            this._setLocalIpText('Local: 0.0.0.0');
            return;
        }

        const current = this._interfacesList[this._rotationIndex % this._interfacesList.length];
        
        // Formato unificado: Local: [nome-interface] ip
        // Exemplos: "Local: [eth0] 192.168.1.10" ou "Local: [eth0.10] 192.168.50.10"
        this._setLocalIpText(`Local: [${current.name}] ${current.ip}`);
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }
        
        if (this._retryPublicId) {
            GLib.source_remove(this._retryPublicId);
            this._retryPublicId = null;
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
        
        this._cancelPendingRequest();
        
        for (const [device, signalId] of this._deviceIp4Ids) {
            try { device.disconnect(signalId); } catch (e) {}
        }
        this._deviceIp4Ids.clear();
        
        if (this._nmClient) {
            if (this._nmStateId) this._nmClient.disconnect(this._nmStateId);
            if (this._nmActiveId) this._nmClient.disconnect(this._nmActiveId);
            this._nmClient = null;
        }
        
        if (this._localIpLabel) { this._localIpLabel.destroy(); this._localIpLabel = null; }
        if (this._separator) { this._separator.destroy(); this._separator = null; }
        if (this._publicIpLabel) { this._publicIpLabel.destroy(); this._publicIpLabel = null; }
        if (this._box) { this._box.destroy(); this._box = null; }
    }

    _cancelPendingRequest() {
        if (this._pendingMessage) {
            try { this._pendingMessage.cancel(); } catch (e) {}
            this._pendingMessage = null;
        }
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
            this._cancelPendingRequest();
            this._cancelRetries();
            this._interfacesList = [];
            this._setLocalIpText('Local: 0.0.0.0');
            this._setPublicIpText('Public: 0.0.0.0');
            return;
        }

        this._rebuildInterfacesList();
        this._updateLocalIpDisplay();
        this._updatePublicIp();
    }

    _cancelRetries() {
        if (this._retryPublicId) {
            GLib.source_remove(this._retryPublicId);
            this._retryPublicId = null;
        }
    }

    _setLocalIpText(newText) {
        if (newText !== this._lastLocalIp) {
            this._localIpLabel.set_text(newText);
            this._lastLocalIp = newText;
        }
    }

    _setPublicIpText(newText) {
        if (newText !== this._lastPublicIp) {
            this._publicIpLabel.set_text(newText);
            this._lastPublicIp = newText;
        }
    }

    _updatePublicIp() {
        if (this._nmClient && this._nmClient.get_state() !== NM.State.CONNECTED_GLOBAL) {
            this._setPublicIpText('Public: 0.0.0.0');
            return;
        }

        this._cancelPendingRequest();
        
        if (this._lastPublicIp === '' || 
            this._lastPublicIp === 'Public: ...' || 
            this._lastPublicIp === 'Public: 0.0.0.0') {
            this._setPublicIpText('Public: ...');
        }

        const session = new Soup.Session();
        session.set_timeout(10);
        
        this._pendingMessage = Soup.Message.new('GET', 'https://api.ipify.org?format=json');
        const currentMessage = this._pendingMessage;
        
        session.send_and_read_async(currentMessage, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            if (this._nmClient && this._nmClient.get_state() !== NM.State.CONNECTED_GLOBAL) {
                this._setPublicIpText('Public: 0.0.0.0');
                return;
            }

            try {
                const bytes = session.send_and_read_finish(result);
                if (!bytes) throw new Error('No data received');
                const text = new TextDecoder().decode(bytes.get_data());
                const json = JSON.parse(text);
                if (json && json.ip) {
                    this._setPublicIpText(`Public: ${json.ip}`);
                } else {
                    throw new Error('Invalid response');
                }
            } catch (e) {
                if (this._nmClient && 
                    this._nmClient.get_state() === NM.State.CONNECTED_GLOBAL &&
                    !this._retryPublicId) {
                    this._retryPublicId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                        this._retryPublicId = null;
                        this._updatePublicIp();
                        return GLib.SOURCE_REMOVE;
                    });
                } else if (!this._retryPublicId) {
                    this._setPublicIpText('Public: 0.0.0.0');
                }
            } finally {
                if (this._pendingMessage === currentMessage) {
                    this._pendingMessage = null;
                }
            }
        });
    }
}
