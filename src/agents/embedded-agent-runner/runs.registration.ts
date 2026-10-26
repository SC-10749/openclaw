import {
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS,
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS,
  detachNativeAttempt,
  type ActiveEmbeddedRunAttachment,
  type EmbeddedAgentQueueHandle,
} from "./run-state.js";

export function assertEmbeddedRunRegistrationCanReplace(params: {
  previousAttachment: unknown;
  operation: object | undefined;
  previousControllerAttachment: { operation?: object } | undefined;
  assertRegistrationActive?: () => void;
  revokeCompletionClaim: () => void;
}): void {
  try {
    params.assertRegistrationActive?.();
    if (
      params.previousAttachment &&
      params.operation &&
      (!params.previousControllerAttachment ||
        params.previousControllerAttachment.operation !== params.operation)
    ) {
      throw new Error("Native registration requires its controller backend attachment");
    }
  } catch (error) {
    params.revokeCompletionClaim();
    throw error;
  }
}

export function retirePreviousEmbeddedRunAttachment(params: {
  attachment: ActiveEmbeddedRunAttachment;
  clearAbortability: (handle: EmbeddedAgentQueueHandle) => void;
  clearFiles: (attachment: ActiveEmbeddedRunAttachment) => void;
}): void {
  const { attachment } = params;
  const previousHandle = attachment.handle;
  attachment.watchdogAttempt?.close();
  attachment.closeWatchdogWait?.();
  previousHandle.closeDiagnostics?.();
  params.clearAbortability(previousHandle);
  detachNativeAttempt(attachment);
  params.clearFiles(attachment);
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(attachment);
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(previousHandle);
}
