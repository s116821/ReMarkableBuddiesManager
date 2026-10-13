# Manager downloads in both views

The shared browser/helper and Electron views can explicitly download and check a stable Manager release using the existing canonical bundle consumer. All three platform ZIPs and provenance are saved together in a new host-owned folder. No payload is extracted or run, no application is replaced and no tablet is touched.

## Host setup
Use supported Node24.21 and a trusted Python3.12 installation. Set MANAGER_DOWNLOAD_PARENT to an existing canonical absolute downloads directory on a hard-link-capable filesystem, and MANAGER_DOWNLOAD_PYTHON to the trusted interpreter absolute path, in the host environment before starting Electron or the local helper. Resolve aliases/short paths first. The renderer cannot set these paths, choose an executable, repository, URL or filename. Ordinary deployed browser pages require the local helper for host file access. Unconfigured hosts refuse before download traffic.

## Use
Refresh Manager releases, then select Download and verify Manager files for a complete current stable candidate. The fixed consumer independently rechecks annotated canonical tag/source/publication/completion, downloaded digests and bounded embedded build declarations. Status checks resume an in-process host attempt; cancellation targets its opaque operation ID. One host instance permits one active attempt. Closing the host aborts pending work. Hosts do not recover pending work or claim success after a restart; existing files can be checked through the manual workflow.

A completed result names the selected tag, source SHA and host-chosen manager-download-<opaque ID> child inside your configured folder. This records checking at completion, not continuing file custody, signature trust, executable safety or native compatibility. Reverify before using downloaded files. Installation/update eligibility remains false; no automatic updater is provided.

Failure/cancellation can leave partial public release files with no successful receipt. Retries create a new folder and never overwrite/delete earlier or user-owned files. Cancellation arriving after successful atomic receipt issuance does not undo that committed download. Unknown or malformed host status is not success: check the current host status before retrying.

The package includes the fixed trusted Python verifier and unchanged hash-qualified producer modules beside host resources; interpreter provisioning stays explicit. The source-checkout [manual verification guide](manager-bundle-verification.md) remains available without UI or private tools.

Central owning change: manager-download-ui. Verification separates actual controlled local HTTP/ZIP/process/filesystem evidence from substituted browser/Electron UI reports. No live official-release or native update claim follows.
