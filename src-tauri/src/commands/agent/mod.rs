//! Autonomous agent mission execution (agent_run + kill), the local cron
//! scheduler (PID state, MCP config for brain access), and the lazy_agent
//! definition CRUD commands.

mod brain_mcp;
mod extra_roots;
mod lifecycle;
mod protocol;
mod run;
mod scheduler;
mod scheduler_run;
mod storage;

pub(crate) use lifecycle::*;
pub(crate) use run::*;
pub(crate) use scheduler::*;
pub(crate) use scheduler_run::*;
pub(crate) use storage::*;
