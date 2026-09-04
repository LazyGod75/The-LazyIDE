//! Git commands (status/diff/branch/stage/commit/push/log) and agent
//! worktree lifecycle (create/diff/merge/discard) -- worktrees are just git
//! repos so they live alongside the rest of the git plumbing.
//!
//! Split into focused sub-modules (the combined file was ~2800 lines):
//!   - `status`:    read primitives (`git_status`, `git_diff`,
//!                  `git_current_branch`) + `git_binary()`, shared by every
//!                  sibling module here.
//!   - `worktree`:  agent worktree lifecycle (create/diff/merge/discard/
//!                  revert).
//!   - `staging`:   stage/unstage/commit/push/can_push.
//!   - `branches`:  branch listing, orphan-worktree classification, log.
//!
//! All items re-exported here so existing `crate::commands::git::X` call
//! sites keep working unchanged.

pub(crate) mod status;
pub(crate) mod worktree;
pub(crate) mod staging;
pub(crate) mod branches;

pub(crate) use status::*;
pub(crate) use worktree::*;
pub(crate) use staging::*;
pub(crate) use branches::*;
