import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  groupRunningAgentProcesses,
  parseIdeProjects,
  parseRestartProcessTree,
} from "./agent-restart";

test("groups Codex extension processes under one VS Code restart target", () => {
  const processes = parseRestartProcessTree(`
  100 1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
  110 100 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)
  120 110 /Users/max/.vscode/extensions/openai.chatgpt/bin/codex app-server
  130 110 /Users/max/.vscode/extensions/openai.chatgpt/bin/codex app-server
  `);
  assert.deepEqual(groupRunningAgentProcesses(processes, ["codex"], {
    vscode: [{ name: "OL2", path: "/Users/max/Code/OL2" }, { name: "FileMesh" }],
  }), [{
    id: "application:vscode",
    application: "Visual Studio Code",
    applicationKind: "vscode",
    icon: "agent-icons/vscode.png",
    agentKinds: ["codex"],
    agentNames: ["OpenAI Codex"],
    processIds: [120, 130],
    projects: [{ name: "OL2", path: "/Users/max/Code/OL2" }, { name: "FileMesh" }],
  }]);
});

test("keeps standalone terminal agents separate with their project path", () => {
  const projectPath = path.resolve("Project");
  const processes = parseRestartProcessTree(`
  200 1 /Applications/Terminal.app/Contents/MacOS/Terminal
  210 200 /bin/zsh
  220 210 /opt/homebrew/bin/claude
  `);
  processes.find((item) => item.pid === 220)!.cwd = projectPath;
  assert.deepEqual(groupRunningAgentProcesses(processes, ["claude-code"]), [{
    id: "terminal:claude-code:220",
    application: "Claude Code terminal",
    applicationKind: "terminal",
    icon: "agent-icons/claude.svg",
    agentKinds: ["claude-code"],
    agentNames: ["Claude Code"],
    processIds: [220],
    projects: [{ name: "Project", path: projectPath }],
  }]);
});

test("extracts open project names from IDE status output", () => {
  assert.deepEqual(parseIdeProjects(`
    0 100 window [1] (FileMesh (All))
    0 100 window [2] (OL2)
  Workspace Stats:
  |  Window (Welcome - Hi)
  |  Folder (FileMesh (All)): 900 files
  |  Folder (OL2): 1200 files
  `), [
    { name: "Hi" },
    { name: "FileMesh (All)" },
    { name: "OL2" },
  ]);
});
