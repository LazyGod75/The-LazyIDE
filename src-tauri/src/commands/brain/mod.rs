//! LazyBrain integration commands. Split into focused sub-modules because the
//! combined subsystem (sidecar lifecycle, config resolution, capture,
//! GitHub publish, scoped search, history import) is the largest in the app
//! -- a single flat `brain.rs` would be ~3300 lines.

pub(crate) mod sidecar;
pub(crate) mod capture;
pub(crate) mod maintenance;
pub(crate) mod ops;
pub(crate) mod config;
pub(crate) mod publish;
pub(crate) mod search;
pub(crate) mod history_import;
pub(crate) mod index_project;
pub(crate) mod project_gitignore;
