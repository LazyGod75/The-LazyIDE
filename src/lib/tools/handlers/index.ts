/* Dispatch table for executeTool — one entry per tool action, grouped by
   domain module. The KEYS below are the action strings the model produces
   and MUST match toolRegistry.ts's tool names exactly (a typo here
   silently breaks that tool for every caller). */

import type { ToolHandler } from './types.js';
import {
  readFile,
  grepFile,
  writeFile,
  editFile,
  multiEdit,
  undoEdit,
  renameFile,
  deleteFile,
  globFiles,
  findFile,
  readDir,
} from './files.js';
import {
  searchCode,
  searchSymbols,
  gotoDefinition,
  findReferences,
  getDiagnostics,
} from './search.js';
import { runCommand, runTests, runLint, runBuild } from './shell.js';
import {
  gitStatus,
  gitDiff,
  gitLog,
  gitCommit,
  reviewDiff,
  gitCreatePr,
} from './git.js';
import { webSearch, webFetch, checkUrl } from './network.js';
import {
  brainQuery,
  brainQueryCss,
  brainNeighbours,
  brainRecord,
  brainSynthesize,
} from './brain.js';
import { listTransforms, runTransform, delegate, askUser, findTool } from './meta.js';
import { mcpListTools, mcpCall } from './mcp.js';
import {
  browserOpen,
  browserNavigate,
  browserClick,
  browserFill,
  browserScreenshot,
  browserSnapshot,
  browserClose,
} from './browser.js';
import {
  cloudBrowserOpen,
  cloudBrowserClose,
  cloudBrowserNavigate,
  cloudBrowserReadPage,
  cloudBrowserClick,
  cloudBrowserType,
  cloudBrowserScreenshot,
  cloudBrowserScroll,
  cloudBrowserWait,
  cloudBrowserReplayUrl,
  cloudBrowserProfilesList,
  cloudBrowserProfileSave,
} from './cloudBrowser.js';
import {
  cloudDesktopOpen,
  cloudDesktopClose,
  cloudDesktopScreenshot,
  cloudDesktopStreamUrl,
  cloudDesktopMouseClick,
  cloudDesktopMouseMove,
  cloudDesktopKeyboardType,
  cloudDesktopKeyboardHotkey,
  cloudDesktopExec,
  cloudDesktopClipboardGet,
  cloudDesktopClipboardSet,
  cloudDesktopFileWrite,
} from './cloudDesktop.js';
import {
  cloudSandboxOpen,
  cloudSandboxClose,
  cloudSandboxReadFile,
  cloudSandboxFileList,
  cloudSandboxWriteFile,
  cloudSandboxExec,
  cloudSandboxPreviewUrl,
} from './cloudSandbox.js';

export const toolHandlers: Record<string, ToolHandler> = {
  read_file: readFile,
  grep_file: grepFile,
  write_file: writeFile,
  edit_file: editFile,
  multi_edit: multiEdit,
  undo_edit: undoEdit,
  rename_file: renameFile,
  delete_file: deleteFile,
  glob: globFiles,
  find_file: findFile,
  read_dir: readDir,

  search_code: searchCode,
  search_symbols: searchSymbols,
  goto_definition: gotoDefinition,
  find_references: findReferences,
  get_diagnostics: getDiagnostics,

  run_command: runCommand,
  run_tests: runTests,
  run_lint: runLint,
  run_build: runBuild,

  git_status: gitStatus,
  git_diff: gitDiff,
  git_log: gitLog,
  git_commit: gitCommit,
  review_diff: reviewDiff,
  git_create_pr: gitCreatePr,

  web_search: webSearch,
  web_fetch: webFetch,
  check_url: checkUrl,

  brain_query: brainQuery,
  brain_query_css: brainQueryCss,
  brain_neighbours: brainNeighbours,
  brain_record: brainRecord,
  brain_synthesize: brainSynthesize,

  list_transforms: listTransforms,
  run_transform: runTransform,
  delegate,
  ask_user: askUser,
  find_tool: findTool,

  mcp_list_tools: mcpListTools,
  mcp_call: mcpCall,

  browser_open: browserOpen,
  browser_navigate: browserNavigate,
  browser_click: browserClick,
  browser_fill: browserFill,
  browser_screenshot: browserScreenshot,
  browser_snapshot: browserSnapshot,
  browser_close: browserClose,

  cloud_browser_open: cloudBrowserOpen,
  cloud_browser_close: cloudBrowserClose,
  cloud_browser_navigate: cloudBrowserNavigate,
  cloud_browser_read_page: cloudBrowserReadPage,
  cloud_browser_click: cloudBrowserClick,
  cloud_browser_type: cloudBrowserType,
  cloud_browser_screenshot: cloudBrowserScreenshot,
  cloud_browser_scroll: cloudBrowserScroll,
  cloud_browser_wait: cloudBrowserWait,
  cloud_browser_replay_url: cloudBrowserReplayUrl,
  cloud_browser_profiles_list: cloudBrowserProfilesList,
  cloud_browser_profile_save: cloudBrowserProfileSave,

  cloud_desktop_open: cloudDesktopOpen,
  cloud_desktop_close: cloudDesktopClose,
  cloud_desktop_screenshot: cloudDesktopScreenshot,
  cloud_desktop_stream_url: cloudDesktopStreamUrl,
  cloud_desktop_mouse_click: cloudDesktopMouseClick,
  cloud_desktop_mouse_move: cloudDesktopMouseMove,
  cloud_desktop_keyboard_type: cloudDesktopKeyboardType,
  cloud_desktop_keyboard_hotkey: cloudDesktopKeyboardHotkey,
  cloud_desktop_exec: cloudDesktopExec,
  cloud_desktop_clipboard_get: cloudDesktopClipboardGet,
  cloud_desktop_clipboard_set: cloudDesktopClipboardSet,
  cloud_desktop_file_write: cloudDesktopFileWrite,

  cloud_sandbox_open: cloudSandboxOpen,
  cloud_sandbox_close: cloudSandboxClose,
  cloud_sandbox_read_file: cloudSandboxReadFile,
  cloud_sandbox_file_list: cloudSandboxFileList,
  cloud_sandbox_write_file: cloudSandboxWriteFile,
  cloud_sandbox_exec: cloudSandboxExec,
  cloud_sandbox_preview_url: cloudSandboxPreviewUrl,
};
