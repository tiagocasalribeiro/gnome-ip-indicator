import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import NM from 'gi://NM';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class IpIndicatorExtension extends Extension {
    enable() {
        // Create the main container box with native panel button styling
        this._box = new St.BoxLayout({
            style_class: 'panel-button',
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            can_focus: true,
            x_expand: false
        });

        // Labels with fixed minimum width to prevent UI flashing during updates
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
            style: 'min-width: 140px;'
        });

        this._box.add_child(this._publicIpLabel);
        this._box.add_child(this._separator);
        this._box.add_child(this._localIpLabel);

        // Insert into the left panel box, right after the "Activities" button (index 1)
        Main.panel._leftBox.insert_child_at_index(this._box, 1);

        // Track last known values to avoid unnecessary UI updates
        this._lastPublicIp = '';
        this._lastLocalIp = '';
        this._pendingMessage = null;

        // Initialize NetworkManager client to monitor connection state
        try {
            this._nmClient = NM.Client.new(null);
            this._nmStateId = this._nmClient.connect('notify::state', () => {
                this._onNetworkStateChanged();
            });
        } catch (e) {
            console.log(`[IP Indicator] Failed to initialize NM Client: ${e}`);
        }

        // Initial fetch
        this._updateLocalIp();
        this._updatePublicIp();

        // Fallback timer to update every 60 seconds
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._updateLocalIp();
            this._updatePublicIp();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        // Clean up timer
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        
        // Cancel any pending HTTP requests
        this._cancelPendingRequest();
        
        // Disconnect NetworkManager signals
        if (this._nmClient) {
            if (this._nmStateId) {
                this._nmClient.disconnect(this._nmStateId);
            }
            this._nmClient = null;
        }
        
        // Destroy UI elements
        if (this._box) {
            this._box.destroy();
            this._box = null;
        }
    }

    _cancelPendingRequest() {
        if (this._pendingMessage) {
            try {
                this._pendingMessage.cancel();
            } catch (e) {
                // Ignore cancellation errors
            }
            this._pendingMessage = null;
        }
    }

    _onNetworkStateChanged() {
        const state = this._nmClient.get_state();
        
        if (state === NM.State.CONNECTED_GLOBAL) {
            // Network connected: fetch fresh IPs
            this._updateLocalIp();
            this._updatePublicIp();
        } else {
            // Network disconnected: cancel pending requests and show 0.0.0.0
            this._cancelPendingRequest();
            this._setLocalIpText('Local: 0.0.0.0');
            this._setPublicIpText('Public: 0.0.0.0');
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

    _updateLocalIp() {
        if (this._nmClient && this._nmClient.get_state() !== NM.State.CONNECTED_GLOBAL) {
            this._setLocalIpText('Local: 0.0.0.0');
            return;
        }

        try {
            const [success, out] = GLib.spawn_command_line_sync('hostname -I');
            if (success && out) {
                let ip = out.toString().trim().split(' ')[0];
                if (!ip || ip === '') {
                    ip = '0.0.0.0';
                }
                this._setLocalIpText(`Local: ${ip}`);
            } else {
                this._setLocalIpText('Local: 0.0.0.0');
            }
        } catch (e) {
            this._setLocalIpText('Local: 0.0.0.0');
        }
    }

    _updatePublicIp() {
        if (this._nmClient && this._nmClient.get_state() !== NM.State.CONNECTED_GLOBAL) {
            this._setPublicIpText('Public: 0.0.0.0');
            return;
        }

        // Cancel any previous pending request before starting a new one
        this._cancelPendingRequest();
        this._setPublicIpText('Public: ...');

        const session = new Soup.Session();
        this._pendingMessage = Soup.Message.new('GET', 'https://api.ipify.org?format=json');
        const currentMessage = this._pendingMessage;
        
        session.send_and_read_async(currentMessage, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            // Double-check network state in case it changed while the request was in flight
            if (this._nmClient && this._nmClient.get_state() !== NM.State.CONNECTED_GLOBAL) {
                this._setPublicIpText('Public: 0.0.0.0');
                return;
            }

            try {
                const bytes = session.send_and_read_finish(result);
                const text = new TextDecoder().decode(bytes.get_data());
                const json = JSON.parse(text);
                this._setPublicIpText(`Public: ${json.ip}`);
            } catch (e) {
                this._setPublicIpText('Public: 0.0.0.0');
            } finally {
                // Clean up reference if this is still the active message
                if (this._pendingMessage === currentMessage) {
                    this._pendingMessage = null;
                }
            }
        });
    }
}
