/**
 * Public programmatic API.
 *
 * Users typically run the CLI, but the package also exports the proxy and
 * recorder so they can be embedded in test harnesses and CI.
 */
export { startProxy, type ProxyOptions } from "./proxy.js";
export { startRecorder, type RecorderOptions } from "./recorder.js";
export { openTrace, type TraceViewerOptions } from "./viewer.js";
export { TraceStore, type StoredFrame } from "./trace-store.js";
export { parseFrames, classify } from "./jsonrpc.js";
export type {
  JsonRpcFrame,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "./jsonrpc.js";
