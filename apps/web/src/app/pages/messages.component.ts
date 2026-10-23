import { Component, ElementRef, OnInit, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { WsService } from '../core/ws.service';
import { ChatMessage, Thread } from '../core/models';

@Component({
  selector: 'app-messages',
  standalone: true,
  imports: [FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">Messages</span>
          <h1>Talk to your veterinarian</h1>
          <p>Conversations open after an appointment is accepted. Messages and attachments are private to the participants.</p>
        </div>
        <span class="badge" [class.badge-ok]="ws.connected()" [class.badge-warn]="!ws.connected()">
          {{ ws.connected() ? 'Live connection' : 'Reconnecting…' }}
        </span>
      </div>

      @if (loading()) {
        <div class="loading-block"><span class="spinner"></span> Loading conversations…</div>
      } @else if (!threads().length) {
        <div class="card empty">
          <span class="empty-icon">💬</span>
          <h3>No conversations yet</h3>
          <p class="muted">Book an appointment with a verified veterinarian. Once accepted, a private thread opens here.</p>
          <a mat-stroked-button routerLink="/find-care">Find a veterinarian</a>
        </div>
      } @else {
        <div class="messaging">
          <aside class="card flush thread-list">
            @for (thread of threads(); track thread.id) {
              <button class="thread-item" type="button" [class.active]="active()?.id === thread.id" (click)="open(thread)">
                <strong>
                  <span>{{ auth.isVet() ? thread.ownerName : thread.vetName }} · {{ thread.petName }}</span>
                  @if (thread.unread > 0) { <span class="badge badge-danger">{{ thread.unread }}</span> }
                </strong>
                <small>{{ thread.lastMessage || 'No messages yet' }}</small>
                <small class="tiny">{{ thread.clinicName || 'Direct message' }}</small>
              </button>
            }
          </aside>

          <section class="card chat-panel">
            @if (active(); as thread) {
              <div class="chat-head">
                <div>
                  <strong>{{ thread.petName }} — {{ auth.isVet() ? thread.ownerName : thread.vetName }}</strong>
                  <div class="tiny muted">{{ thread.clinicName || 'Verified veterinarian' }} · demo thread</div>
                </div>
                <span class="spacer"></span>
                @if (thread.appointmentId) {
                  <a mat-stroked-button [routerLink]="['/video', thread.appointmentId]">Video room</a>
                }
                <a mat-button routerLink="/appointments">Appointments</a>
              </div>

              <div class="chat-body" #chatBody>
                @if (!messages().length) {
                  <div class="empty"><span class="empty-icon">👋</span>Start the conversation. Do not send X-rays or records unless your veterinarian asks.</div>
                }
                @for (message of messages(); track message.id) {
                  <div class="chat-bubble" [class.chat-mine]="message.senderId === auth.user()?.id" [class.chat-theirs]="message.senderId !== auth.user()?.id">
                    <div>{{ message.body }}</div>
                    @if (message.fileId) {
                      <a class="chat-file" [href]="fileUrl(message.fileId)" target="_blank" rel="noopener">📎 {{ message.fileName || 'Attachment' }}</a>
                    }
                    <div class="chat-time">{{ message.senderName }} · {{ timeOnly(message.createdAt) }}</div>
                  </div>
                }
                @if (typingBy().length) {
                  <div class="tiny muted">typing…</div>
                }
              </div>

              <div class="chat-input">
                <button class="icon-btn" type="button" (click)="fileInput.click()" aria-label="Attach a file" title="Attach a file">📎</button>
                <input #fileInput type="file" hidden accept="image/*,application/pdf,video/mp4,video/webm" (change)="attach($event)" />
                <textarea
                  [(ngModel)]="draft"
                  (input)="notifyTyping()"
                  (keydown.enter)="onEnter($event)"
                  placeholder="Write a message…"
                  aria-label="Message"
                ></textarea>
                <button class="btn btn-primary" type="button" [disabled]="!draft.trim() || uploading()" (click)="send()">
                  {{ uploading() ? 'Uploading…' : 'Send' }}
                </button>
              </div>
              @if (attachment()) {
                <div class="row" style="padding:0 .8rem .6rem">
                  <span class="badge badge-teal">📎 {{ attachment()!.fileName }} attached</span>
                  <button class="btn btn-ghost btn-sm" type="button" (click)="attachment.set(null)">Remove</button>
                </div>
              }
            } @else {
              <div class="empty" style="margin:auto"><span class="empty-icon">💬</span>Select a conversation.</div>
            }
          </section>
        </div>
      }
    </div>
  `,
})
export class MessagesComponent implements OnInit {
  readonly auth = inject(AuthService);
  readonly ws = inject(WsService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private chatBody = viewChild<ElementRef<HTMLElement>>('chatBody');

  readonly threads = signal<Thread[]>([]);
  readonly active = signal<Thread | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly loading = signal(true);
  readonly uploading = signal(false);
  readonly attachment = signal<{ id: string; fileName: string } | null>(null);
  readonly typingBy = signal<string[]>([]);
  draft = '';
  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.loadThreads();
    this.ws.messages$.subscribe((message) => {
      if (message.threadId !== this.active()?.id) {
        this.loadThreads();
        return;
      }
      if (!this.messages().some((m) => m.id === message.id)) {
        this.messages.update((list) => [...list, message]);
        this.scrollSoon();
      }
      this.ws.send({ type: 'read', threadId: message.threadId });
      this.loadThreads();
    });
    this.ws.typing$.subscribe((event) => {
      if (event.threadId !== this.active()?.id) return;
      this.typingBy.set([event.userId]);
      setTimeout(() => this.typingBy.set([]), 2500);
    });
  }

  loadThreads(): void {
    this.api.get<{ threads: Thread[] }>('/threads').subscribe({
      next: (res) => {
        this.threads.set(res.threads ?? []);
        this.loading.set(false);
        const queryThread = this.route.snapshot.queryParamMap.get('thread');
        const target =
          this.threads().find((t) => t.id === (this.active()?.id ?? queryThread)) ??
          this.threads()[0];
        if (target && !this.active()) this.open(target);
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(err);
      },
    });
  }

  open(thread: Thread): void {
    this.active.set(thread);
    this.messages.set([]);
    this.attachment.set(null);
    this.api.get<{ messages: ChatMessage[] }>(`/threads/${thread.id}`).subscribe({
      next: (res) => {
        this.messages.set(res.messages ?? []);
        this.ws.send({ type: 'read', threadId: thread.id });
        this.scrollSoon();
      },
      error: (err) => this.toast.error(err),
    });
  }

  onEnter(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (keyboard.shiftKey) return;
    keyboard.preventDefault();
    this.send();
  }

  send(): void {
    const thread = this.active();
    const text = this.draft.trim();
    const file = this.attachment();
    if (!thread || (!text && !file)) return;
    const payload = { type: 'chat', threadId: thread.id, body: text, fileId: file?.id };
    const sent = this.ws.send(payload);
    if (!sent) {
      this.api.post(`/threads/${thread.id}/messages`, { body: text, fileId: file?.id }).subscribe({
        next: () => {
          this.draft = '';
          this.attachment.set(null);
          this.open(thread);
        },
        error: (err) => this.toast.error(err),
      });
      return;
    }
    this.draft = '';
    this.attachment.set(null);
  }

  attach(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || !this.active()) return;
    const form = new FormData();
    form.append('file', file);
    form.append('purpose', 'chat');
    this.uploading.set(true);
    this.api.upload('/files', form).subscribe({
      next: (res) => {
        this.uploading.set(false);
        this.attachment.set({ id: res.file.id, fileName: res.file.originalName });
      },
      error: (err) => {
        this.uploading.set(false);
        this.toast.error(err);
      },
    });
  }

  notifyTyping(): void {
    const thread = this.active();
    if (!thread || this.typingTimer) return;
    this.ws.send({ type: 'typing', threadId: thread.id });
    this.typingTimer = setTimeout(() => (this.typingTimer = null), 1200);
  }

  fileUrl(fileId: string): string {
    return `${this.api.fileUrl(fileId)}?token=${encodeURIComponent(this.auth.token() ?? '')}`;
  }

  timeOnly(value: string): string {
    return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(value));
  }

  scrollSoon(): void {
    setTimeout(() => {
      const el = this.chatBody()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 60);
  }
}
