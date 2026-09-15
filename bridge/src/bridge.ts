import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type { IKK9Driver, KK9Message, SendOptions, SendResult } from '@kairo/driver';
import type { BridgeConfig } from './config.js';
import { Attachments, type WireMessage } from './attachments.js';
import { parseRequest, RequestError, serializeResult, type BridgeRequest, type SendParams } from './protocol.js';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;
interface PendingEvent { message: KK9Message; prepared?: WireMessage; socket?: WebSocket }
export const eventId = (message: KK9Message): string => createHash('sha256').update(JSON.stringify([message.sessionId, message.messageId || message.id])).digest('hex');

export class Bridge {
  private driver: IKK9Driver | null = null;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingEvent>();
  private readonly abort = new AbortController();
  private requests: Promise<void> = Promise.resolve();
  private pump: Promise<void> | null = null;
  private ready = false;
  private invalid = false;
  private fatalError: Error | null = null;
  private accepting = false;
  private lastPong = 0;
  private readonly attachments: Attachments;

  constructor(private readonly config: BridgeConfig, private readonly createDriver: () => IKK9Driver, private readonly log: Log, attachments?: Attachments) {
    this.attachments = attachments ?? new Attachments(config);
  }

  async run(): Promise<void> {
    const cleanup = setInterval(() => { void this.attachments.cleanup().catch(() => this.log('warn', '清理过期附件失败')); }, 3600_000);
    cleanup.unref();
    await this.attachments.cleanup();
    try {
      while (!this.abort.signal.aborted) {
        const driver = this.createDriver();
        this.driver = driver;
        this.invalid = false;
        driver.on('error', () => {
          this.log('warn', 'Driver 报告失效错误，正在重建连接');
          this.invalidate();
        });
        driver.on('health', () => this.invalidate());
        driver.on('status', (status) => { if (this.accepting && status === 'disconnected') this.invalidate(); });
        driver.on('message', (message) => this.enqueue(message));
        try {
          await driver.connect();
          await this.verifyIdentity(driver);
          if (this.invalid || this.abort.signal.aborted) continue;
          this.accepting = true;
          this.log('info', 'KK9 身份核对通过，正在连接 AstrBot');
          while (!this.invalid && !this.abort.signal.aborted) {
            try { await this.connectSocket(driver); }
            catch (error) { this.log('warn', error instanceof Error ? error.message : '桥接连接失败'); }
            if (!this.invalid && !this.abort.signal.aborted) await this.pause();
          }
        } catch (error) {
          this.log('warn', error instanceof RequestError ? error.message : 'KK9 连接失败，请检查客户端登录状态和 CDP 配置');
        } finally {
          this.accepting = false;
          this.ready = false;
          this.socket?.terminate();
          this.socket = null;
          // 等正在执行的发送完成后才清理实例；排队但未执行的旧连接请求会跳过。
          await this.requests;
          await this.pump?.catch(() => {});
          await driver.disconnect().catch(() => this.log('warn', '旧 Driver 清理失败'));
          driver.removeAllListeners();
          this.driver = null;
        }
        if (!this.abort.signal.aborted) await this.pause();
      }
    } finally { clearInterval(cleanup); }
    if (this.fatalError) throw this.fatalError;
  }

  stop(): void {
    this.accepting = false;
    this.ready = false;
    this.abort.abort();
    this.socket?.terminate();
  }

  private invalidate(): void {
    this.invalid = true;
    this.accepting = false;
    this.ready = false;
    this.socket?.terminate();
  }

  private async pause(): Promise<void> {
    await delay(this.config.reconnectDelayMs, undefined, { signal: this.abort.signal }).catch(() => {});
  }

  private async verifyIdentity(driver: IKK9Driver): Promise<void> {
    if (await driver.getCurrentUserId() !== this.config.expectedUserId) {
      this.invalidate();
      throw new RequestError('IDENTITY_MISMATCH', 'KK9 实际登录 UID 与 expectedUserId 不一致，已停止该连接的收发');
    }
  }

  private enqueue(message: KK9Message): void {
    if (!this.accepting || message.direction !== 'inbound') return;
    if (!message.sessionId || !(message.messageId || message.id)) {
      this.log('error', '收到缺少会话或消息 ID 的入站事件，无法交给 AstrBot');
      return;
    }
    const id = eventId(message);
    if (this.pending.has(id)) return;
    if (this.pending.size >= this.config.pendingEventLimit) {
      this.fatalError = new Error('未确认入站队列已满，桥接已停止。请恢复服务器连接；当前及停止期间消息需要人工检查，内存队列不保证重启恢复。');
      this.log('error', this.fatalError.message);
      this.stop();
      return;
    }
    this.pending.set(id, { message });
    this.flush();
  }

  private flush(): void {
    if (this.pump || !this.ready || !this.socket || !this.driver) return;
    const socket = this.socket, driver = this.driver;
    this.pump = (async () => {
      for (const [id, item] of this.pending) {
        if (!this.ready || this.socket !== socket || this.invalid || socket.readyState !== WebSocket.OPEN) return;
        if (item.socket === socket) continue;
        await this.verifyIdentity(driver);
        item.prepared ??= await this.attachments.normalize(item.message);
        if (!this.ready || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        const payload = JSON.stringify({ type: 'event', event_id: id, message: item.prepared });
        if (Buffer.byteLength(payload) > 1024 * 1024) {
          this.fatalError = new Error('单条入站事件超过 1 MiB，桥接已停止，请检查消息');
          this.stop();
          return;
        }
        socket.send(payload);
        item.socket = socket;
      }
    })().catch((error) => {
      this.log('warn', error instanceof RequestError ? error.message : '转发入站消息失败，连接恢复后重试');
      socket.terminate();
    }).finally(() => {
      this.pump = null;
      if (this.ready && [...this.pending.values()].some((item) => item.socket !== this.socket)) this.flush();
    });
  }

  private async connectSocket(driver: IKK9Driver): Promise<void> {
    await this.verifyIdentity(driver);
    if (this.abort.signal.aborted || this.invalid) return;
    const url = new URL('/ws', this.config.serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve) => {
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.config.token}` }, maxPayload: 1024 * 1024, handshakeTimeout: 10_000 });
      this.socket = socket;
      let settled = false;
      let readyDeadline: ReturnType<typeof setTimeout> | undefined;
      const heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.lastPong > 45_000) socket.terminate();
        else socket.ping();
      }, 20_000);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(readyDeadline);
        if (this.socket === socket) { this.ready = false; this.socket = null; }
        resolve();
      };
      socket.on('open', () => {
        this.lastPong = Date.now();
        socket.send(JSON.stringify({ type: 'hello', version: 1, self_id: this.config.expectedUserId }));
        readyDeadline = setTimeout(() => socket.terminate(), 10_000);
      });
      socket.on('pong', () => { this.lastPong = Date.now(); });
      socket.on('message', (data, binary) => {
        let value: Record<string, unknown>;
        try {
          if (binary) throw new Error('不支持二进制帧');
          value = JSON.parse(data.toString()) as Record<string, unknown>;
          if (!value || typeof value !== 'object') throw new Error('无效消息');
        } catch { socket.close(1008, 'Invalid JSON'); return; }
        if (value.type === 'ready' && value.version === 1 && !this.ready) {
          clearTimeout(readyDeadline);
          this.ready = true;
          this.log('info', 'AstrBot 桥接已连接，使用完整消息收发');
          this.flush();
        } else if (this.ready && value.type === 'ack' && typeof value.event_id === 'string') {
          this.pending.delete(value.event_id);
        } else if (this.ready && value.type === 'request') {
          // 请求串行执行；ACK、心跳仍由 websocket 回调即时处理。
          this.requests = this.requests.then(async () => {
            if (this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.invalid) return;
            let response: Record<string, unknown>;
            try {
              const request = parseRequest(value);
              const result = await this.execute(request, driver);
              response = { type: 'response', id: request.id, ok: true, result: serializeResult(result) };
            } catch (error) {
              response = { type: 'response', id: value.id, ok: false, error: { code: error instanceof RequestError ? error.code : 'BRIDGE_ERROR', message: error instanceof RequestError ? error.message : '桥接执行失败，请保留 operation_id 查询状态' } };
            }
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
          }).catch(() => this.log('error', '处理桥接请求时发生错误'));
        } else { socket.close(1008, 'Unexpected message'); }
      });
      socket.on('error', () => this.log('warn', 'AstrBot WebSocket 连接失败，请检查地址、token 和端口'));
      socket.on('close', (code) => {
        if (!this.abort.signal.aborted) this.log('warn', `AstrBot 连接断开 (${code})，等待恢复`);
        finish();
      });
    });
  }

  private async execute(request: BridgeRequest, driver: IKK9Driver): Promise<SendResult> {
    await this.verifyIdentity(driver);
    if (request.action === 'get_send_status') return driver.getSendStatus(request.params.operation_id);
    const params = request.params as SendParams;
    const options: SendOptions = { targetSessionId: params.target_session_id, operationId: params.operation_id };
    if (params.reply_to) options.replyTo = params.reply_to;
    if (params.mentions?.length) options.mentions = params.mentions.some((item) => item.uid === 'all') ? 'all' : params.mentions;
    if (params.kind === 'text') return driver.sendText(params.text!, options);
    const file = await this.attachments.download(params.file_id!, params.kind, params.name);
    // 下载期间可能切换账号，发送前再次核对。
    await this.verifyIdentity(driver);
    if (this.invalid) throw new RequestError('DRIVER_DISCONNECTED', 'KK9 连接已失效');
    return params.kind === 'image' ? driver.sendImage(file, options) : driver.sendFile(file, options);
  }
}
