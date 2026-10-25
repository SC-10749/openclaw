import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const createdServers = vi.hoisted(() => [] as Server[]);

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

vi.mock("./mcp-http.handlers.js", () => ({
  handleMcpJsonRpc: async () => null,
}));

vi.mock("./mcp-http.runtime.js", () => ({
  McpLoopbackToolCache: class {
    clear() {}

    evictGrant() {}
  },
}));

vi.mock("./tool-resolution-completion.js", () => ({
  assertCompletionGrantLineage() {},
  createCompletionGrantLineageAdmission: () => ({ isCurrent: () => true }),
}));

import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

afterEach(async () => {
  await closeMcpLoopbackServer().catch(() => undefined);
  for (const server of createdServers) {
    if (!server.listening) {
      continue;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  createdServers.length = 0;
});

describe("MCP loopback listener liveness", () => {
  it("recreates the runtime after the listener closes outside managed shutdown", async () => {
    await ensureMcpLoopbackServer();
    const oldRuntime = getActiveMcpLoopbackRuntime();
    const oldServer = createdServers.at(-1);
    if (!oldRuntime || !oldServer) {
      throw new Error("expected an active MCP loopback server");
    }

    const closed = once(oldServer, "close");
    oldServer.close();
    await closed;

    expect(getActiveMcpLoopbackRuntime()).toBeUndefined();

    await ensureMcpLoopbackServer();
    const newRuntime = getActiveMcpLoopbackRuntime();
    const newServer = createdServers.at(-1);
    expect(newRuntime?.ownerToken).toBeDefined();
    expect(newRuntime?.ownerToken).not.toBe(oldRuntime.ownerToken);
    expect(newServer).not.toBe(oldServer);
  });
});
