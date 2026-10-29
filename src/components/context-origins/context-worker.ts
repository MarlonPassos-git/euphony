import {
  analyzeContext,
  getContextCheckpoints
} from '../../utils/context-origins';

// Tokenization stays off the UI thread. Only the requested checkpoint is
// analyzed; large sessions do not create one full report per request up front.
self.onmessage = (
  event: MessageEvent<{ events: unknown[]; index: number; request: number }>
) => {
  try {
    const checkpoints = getContextCheckpoints(event.data.events);
    const checkpoint = checkpoints[event.data.index] ?? checkpoints[0];
    self.postMessage({
      request: event.data.request,
      checkpoints,
      report: analyzeContext(event.data.events, checkpoint)
    });
  } catch (error) {
    self.postMessage({
      request: event.data.request,
      error: error instanceof Error ? error.message : 'Context analysis failed.'
    });
  }
};
