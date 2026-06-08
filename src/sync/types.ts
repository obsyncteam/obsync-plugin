export interface ServerOperation {
  serverSeq: number;
  vaultId: string;
  opId: string;
  deviceId: string;
  operationType: string;
  fileId?: string;
  path?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ClientOperation {
  type: "operation";
  opId: string;
  operationType: string;
  fileId?: string;
  path?: string;
  payload: Record<string, unknown>;
}

export type SyncClientEvent =
  | { type: "status"; status: string }
  | { type: "operation"; operation: ServerOperation }
  | { type: "ack"; opId: string; serverSeq: number }
  | { type: "error"; message: string };
