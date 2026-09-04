//! Tauri command handlers, grouped by subsystem. This module tree replaces
//! the former single-file `lib.rs` monolith (see SPEC.md section 10) with
//! cohesive per-subsystem modules; `lib.rs` remains the composition root
//! (state registration + `generate_handler!` wiring).

pub(crate) mod util;

pub(crate) mod canvas;
pub(crate) mod fs;
pub(crate) mod terminal;
pub(crate) mod shell;
pub(crate) mod git;
pub(crate) mod journal;
pub(crate) mod worktree_cleanup;
pub(crate) mod worktree_sweep;
pub(crate) mod teams;
pub(crate) mod teams_git;
pub(crate) mod github_oauth;
pub(crate) mod vault;
pub(crate) mod chat;
pub(crate) mod agent;
pub(crate) mod brain;
pub(crate) mod web;
pub(crate) mod mcp;
pub(crate) mod browser;
pub(crate) mod browser_recipe;
pub(crate) mod system_pressure;
