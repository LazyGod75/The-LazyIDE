//! Brain path/config resolution (env override / UI-persisted choice /
//! project-local / home fallback), the brain-config.json read/write commands,
//! and project-switch + clone/import commands that (re)start the sidecar.
//!
//! Split into focused sub-modules (the combined file was ~3000 lines):
//!   - `brain_projects_list`: the flat `brain-projects.json` path list
//!                (get/set) and the multi-project graph merge
//!                (`brain_fetch_graph_merged`).
//!   - `health`:      `brain_fetch_health` and the `cerveau-health` meta-tag
//!                parsing it depends on.
//!   - `diagnostics`: `brain_stats` / `brain_wipe` -- the bundled `lazybrain
//!                stats` / `wipe --yes` proxies.
//!   - `structural_query`: `brain_query_css` / `brain_neighbours` -- the
//!                deterministic CSS-selector query and 1-hop graph follow.
//!   - `bin_resolve`: `resolve_lazybrain_bin_static` and the process-env
//!                exposure of the resolved engine paths.
//!   - `brain_config_file`: the `BrainConfig` on-disk shape
//!                (`brain-config.json`) -- read/write/persist and the
//!                UI-persisted-path resolution it feeds.
//!   - `path_resolve`: the canonical brain-path resolver
//!                (`resolve_unified_brain_path` / `resolve_brain_path_core`),
//!                `BrainInfo` / `get_brain_info`, note counting, and the
//!                seed-time stranded-brain fix.
//!   - `project_registry`: the multi-project registry commands
//!                (`project_register` / `project_set_active` /
//!                `project_close` / `project_list` / `set_project`) and
//!                their disk-backed persistence.
//!   - `brain_config_apply`: validating + applying a `set_brain_config`
//!                request, and the shared sidecar-restart/retry helpers.
//!   - `brain_import_github`: `import_brain_from_github` and the clone +
//!                brain-shape validation it depends on.
//!
//! All items re-exported here so existing `crate::commands::brain::config::X`
//! call sites keep working unchanged.

pub(crate) mod brain_projects_list;
pub(crate) mod health;
pub(crate) mod diagnostics;
pub(crate) mod structural_query;
pub(crate) mod bin_resolve;
pub(crate) mod brain_config_file;
pub(crate) mod path_resolve;
pub(crate) mod project_registry;
pub(crate) mod brain_config_apply;
pub(crate) mod brain_import_github;

pub(crate) use brain_projects_list::*;
pub(crate) use health::*;
pub(crate) use diagnostics::*;
pub(crate) use structural_query::*;
pub(crate) use bin_resolve::*;
pub(crate) use brain_config_file::*;
pub(crate) use path_resolve::*;
pub(crate) use project_registry::*;
pub(crate) use brain_config_apply::*;
pub(crate) use brain_import_github::*;
