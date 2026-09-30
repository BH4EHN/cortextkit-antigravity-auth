# Changelog

## [Unreleased]

### Added

- Added an OpenCode 2 TUI panel and slash commands for account management, quota, and adapter status.

### Fixed

- Preserved account-pool writes across command mutations and normalized unsupported numeric tool-schema constraints before Antigravity requests.

## [2.3.0] - 2026-09-17

### Added

- Added the OpenCode 2.x host adapter with shared Antigravity OAuth, model routing, account rotation, and raw AGY transport.
- Added deterministic real-host coverage in a network-isolated Docker container.
- Enforced AGY request metadata, tool-call signatures, Claude thinking, image handling, and terminal stream error propagation.
