import { HostBridgeWsClientCompletionAndDispatchLayer } from "./HostBridgeWsClientCompletionAndDispatchLayer";

export {
  BridgeProtocolVersionError,
  isRpcRequestError,
  RpcRequestError,
} from "./wsErrors";

export class HostBridgeWsClient extends HostBridgeWsClientCompletionAndDispatchLayer {}
