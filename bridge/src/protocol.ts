import type { KK9AppMsgOptions, KK9BizMsgOptions, KK9Employee, KK9Session, KK9UrlCardOptions, SendResult } from '@kairo/driver';

export class RequestError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

type SendTarget = { operation_id: string; target_session_id: string };
export type SendParams = SendTarget & (
  | { kind: 'text'; text: string; mentions?: Array<{ uid: string; name: string }>; reply_to?: string }
  | { kind: 'image' | 'file' | 'voice'; file_id: string; name?: string }
  | { kind: 'app_card'; card: KK9AppMsgOptions }
  | { kind: 'url_card'; card: KK9UrlCardOptions }
  | { kind: 'biz_card'; card: KK9BizMsgOptions }
);
type Request<A extends string, P> = { type: 'request'; id: string; action: A; params: P };
export type BridgeRequest =
  | Request<'send', SendParams>
  | Request<'send_to_user', { operation_id: string; login_name: string; text: string }>
  | Request<'get_send_status', { operation_id: string }>
  | Request<'get_sessions', Record<string, never>>
  | Request<'get_user_profile', { user_id: string }>;
export type BridgeResult = SendResult | { sessions: KK9Session[] } | { profile: KK9Employee | null };

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError('INVALID_REQUEST', `${name}无效`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RequestError('INVALID_REQUEST', `${name} 无效`);
  return value;
}
function fields(raw: Record<string, unknown>, allowed: string[], name: string): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new RequestError('INVALID_REQUEST', `${name} 包含不支持的字段`);
}
function cardText(raw: Record<string, unknown>, key: string): string { return text(raw[key], `card.${key}`, 128_000); }
function optionalCardText(raw: Record<string, unknown>, key: string): Record<string, string> {
  return raw[key] === undefined ? {} : { [key]: cardText(raw, key) };
}

export function parseRequest(value: unknown): BridgeRequest {
  const raw = object(value, '请求');
  const id = text(raw.id, 'id');
  if (raw.type !== 'request' || !raw.params || typeof raw.params !== 'object' || Array.isArray(raw.params)) throw new RequestError('INVALID_REQUEST', '请求格式无效');
  const params = raw.params as Record<string, unknown>;
  if (raw.action === 'get_sessions') {
    fields(params, [], 'params');
    return { type: 'request', id, action: raw.action, params: {} };
  }
  if (raw.action === 'get_user_profile') {
    fields(params, ['user_id'], 'params');
    return { type: 'request', id, action: raw.action, params: { user_id: text(params.user_id, 'user_id') } };
  }
  if (!['send', 'send_to_user', 'get_send_status'].includes(String(raw.action))) throw new RequestError('UNSUPPORTED_ACTION', '仅支持 send、send_to_user、get_send_status、get_sessions 和 get_user_profile');
  const operation_id = text(params.operation_id, 'operation_id');
  if (raw.action === 'get_send_status') {
    fields(params, ['operation_id'], 'params');
    return { type: 'request', id, action: raw.action, params: { operation_id } };
  }
  if (raw.action === 'send_to_user') {
    fields(params, ['operation_id', 'login_name', 'text'], 'send_to_user');
    return { type: 'request', id, action: raw.action, params: { operation_id, login_name: text(params.login_name, 'login_name').trim(), text: text(params.text, 'text', 128_000) } };
  }
  const target_session_id = text(params.target_session_id, 'target_session_id');
  if (!/^[1-9]\d*$/.test(target_session_id) || !Number.isSafeInteger(Number(target_session_id))) throw new RequestError('INVALID_REQUEST', 'target_session_id 必须为原生正整数会话 ID 字符串');
  const target = { operation_id, target_session_id };
  if (params.kind !== 'text' && (params.reply_to !== undefined || params.mentions !== undefined)) throw new RequestError('UNSUPPORTED_MESSAGE', '非文本发送不支持引用或提及');
  let result: SendParams;
  switch (params.kind) {
    case 'text': {
      fields(params, ['operation_id', 'target_session_id', 'kind', 'text', 'mentions', 'reply_to'], 'send');
      const mentions = params.mentions;
      const parsedMentions = mentions === undefined ? undefined : (() => {
        if (!Array.isArray(mentions) || mentions.length > 100) throw new RequestError('INVALID_REQUEST', 'mentions 无效');
        return mentions.map((item: unknown) => {
          const mention = object(item, 'mentions');
          return { uid: text(mention.uid, 'mentions.uid'), name: text(mention.name, 'mentions.name') };
        });
      })();
      result = { ...target, kind: 'text', text: params.text === '' && parsedMentions?.length ? '' : text(params.text, 'text', 128_000) };
      if (parsedMentions !== undefined) result.mentions = parsedMentions;
      if (params.reply_to !== undefined) result.reply_to = text(params.reply_to, 'reply_to');
      break;
    }
    case 'image': case 'file': case 'voice': {
      fields(params, ['operation_id', 'target_session_id', 'kind', 'file_id', 'name'], 'send');
      const file_id = text(params.file_id, 'file_id');
      if (!/^[a-f0-9]{32}$/.test(file_id)) throw new RequestError('INVALID_REQUEST', 'file_id 无效');
      result = { ...target, kind: params.kind, file_id };
      if (params.name !== undefined) result.name = text(params.name, 'name');
      break;
    }
    case 'app_card': {
      fields(params, ['operation_id', 'target_session_id', 'kind', 'card'], 'send');
      const card = object(params.card, 'card');
      fields(card, ['title', 'content', 'linkUrl', 'pcAppCode'], 'card');
      result = { ...target, kind: params.kind, card: { title: cardText(card, 'title'), content: cardText(card, 'content'), ...optionalCardText(card, 'linkUrl'), ...optionalCardText(card, 'pcAppCode') } };
      break;
    }
    case 'url_card': {
      fields(params, ['operation_id', 'target_session_id', 'kind', 'card'], 'send');
      const card = object(params.card, 'card');
      fields(card, ['title', 'summary', 'linkUrl', 'picUrl'], 'card');
      result = { ...target, kind: params.kind, card: { title: cardText(card, 'title'), summary: cardText(card, 'summary'), linkUrl: cardText(card, 'linkUrl'), ...optionalCardText(card, 'picUrl') } };
      break;
    }
    case 'biz_card': {
      fields(params, ['operation_id', 'target_session_id', 'kind', 'card'], 'send');
      const card = object(params.card, 'card');
      fields(card, ['title', 'content', 'summary', 'bizUrl', 'bizType'], 'card');
      if (card.bizType !== 1 && card.bizType !== 2) throw new RequestError('INVALID_REQUEST', 'card.bizType 必须为 1 或 2');
      const bizUrl = cardText(card, 'bizUrl');
      if (!bizUrl.startsWith('/') || bizUrl.startsWith('//')) throw new RequestError('INVALID_REQUEST', 'card.bizUrl 必须为相对路径');
      const summary = card.summary;
      if (summary !== undefined && (!Array.isArray(summary) || summary.some((item) => typeof item !== 'string'))) throw new RequestError('INVALID_REQUEST', 'card.summary 必须为字符串数组');
      result = { ...target, kind: params.kind, card: { title: cardText(card, 'title'), content: cardText(card, 'content'), bizUrl, bizType: card.bizType, ...(summary !== undefined ? { summary: summary as string[] } : {}) } };
      break;
    }
    default: throw new RequestError('UNSUPPORTED_MESSAGE', '仅支持 text、image、file、voice、app_card、url_card、biz_card');
  }
  return { type: 'request', id, action: 'send', params: result };
}

export function serializeResult(result: BridgeResult): Record<string, unknown> {
  if ('sessions' in result) return { sessions: result.sessions };
  if ('profile' in result) return { profile: result.profile };
  const { operationId, status, messageId, sessionId, error, nativeCode, receipt, isPreTrigger, verifyLatencyMs } = result;
  return { operationId, status, messageId, sessionId, error, nativeCode, receipt, isPreTrigger, verifyLatencyMs };
}

export function serializeError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'BRIDGE_ERROR';
    const message = 'message' in error && typeof error.message === 'string' ? error.message : String(error);
    return { code, message };
  }
  return { code: 'BRIDGE_ERROR', message: String(error) };
}
