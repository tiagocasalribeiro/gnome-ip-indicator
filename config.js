// Shared configuration module for IP Indicator extension
// Stores settings in ~/.config/ip-indicator/settings.json

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'ip-indicator']);
const CONFIG_FILE = GLib.build_filenamev([CONFIG_DIR, 'settings.json']);

export const Config = {
    _cache: null,
    _monitor: null,
    _changeCallbacks: new Set(),

    _getDefaultConfig() {
        return {
            hiddenInterfaces: [],
            rotationInterval: 5,
            publicIpTimeout: 5,
            publicIpConnectTimeout: 3
        };
    },

    _ensureDir() {
        const dir = Gio.File.new_for_path(CONFIG_DIR);
        if (!dir.query_exists(null)) {
            dir.make_directory_with_parents(null);
        }
    },

    load() {
        if (this._cache) return this._cache;
        
        try {
            this._ensureDir();
            const file = Gio.File.new_for_path(CONFIG_FILE);
            if (!file.query_exists(null)) {
                this._cache = this._getDefaultConfig();
                this.save();
                return this._cache;
            }
            
            const [success, contents] = file.load_contents(null);
            if (success) {
                const text = new TextDecoder().decode(contents);
                const parsed = JSON.parse(text);
                this._cache = { ...this._getDefaultConfig(), ...parsed };
            } else {
                this._cache = this._getDefaultConfig();
            }
        } catch (e) {
            console.log(`[IP Indicator] Failed to load config: ${e}`);
            this._cache = this._getDefaultConfig();
        }
        
        return this._cache;
    },

    save() {
        try {
            this._ensureDir();
            const file = Gio.File.new_for_path(CONFIG_FILE);
            const text = JSON.stringify(this._cache, null, 2);
            file.replace_contents(
                new TextEncoder().encode(text),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            return true;
        } catch (e) {
            console.log(`[IP Indicator] Failed to save config: ${e}`);
            return false;
        }
    },

    update(partial) {
        this.load();
        this._cache = { ...this._cache, ...partial };
        return this.save();
    },

    isHidden(interfaceName) {
        this.load();
        return this._cache.hiddenInterfaces.includes(interfaceName);
    },

    setHidden(interfaceName, hidden) {
        this.load();
        const list = new Set(this._cache.hiddenInterfaces);
        if (hidden) {
            list.add(interfaceName);
        } else {
            list.delete(interfaceName);
        }
        this._cache.hiddenInterfaces = Array.from(list).sort();
        return this.save();
    },

    getHiddenInterfaces() {
        this.load();
        return [...this._cache.hiddenInterfaces];
    },

    startMonitoring(callback) {
        if (this._monitor) return;
        
        try {
            this._ensureDir();
            const dir = Gio.File.new_for_path(CONFIG_DIR);
            this._monitor = dir.monitor(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', (monitor, file, otherFile, eventType) => {
                const fileName = file.get_basename();
                if (fileName === 'settings.json') {
                    this._cache = null;
                    this.load();
                    callback();
                }
            });
        } catch (e) {
            console.log(`[IP Indicator] Failed to start config monitor: ${e}`);
        }
    },

    stopMonitoring() {
        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
    }
};
