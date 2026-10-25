import { once } from "node:events";
import type { Server } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const createdServers = vi.hoisted(() => [] as Server[]);
const execute = vi.hoisted(() => vi.fn());
const resolveTools = vi.hoisted(() => vi.fn());

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      createdServers.push(server);
      return server;
    },
  };
});

// mock-isolation: Use an empty runtime config so the real listener test has no host state dependency.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
// mock-isolation: Keep before-tool policy pass-through while exercising the real HTTP handler.
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));
// mock-isolation: Supply one deterministic real tool so the request reaches tool execution.
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));

import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const completed = { content: [{ type: "text", text: "real loopback recovery" }] };

beforeEach(() => {
  execute.mockReset().mockResolvedValue(completed);
  resolveTools.mockReset().mockReturnValue(mcp.probeTools("recovery_probe", execute));
});

afterEach(async () => {
  await closeMcpLoopbackServer();
  createdServers.length = 0;
});

it("recovers a real MCP request after the listener closes unexpectedly", async () => {
  await ensureMcpLoopbackServer();
  const oldRuntime = expectDefined(getActiveMcpLoopbackRuntime(), "old MCP runtime");
  const oldServer = expectDefined(createdServers.at(-1), "old MCP server");

  expect(
    await mcp.json(await mcp.request(oldRuntime, mcp.toolCall("recovery_probe"))),
  ).toMatchObject({ result: { ...completed, isError: false } });

  const closed = once(oldServer, "close");
  oldServer.close();
  await closed;
  expect(getActiveMcpLoopbackRuntime()).toBeUndefined();

  await ensureMcpLoopbackServer();
  const newRuntime = expectDefined(getActiveMcpLoopbackRuntime(), "new MCP runtime");
  const newServer = expectDefined(createdServers.at(-1), "new MCP server");
  expect(newRuntime.ownerToken).not.toBe(oldRuntime.ownerToken);
  expect(newServer).not.toBe(oldServer);

  expect(
    await mcp.json(await mcp.request(newRuntime, mcp.toolCall("recovery_probe"))),
  ).toMatchObject({ result: { ...completed, isError: false } });
  expect(execute).toHaveBeenCalledTimes(2);
});
