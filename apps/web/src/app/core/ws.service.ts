import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class WsService {
  private socket: WebSocket | null = null;
  private token: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private manualClose = false;

  readonly connected = signal(false);
  readonly messages$ = new Subject<any>();
  readonly notifications$ = new Subject<any>();
  readonly typing$ = new Subject<any>();
  readonly webrtc$ = new Subject<any>();
  readonly errors$ = new Subject<string>();

  connect(): void {
    const token = localStorage.getItem('petvet_token');
    if (!token) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      if (this.token === token) return;
    }
    this.token = token;
    this.manualClose = false;
    this.open();
  }

  private open(): void {
    if (!this.token) return;
    try {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // `/socket` rather than `/ws`: when the app is served by Cloudflare Pages,
      // the platform does not route `/ws` to a Function (the request is answered
      // with the SPA HTML, which breaks the handshake), while the API accepts
      // both paths so a single-service deployment still works unchanged.
      this.socket = new WebSocket(`${protocol}//${location.host}/socket?token=${encodeURIComponent(this.token)}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket.onopen = () => {
      this.attempts = 0;
      this.connected.set(true);
    };
    this.socket.onmessage = (event) => {
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (payload.type) {
        case 'message':
          this.messages$.next(payload.message);
          break;
        case 'notification':
          this.notifications$.next(payload.notification);
          break;
        case 'typing':
          this.typing$.next(payload);
          break;
        case 'webrtc':
          this.webrtc$.next(payload);
          break;
        case 'error':
          this.errors$.next(payload.message);
          break;
      }
    };
    this.socket.onclose = () => {
      this.connected.set(false);
      this.socket = null;
      if (!this.manualClose) this.scheduleReconnect();
    };
    this.socket.onerror = () => {
      this.connected.set(false);
    };
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** this.attempts);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  send(payload: Record<string, unknown>): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  disconnect(): void {
    this.manualClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.connected.set(false);
  }
}
