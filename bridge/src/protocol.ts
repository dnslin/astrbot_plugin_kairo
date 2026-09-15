import type { SendResult } from '@kairo/driver';

export class RequestError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export interface SendParams {
  operation_id: string;
  target_session_id: string;
  kind: 'text' | 'image' | 'file';
  text?: string;
  file_id?: string;
  name?: string;
  mentions?: Array<{ uid: string; name: string }>;
  reply_to?: string;
}

export interface BridgeRequest {
  type: 'request';
  id: string;
  action: 'send' | 'get_send_status';
  params: SendParams | { operation_id: string };
}

function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RequestError('INVALID_REQUEST', `${name} 无效`);
  return value;
}

export function parseRequest(value: unknown): BridgeRequest {
  if (!value || typeof value !== 'object') throw new RequestError('INVALID_REQUEST', '请求必须是对象');
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, 'id');
  if (raw.type !== 'request' || !raw.params || typeof raw.params !== 'object') throw new RequestError('INVALID_REQUEST', '请求格式无效');
  const params = raw.params as Record<string, unknown>;
  const operation_id = text(params.operation_id, 'operation_id');
  if (raw.action === 'get_send_status') return { type: 'request', id, action: raw.action, params: { operation_id } };
  if (raw.action !== 'send') throw new RequestError('UNSUPPORTED_ACTION', '仅支持 send 和 get_send_status');
  const target_session_id = text(params.target_session_id, 'target_session_id');
  if (!/^[01]-.+/.test(target_session_id)) throw new RequestError('INVALID_REQUEST', 'target_session_id 必须为 KK9 私聊或群会话 ID');
  if (!['text', 'image', 'file'].includes(String(params.kind))) throw new RequestError('UNSUPPORTED_MESSAGE', '仅支持 text、image、file');
  const result: SendParams = { operation_id, target_session_id, kind: params.kind as SendParams['kind'] };
  if (params.reply_to !== undefined) result.reply_to = text(params.reply_to, 'reply_to');
  if (params.mentions !== undefined) {
    if (!Array.isArray(params.mentions) || params.mentions.length > 100) throw new RequestError('INVALID_REQUEST', 'mentions 无效');
    result.mentions = params.mentions.map((item: unknown) => {
      if (!item || typeof item !== 'object') throw new RequestError('INVALID_REQUEST', 'mentions 无效');
      const mention = item as Record<string, unknown>;
      return { uid: text(mention.uid, 'mentions.uid'), name: text(mention.name, 'mentions.name') };
    });
  }
  if (result.kind === 'text') {
    if (params.text === '' && result.mentions?.length) result.text = '';
    else result.text = text(params.text, 'text', 128_000);
  }
  else {
    result.file_id = text(params.file_id, 'file_id');
    if (!/^[a-f0-9]{32}$/.test(result.file_id)) throw new RequestError('INVALID_REQUEST', 'file_id 无效');
    if (params.name !== undefined) result.name = text(params.name, 'name');
    if (result.reply_to || result.mentions?.length) throw new RequestError('UNSUPPORTED_MESSAGE', '图片和文件发送不支持引用或提及');
  }
  return { type: 'request', id, action: 'send', params: result };
}

export function serializeResult(result: SendResult): Omit<SendResult, 'recall'> {
  const { success, operationId, status, messageId, error, isPreTrigger, verifyLatencyMs } = result;
  return { success, operationId, status, messageId, error, isPreTrigger, verifyLatencyMs };
}
