# IP Indicator

A GNOME Shell extension that displays your local and public IP addresses directly on the top panel, positioned neatly to the left of the screen.

## Features

- **Real-time Network Monitoring**: Instantly detects when you connect or disconnect from a network using NetworkManager.
- **Per-Interface Public IP**: Uses `curl --interface` to bind each HTTP request to the specific interface, showing the real public IP associated with each local IP (critical for VLANs, VPNs, and multi-homed systems).
- **Interface Carousel**: Automatically rotates through all active interfaces, showing each interface's local and public IP pair.
- **Interface Visibility Control**: Hide/show individual interfaces via the preferences window (e.g., hide `docker0`, `virbr0`, or any other interface you don't want to see).
- **Persistent Settings**: All preferences are stored in `~/.config/ip-indicator/settings.json` and survive reboots and extension updates.
- **Live Updates**: Changes in the preferences are applied immediately to the panel indicator via file monitoring.
- **No UI Flashing**: Uses fixed minimum widths and smart update logic to prevent the panel from resizing or flickering.
- **VLAN Integration**: Works seamlessly with the [GNOME VLAN Toggle](https://github.com/tiagocasalribeiro/GNOME_VLAN_Toggle) extension — activating a VLAN instantly shows its IP in the indicator.
- **Click-to-Configure**: Click the indicator in the panel to open the preferences window directly.

## Installation

### Via extensions.gnome.org
Once published, install it directly from the [GNOME Extensions website](https://extensions.gnome.org/).

### Manual Installation
1. Download the latest release or clone this repository.
2. Copy the extension folder to your local GNOME extensions directory:
   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/
   cp -r ip-indicator@tiagocasalribeiro.github.io ~/.local/share/gnome-shell/extensions/
   ```
3. Restart GNOME Shell (Log out and log back in, as you are likely using Wayland).
4. Enable the extension using the Extension Manager app or via terminal:
   ```bash
   gnome-extensions enable ip-indicator@tiagocasalribeiro.github.io
   ```

## Usage

### Panel Indicator
The indicator appears on the left side of the top panel, showing entries like:
```
[eth0.10] 192.168.10.5 → 203.0.113.50
```

If multiple interfaces are active, the display rotates automatically every few seconds (configurable).

- **`...`** = fetching public IP
- **`—`** = interface has no route to the internet (isolated VLAN, no gateway, etc.)
- **IP address** = real public IP for that specific interface

### Preferences
Click the indicator in the panel, or open preferences via:
```bash
gnome-extensions prefs ip-indicator@tiagocasalribeiro.github.io
```

The preferences window lets you:
- **Toggle interface visibility**: Show/hide any network interface in the panel
- **Adjust rotation interval**: How often the carousel cycles between interfaces (2-60 seconds)
- **Adjust timeouts**: Fine-tune the public IP fetch and connect timeouts
- **Reset all settings**: Restore defaults in one click

The interface list updates in real-time — activating a VLAN or plugging in a network cable instantly adds the new interface to the list.

## Configuration File

Settings are stored in `~/.config/ip-indicator/settings.json`:
```json
{
  "hiddenInterfaces": ["docker0", "virbr0"],
  "rotationInterval": 5,
  "publicIpTimeout": 5,
  "publicIpConnectTimeout": 3
}
```

You can edit this file directly — the extension monitors it and applies changes immediately.

## Requirements

- GNOME Shell 45, 46, 47, or 48
- NetworkManager
- `curl` (for per-interface public IP detection)

## Development

To test changes locally:
```bash
# Disable and re-enable to reload
gnome-extensions disable ip-indicator@tiagocasalribeiro.github.io
gnome-extensions enable ip-indicator@tiagocasalribeiro.github.io

# Check logs
journalctl -b 0 --user | grep "IP Indicator"
```

## License

This project is licensed under the GNU General Public License v2.0 or later. See the [LICENSE](LICENSE) file for details.
