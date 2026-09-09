# IP Indicator

A GNOME Shell extension that displays your local and public IP addresses directly on the top panel, positioned neatly to the left of the screen.

## Features

- **Real-time Network Monitoring**: Instantly detects when you connect or disconnect from a network using NetworkManager.
- **Smart Fallback**: Displays `0.0.0.0` for both local and public IPs when the network is disconnected.
- **No UI Flashing**: Uses fixed minimum widths for labels to prevent the panel from resizing or flickering during IP updates.
- **Efficient Updates**: Only updates the UI when the IP address actually changes, and cancels pending HTTP requests if the network drops mid-fetch.
- **Lightweight**: Minimal resource usage with a 60-second fallback polling timer.

## Installation

### Via extensions.gnome.org (Recommended)
Once published, you can install it directly from the [GNOME Extensions website](https://extensions.gnome.org/).

### Manual Installation
1. Download the latest release or clone this repository.
2. Copy the extension folder to your local GNOME extensions directory:
   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/
   cp -r ip-indicator@tiagocasalribeiro.github.io ~/.local/share/gnome-shell/extensions/
