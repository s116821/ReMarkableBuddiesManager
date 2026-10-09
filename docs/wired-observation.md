# Read-only wired tablet observation

This bounded Linux preview reads model, firmware, architecture, boot identity and
`reader-buddy.service` state through SSH over USB networking. It does not establish
Buddy package version, provenance or compatibility. Installation stays unavailable.
A missing unit does not prove no Buddy files exist. Unknown values stay unknown.

## Host setup

Use Linux with Python 3.10+, `ip` (iproute2), sysfs and IPv4 netlink support, and a
user-owned Python environment with the pinned maintained SSH library. The
interpreter and dependencies are external prerequisites, not bundled in the
portable Electron archive. From a source checkout:

```sh
python3 -m venv "$HOME/.local/share/manager-wired-python"
"$HOME/.local/share/manager-wired-python/bin/python" -m pip install -r host/requirements.txt
```

If venv creation is unavailable, install your distribution's venv support first.
For a portable package, `resources/host/requirements.txt` contains the same pin.
Do not grant the application broad network capabilities or run it as root to
bypass a refusal. A kernel that refuses interface-bound sockets is unsupported.

Connect the tablet by USB and enable its documented SSH access. Before using
Manager, independently establish the tablet's SSH host-key fingerprint and an
existing authorized unencrypted private key. Verify the fingerprint through a
trusted prior enrollment or independent trusted device channel. A freshly scanned
key is not independent proof. Manager never learns a key automatically or copies
passwords from the renderer; SSH agent/config/password fallbacks are disabled.
Encrypted keys require a future separately supported protected authentication path.

Identify the USB network interface and its actual physical parent, not merely an
IP address or interface name. Inspect `ip -j address`, `ip -j route get 10.11.99.1`
and `readlink -f /sys/class/net/<interface>/device`; the nearest parent containing
`idVendor` and `idProduct` is the selected USB device. Check its descriptor values.
The ordinary and source/interface-constrained routes must select that interface
and source address without a gateway. Manager independently repeats these checks
and applies/readbacks `SO_BINDTODEVICE` before source binding and connecting.
Only the fixed tablet peer `10.11.99.1:22` and SSH user `root` are supported.

Create a user-owned directory with mode 0700 and an absolute regular config file
with mode 0600. The selected private key must be a user-owned regular file with
mode 0600 in a 0700 directory; symlink paths are refused. Replace all placeholders:

```json
{
  "contract_version": 1,
  "interface": "<USB network interface>",
  "usb_path": "/sys/devices/<actual physical USB parent>",
  "usb_vendor": "<four lower-case hex digits>",
  "usb_product": "<four lower-case hex digits>",
  "source_address": "<host USB IPv4 address>",
  "host_key_sha256": "SHA256:<independently verified 43-character base64 fingerprint>",
  "identity_file": "/absolute/path/to/your/authorized/private-key"
}
```

The schema contract number is not an application version. Keep this configuration
outside the repository. No authentication material belongs in logs or screenshots.

Export host-owned locations before launching either host:

```sh
export MANAGER_WIRED_CONFIG="$HOME/.config/manager-wired/config.json"
export MANAGER_WIRED_PYTHON="$HOME/.local/share/manager-wired-python/bin/python"
```

## Open either UI

For Electron, run `npm run desktop`, or launch the portable desktop executable
from the configured host environment. The sandboxed renderer only requests
observation or cancellation; it cannot submit a target, file, key or command.

For a browser, explicitly start the companion helper from a source checkout:

```sh
npm run build
npm run wired:browser
```

Open the exact `http://127.0.0.1:<port>/preview/` URL printed by that process.
The helper serves the same production Angular build. It uses one loopback origin,
exact Host/Origin checks and a per-launch HttpOnly SameSite=Strict session cookie.
A deployed web page or ordinary `npm start` UI has no wired transport. It does not
probe other localhost ports. Stop the helper with Ctrl+C when finished.

Choose **Read tablet state**. Successful observations refresh after four seconds,
with each operation limited to 12 seconds and bounded fixed reads. **Disconnect**
cancels the owned operation and clears current state. Authentication/trust errors,
cable/route/interface changes, deadlines or a changed tablet boot stop polling.
Reconnect explicitly after checking the cable, setup and trust; the UI never
silently switches targets. Changing USB ports may require updating the protected
physical-parent configuration. A reused IP address does not establish identity.

## Verification and limits

```sh
npm test
"$MANAGER_WIRED_PYTHON" -m unittest discover -s tests/wired -v
npm run build
npm run test:wired-hosts
npm run package
npm run test:wired-hosts -- --packaged
```

Headless Linux host checks require `xvfb-run -a`. Fixtures use local synthetic
SSH/SFTP peers and explicitly substituted host adapters; CI never accesses a
physical tablet. Both browser/helper and unpackaged/packaged Electron paths are
checked. Windows checks exercise the shared browser helper with fixtures and
Electron's explicit unsupported native transport state. They do not qualify
Windows USB/SSH. A native Windows interface-constrained adapter, RM2/Paper Pro
hardware, Vellum package ownership, installation/update/rollback and REM-35
acceptance remain separate work.

Linux RM1 development observation was read-only on October 8, 2026: model
reMarkable 1.0, firmware 3.28.0.172, architecture armv7l, absent/inactive Buddy
unit. This establishes observation on that device/host, not firmware compatibility
or universal Linux qualification. Fixed sysfs model reads tolerate their synthetic
reported size within the byte limit; the OS release alias permits only the fixed
`/usr/lib/os-release` target with before/after consistency checks. Other symlinks,
changed metadata and oversized/partial ordinary files are refused.

Transport uses [Paramiko](https://www.paramiko.org/) 5.0.0 rather than implementing
SSH. Device state conventions and connection/cancellation prior art were reviewed
in [reManager](https://github.com/rmitchellscott/reManager) at
`b3047fbf12ad51193c5ff05563d2d7d677638c95`; its trust defaults are not adopted.
The central canonical contract is
[manager-wired-observation](https://github.com/s116821/RemarkableBuddiesDocs/tree/main/openspec/specs/manager-wired-observation).

## Windows development adapter (qualification pending)

The pending native Windows adapter uses Windows10/11 x64, Python3.10+, the same pinned Paramiko, and pinned pywin32 installed in a user-owned virtual environment. Use `py -3 -m venv <local-path>` then `<local-path>\\Scripts\\python.exe -m pip install -r host/requirements.txt`. Do not run pywin32 global post-install scripts in this environment. The interpreter remains external to portable Electron.

Inspect `Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter` and selected PnP parent properties to identify the actual present physical USB parent. The strict Windows config fields are `contract_version`, `interface_guid` (adapter GUID), `usb_instance` (uppercase physical USB device instance ID, without an MI interface suffix), `usb_vendor`/`usb_product` (lowercase four-digit hex), `source_address`, `host_key_sha256`, and `identity_file` (absolute local key path). These are host-only values. Never substitute an IP/interface alias for USB ancestry or trust a newly scanned host key. Existing Linux schema remains unchanged.

Store the local config and key in current-user-owned directories protected by NTFS ACLs. Disable inherited broad grants on the immediate directory and files; permit only the current user, SYSTEM and Administrators. The adapter independently checks owners/DACLs through opened handles, refuses remote/reparse/alternate-stream paths, holds parents against rename and reads bounded contents without sharing. Windows `chmod` is not an ACL setup method. Use ordinary Windows Security settings to review these locations; no elevation/broad grant bypass.

Set `$env:MANAGER_WIRED_CONFIG` and `$env:MANAGER_WIRED_PYTHON` to absolute local paths before launching Electron or the existing browser helper. The adapter verifies actual USB device ancestry, GUID/LUID/index and selected source/on-link routes; applies IP_UNICAST_IF in network order, verifies its host-order readback, then binds source and connects only to10.11.99.1:22. Network/PnP notifications invalidate reads and close the owned socket, including rapid removal/reattachment; unrelated network changes may conservatively stop a read too. Explicit reconnect remains required.

This is a development adapter pending Windows native API CI, independent review and Main's actual tablet/cable/competing-route qualification. A Windows ZIP's existence does not establish USB support. Browser fixture observations, real Windows API controls, real Python refusal through Electron, and physical tablet observations must be reported separately. Installed version/provenance remain unknown and Install stays disabled. No tablet mutation follows from setup.
