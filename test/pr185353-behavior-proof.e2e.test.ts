import { expect, it } from "vitest";
import type { UsersSelfResult } from "../packages/gateway-protocol/src/schema/users.js";
import { resolveSessionStorePathCore } from "../src/config/sessions/paths.js";
import { listSessionParticipantsReadOnly } from "../src/config/sessions/session-accessor.sqlite-participant-read.js";
import { createChatFixture } from "../src/gateway/gateway-chat-fixture.test-support.js";
import { kernelGatewayTestStateOptions } from "../src/gateway/test-helpers.env.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

type SessionRow = {
  key?: string;
  participants?: Array<{ identity?: { type?: string; id?: string } }>;
  expandedParticipants?: Array<{ identity?: { type?: string; id?: string } }>;
  participantCount?: number;
};

type SessionPerson = { identity?: { type?: string; id?: string }; sessionCount?: number };

type SessionListResult = {
  sessions?: SessionRow[];
  total?: number;
  totalCount?: number;
  involvingProfileId?: string;
  people?: SessionPerson[];
};

it(
  "proves authenticated WebChat busy input participant persistence and deduplication",
  { timeout: 120_000 },
  () =>
    withOpenClawTestState(kernelGatewayTestStateOptions("pr-185353-behavior-proof"), async () => {
      const firstProviderRequest = createDeferredCore<void>();
      const releaseFirstProviderRequest = createDeferredCore<void>();
      let providerRequestCount = 0;
      const fixture = createChatFixture("pr-185353-behavior-proof", {
        respond: async () => {
          providerRequestCount += 1;
          if (providerRequestCount === 1) {
            firstProviderRequest.resolve();
            await releaseFirstProviderRequest.promise;
          }
          return `local-provider-reply-${providerRequestCount}`;
        },
        configure: (cfg) => ({
          ...cfg,
          plugins: { slots: { memory: "none" } },
          tools: { profile: "minimal" },
        }),
      });

      await runQaGatewayFixture(
        async () => {
          await fixture.start();
          const client = fixture.client;
          const self = await client.request<UsersSelfResult>("users.self", {});
          const created = await client.request<{ key: string }>("sessions.create", {
            agentId: "main",
            label: "PR 185353 behavior proof",
          });
          const sessionKey = created.key;
          const involving = () =>
            client.request<SessionListResult>("sessions.list", {
              profileRelation: { profileId: self.profile.id, relationship: "involving" },
              includePeople: true,
              includeGlobal: true,
              limit: 100,
            });
          const firstRunId = "pr185353-first";
          const busyRunId = "pr185353-busy";
          const busyParams = {
            sessionKey,
            message: "second persisted WebChat input during busy admission",
            idempotencyKey: busyRunId,
          };
          const firstPromise = client.request<{ runId: string; status: string }>("chat.send", {
            sessionKey,
            message: "first message keeps the reply operation busy",
            idempotencyKey: firstRunId,
          });
          const busyPromise = client.request<{ runId: string; status: string }>(
            "chat.send",
            busyParams,
          );
          const [first, busy] = await Promise.all([firstPromise, busyPromise]);
          expect(first).toMatchObject({ runId: firstRunId, status: "started" });
          expect(busy.runId).toBe(busyRunId);
          await firstProviderRequest.promise;

          const beforeBusy = await involving();
          const duringBusy = await involving();

          const duplicate = await client.request<{ runId: string; status: string }>(
            "chat.send",
            busyParams,
          );
          expect(duplicate.runId).toBe(busyRunId);
          const afterDuplicate = await involving();

          releaseFirstProviderRequest.resolve();
          const busyWait = await client.request<{ status: string }>(
            "agent.wait",
            { runId: busyRunId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          );
          expect(busyWait.status).toBe("ok");
          const firstWait = await client.request<{ status: string }>(
            "agent.wait",
            { runId: firstRunId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          );
          expect(firstWait.status).toBe("ok");

          const sessionRows =
            afterDuplicate.sessions?.filter((row) => row.key === sessionKey) ?? [];
          const participantIds = [
            ...(afterDuplicate.people ?? []),
            ...sessionRows.flatMap((row) => [
              ...(row.participants ?? []),
              ...(row.expandedParticipants ?? []),
            ]),
          ]
            .map((participant) => participant.identity?.id)
            .filter((id): id is string => id !== undefined);
          const persistedParticipantIds = [
            ...(listSessionParticipantsReadOnly({
              agentId: "main",
              sessionKey,
              storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            }).get(sessionKey) ?? []),
          ].map((participant) => participant.identity.id);
          const history = await client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey,
            limit: 50,
          });
          const userMessages = history.messages.filter(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              (message as { role?: unknown }).role === "user",
          );

          console.log(
            JSON.stringify({
              gateway: "real local Gateway",
              clientMode: "webchat",
              profileId: self.profile.id,
              firstStatus: first.status,
              busyStatus: busy.status,
              beforeBusy: {
                total: beforeBusy.total ?? beforeBusy.totalCount,
                keys: beforeBusy.sessions?.map((row) => row.key),
              },
              duringBusy: {
                total: duringBusy.total ?? duringBusy.totalCount,
                keys: duringBusy.sessions?.map((row) => row.key),
              },
              afterDuplicate: {
                total: afterDuplicate.total ?? afterDuplicate.totalCount,
                keys: afterDuplicate.sessions?.map((row) => row.key),
                people: afterDuplicate.people,
                participants: sessionRows.flatMap((row) => row.participants ?? []),
                expandedParticipants: sessionRows.flatMap((row) => row.expandedParticipants ?? []),
              },
              involvingProfileId: afterDuplicate.involvingProfileId,
              participantIds,
              persistedParticipantIds,
              userMessageCount: userMessages.length,
              providerRequestCount,
              fixtureErrors: fixture.errors,
            }),
          );

          expect(sessionRows).toHaveLength(1);
          expect(persistedParticipantIds).toContain(self.profile.id);
          expect(userMessages).toHaveLength(2);
          expect(providerRequestCount).toBe(1);
          expect(fixture.errors).toEqual([]);
        },
        () => fixture.close(),
      );
    }),
);
