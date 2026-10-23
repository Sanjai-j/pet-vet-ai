import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../core/api.service';
import { ToastService } from '../core/toast.service';
import { AiReply, Capability, CitationView, Pet, WebSearchResponse, WebSearchResult } from './ai-types';

@Component({
  selector: 'app-ai-chat',
  standalone: true,
  imports: [FormsModule, RouterLink, MatFormFieldModule, MatSelectModule, MatButtonModule],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">Pet Vet AI</span>
          <h1>Ask about your pet</h1>
          <p>General information from approved references, with emergency checks first. This is not a diagnosis.</p>
        </div>
        <div class="row">
          <span class="badge" [class.badge-warn]="status()?.mode !== 'llm'" [class.badge-ok]="status()?.mode === 'llm'">
            {{ status()?.mode === 'llm' ? 'Language model configured' : 'Deterministic demo composer' }}
          </span>
          <a mat-stroked-button routerLink="/find-care">Find a vet</a>
        </div>
      </div>

      @if (!pets().length) {
        <div class="card empty">
          <span class="empty-icon">🐾</span>
          <h3>Add a pet first</h3>
          <p class="muted">The assistant is species-aware, so it needs to know which animal you're asking about.</p>
          <a mat-flat-button color="primary" routerLink="/onboarding">Add a pet</a>
        </div>
      } @else {
        <div class="ai-layout">
          <section class="card ai-panel">
            <div class="ai-panel-head">
              <mat-form-field appearance="outline" style="max-width:280px">
                <mat-label>Which pet?</mat-label>
                <mat-select [ngModel]="selectedPetId()" (ngModelChange)="selectPet($event)">
                  @for (pet of pets(); track pet.id) {
                    <mat-option [value]="pet.id">{{ pet.speciesIcon }} {{ pet.name }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <span class="badge" [class.badge-teal]="speciesCapability() === 'limited'" [class.badge-warn]="speciesCapability() === 'not_supported'">
                {{ speciesCapabilityLabel() }}
              </span>
              <span class="spacer"></span>
              <button class="btn btn-ghost btn-sm" type="button" (click)="newConversation()">＋ New chat</button>
            </div>

            <div class="ai-messages" #messagesEl>
              @if (!messages().length) {
                <div class="bubble bubble-ai">
                  <strong>Hello — I'm Pet Vet AI.</strong>
                  <p style="margin:.4rem 0 0">Tell me what you're noticing about {{ selectedPet()?.name || 'your pet' }}. I check emergency red flags first, then look for approved reference material.</p>
                  <p style="margin:.5rem 0 0;font-size:.8rem">I cannot diagnose, prescribe or give doses. If something is urgent, contact a veterinarian now.</p>
                </div>
              }
              @for (message of messages(); track message.id) {
                @if (message.role === 'user') {
                  <div class="bubble bubble-user">{{ message.content }}</div>
                } @else {
                  <div class="bubble bubble-ai" [class.bubble-emergency]="message.emergency">
                    <div style="white-space:pre-wrap">{{ message.content }}</div>
                    @if (message.citations?.length) {
                      <div class="citations">
                        @for (cite of message.citations; track cite.documentId) {
                          <div class="citation">
                            <b>{{ cite.title }}</b>
                            <span class="badge" [class.badge-demo]="cite.isDemo" style="margin-left:.3rem">{{ cite.isDemo ? 'Demo corpus' : 'Reference' }}</span>
                            <p>{{ cite.snippet }}</p>
                            <span class="tiny muted">{{ cite.sourceOrg }}</span>
                            @if (cite.sourceUrl) { <a [href]="cite.sourceUrl" target="_blank" rel="noopener">Open source ↗</a> }
                          </div>
                        }
                      </div>
                    }
                    <div class="bubble-meta">
                      @if (message.mode) { {{ message.mode === 'llm' ? 'Language model answer' : message.mode === 'blocked' ? 'AI disabled by administrator' : 'Deterministic composer' }} · }
                      {{ message.capabilityStatus || 'limited' }} support · {{ timeOnly(message.createdAt) }}
                    </div>
                  </div>
                }
              }
              @if (sending()) {
                <div class="bubble bubble-ai row"><span class="spinner"></span> Checking red flags and approved references…</div>
              }
            </div>

            @if (!messages().length) {
              <div class="suggestions">
                @for (suggestion of suggestions(); track suggestion) {
                  <button class="suggestion" type="button" (click)="quickAsk(suggestion)">{{ suggestion }}</button>
                }
              </div>
            }

            <div class="ai-composer">
              <textarea
                [(ngModel)]="draft"
                (keydown.enter)="onEnter($event)"
                placeholder="Describe what you're seeing. Include when it started and anything eaten…"
                aria-label="Message Pet Vet AI"
              ></textarea>
              <button class="btn btn-primary" type="button" [disabled]="sending() || !draft.trim()" (click)="send()">
                {{ sending() ? '…' : 'Send' }}
              </button>
            </div>
          </section>

          <aside class="stack">
            <div class="card">
              <div class="card-head"><h3>Known limits</h3><span class="badge badge-neutral">{{ selectedPet()?.speciesName }}</span></div>
              @for (cap of capabilities(); track cap.id) {
                <div class="cap-row">
                  <span>{{ labelTask(cap.task) }}</span>
                  <span class="badge"
                    [class.badge-ok]="cap.status === 'validated'"
                    [class.badge-warn]="cap.status === 'limited'"
                    [class.badge-danger]="cap.status === 'not_supported'">
                    {{ cap.status === 'not_supported' ? 'Not supported' : cap.status }}
                  </span>
                </div>
              }
              @if (!capabilities().length) {
                <p class="small muted">No capability entries for this species.</p>
              }
              <p class="tiny muted mt-1 mb-0">
                Status reflects documented evidence, not model confidence. No clinical validation study has been completed.
              </p>
            </div>

            <div class="card">
              <div class="card-head"><h3>Conversations</h3><span class="tiny muted">{{ conversations().length }}</span></div>
              @if (!conversations().length) {
                <p class="small muted">No saved conversations for this pet yet.</p>
              }
              <div class="convo-list">
                @for (convo of conversations(); track convo.id) {
                  <button class="convo-item" [class.active]="conversationId() === convo.id" type="button" (click)="openConversation(convo.id)">
                    <span class="strong">{{ convo.title }}</span>
                    <span class="tiny muted" style="display:block">{{ convo.messageCount }} messages</span>
                  </button>
                }
              </div>
            </div>

            <div class="card">
              <div class="card-head">
                <div>
                  <h3>Live web search</h3>
                  <p>Exa results alongside your question.</p>
                </div>
                <span class="badge badge-neutral">Web</span>
              </div>

              @if (webSearchConfigured() === false) {
                <div class="banner banner-info">
                  <span class="banner-icon">🔌</span>
                  <div>
                    <strong>Not configured</strong>
                    <p>Live web search is not enabled on the server yet. Everything else keeps working without it.</p>
                  </div>
                </div>
              } @else {
                <div class="row" style="flex-wrap:nowrap">
                  <input
                    class="input"
                    style="flex:1;min-width:0"
                    [(ngModel)]="webDraft"
                    (keydown.enter)="searchWeb()"
                    placeholder="Search the web…"
                    aria-label="Search the web"
                    [disabled]="webSearching()"
                  />
                  <button
                    class="btn btn-secondary btn-sm"
                    type="button"
                    [disabled]="webSearching() || !webDraft.trim()"
                    (click)="searchWeb()"
                  >
                    {{ webSearching() ? 'Searching…' : 'Search' }}
                  </button>
                </div>

                @if (webSearching()) {
                  <p class="small muted mt-2 mb-0"><span class="spinner"></span> Searching the web…</p>
                } @else if (webError()) {
                  <div class="banner banner-warn mt-2">
                    <span class="banner-icon">⚠️</span>
                    <div>
                      <strong>Web search failed</strong>
                      <p>{{ webError() }}</p>
                    </div>
                  </div>
                } @else if (webResults().length) {
                  <div class="citations">
                    @for (result of webResults(); track result.url) {
                      <div class="citation">
                        <b>{{ result.title || hostOf(result.url) }}</b>
                        <span class="tiny muted">
                          {{ hostOf(result.url) }}{{ result.publishedDate ? ' · ' + publishedOn(result.publishedDate) : '' }}
                        </span>
                        @if (result.highlights.length) { <p>{{ result.highlights[0] }}</p> }
                        <a [href]="result.url" target="_blank" rel="noopener noreferrer">Open source ↗</a>
                      </div>
                    }
                  </div>
                  <p class="tiny muted mt-1 mb-0">{{ webNotice() }}</p>
                } @else if (webSearched()) {
                  <p class="small muted mt-2 mb-0">No web results for “{{ webSearched() }}”. Try different words.</p>
                } @else {
                  <p class="tiny muted mt-2 mb-0">
                    Web pages are supplementary reading, not approved references. Always confirm with a veterinarian.
                  </p>
                }
              }
            </div>

            <div class="banner banner-warn">
              <span class="banner-icon">⚠️</span>
              <div>
                <strong>Emergencies bypass the AI</strong>
                <p>Red flags such as breathing difficulty, collapse, suspected poisoning or inability to urinate trigger an immediate referral before any general answer.</p>
              </div>
            </div>

            <div class="banner banner-info">
              <span class="banner-icon">📚</span>
              <div>
                <strong>Sources are labelled</strong>
                <p>Only administrator-approved documents are retrieved. The seeded corpus is a synthetic demo and is marked as such.</p>
              </div>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
})
export class AiChatComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private messagesEl = viewChild<ElementRef<HTMLElement>>('messagesEl');

  readonly pets = signal<Pet[]>([]);
  readonly selectedPetId = signal('');
  readonly selectedPet = computed(() => this.pets().find((p) => p.id === this.selectedPetId()) ?? null);
  readonly capabilities = signal<Capability[]>([]);
  readonly conversations = signal<any[]>([]);
  readonly messages = signal<any[]>([]);
  readonly status = signal<any>(null);
  readonly conversationId = signal<string | null>(null);
  readonly sending = signal(false);
  readonly webResults = signal<WebSearchResult[]>([]);
  readonly webSearching = signal(false);
  readonly webError = signal('');
  readonly webSearched = signal('');
  readonly webNotice = signal('');
  draft = '';
  webDraft = '';

  /** null until /ai/status answers, so we never claim "not configured" early. */
  readonly webSearchConfigured = computed<boolean | null>(() => {
    const webSearch = this.status()?.webSearch as { configured?: boolean } | undefined;
    return typeof webSearch?.configured === 'boolean' ? webSearch.configured : null;
  });

  readonly speciesCapability = computed(() => {
    const species = this.selectedPet()?.speciesCode;
    const symptom = this.capabilities().find((c) => c.task === 'symptom_check');
    if (!species) return 'not_supported';
    return symptom?.status ?? (species === 'dog' || species === 'cat' ? 'limited' : 'not_supported');
  });

  ngOnInit(): void {
    this.api.get<any>('/ai/status').subscribe({ next: (res) => this.status.set(res) });
    this.api.get<{ pets: Pet[] }>('/pets').subscribe({
      next: (res) => {
        this.pets.set(res.pets);
        if (res.pets.length) this.selectPet(res.pets[0].id);
      },
      error: (err) => this.toast.error(err),
    });
  }

  speciesCapabilityLabel(): string {
    return this.speciesCapability() === 'limited'
      ? 'Limited support for this species'
      : 'Not supported for clinical questions';
  }

  suggestions(): string[] {
    const pet = this.selectedPet();
    if (!pet) return [];
    if (pet.speciesCode === 'dog' || pet.speciesCode === 'cat') {
      return [
        `${pet.name} has been scratching more than usual`,
        'How should I transition to a new food?',
        'What signs mean I should go to a vet today?',
      ];
    }
    if (pet.speciesCode === 'bird') {
      return ['What daily husbandry checks matter?', `${pet.name} is quieter than usual`, 'What should I watch for in droppings?'];
    }
    return ['What daily checks should I do?', 'What are emergency signs?', 'How do I record a weight change?'];
  }

  labelTask(task: string): string {
    const map: Record<string, string> = {
      symptom_check: 'Symptom review', emergency_triage: 'Emergency triage',
      food_safety: 'Food safety', general_care: 'General care',
      image_analysis: 'Image analysis', medication_guidance: 'Medication guidance',
    };
    return map[task] ?? task;
  }

  selectPet(petId: string): void {
    this.selectedPetId.set(petId);
    this.messages.set([]);
    this.conversationId.set(null);
    this.conversations.set([]);
    const pet = this.pets().find((p) => p.id === petId);
    if (!pet) return;
    this.api.get<{ capabilities: Capability[] }>('/capabilities', { species: pet.speciesCode }).subscribe({
      next: (res) => this.capabilities.set(res.capabilities),
    });
    this.api.get<any>('/ai/conversations', { petId }).subscribe({
      next: (res) => this.conversations.set(res.conversations ?? []),
    });
  }

  newConversation(): void {
    this.conversationId.set(null);
    this.messages.set([]);
  }

  openConversation(id: string): void {
    this.api.get<any>(`/ai/conversations/${id}`).subscribe({
      next: (res) => {
        this.conversationId.set(id);
        this.messages.set(
          res.messages.map((m: any) => ({
            ...m,
            citations: Array.isArray(m.citations) ? m.citations : [],
            mode: m.isDemo ? 'deterministic' : 'llm',
          })),
        );
        this.scrollSoon();
      },
      error: (err) => this.toast.error(err),
    });
  }

  quickAsk(text: string): void {
    this.draft = text;
    this.send();
  }

  onEnter(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (keyboard.shiftKey) return;
    keyboard.preventDefault();
    this.send();
  }

  send(): void {
    const pet = this.selectedPet();
    const text = this.draft.trim();
    if (!pet || !text || this.sending()) return;
    this.sending.set(true);
    const userMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: text,
      citations: [],
      createdAt: new Date().toISOString(),
    };
    this.messages.update((list) => [...list, userMessage]);
    this.draft = '';
    this.scrollSoon();

    this.api.post<any>('/ai/chat', {
      petId: pet.id,
      message: text,
      conversationId: this.conversationId() ?? undefined,
    }).subscribe({
      next: (res) => {
        const reply: AiReply = res.reply;
        this.conversationId.set(res.conversationId);
        this.messages.update((list) => [
          ...list,
          {
            id: reply.id ?? `ai-${Date.now()}`,
            role: 'assistant',
            content: reply.answer,
            citations: reply.citations,
            emergency: Boolean(reply.emergency),
            capabilityStatus: reply.capability.status,
            mode: reply.mode,
            createdAt: reply.createdAt ?? new Date().toISOString(),
          },
        ]);
        this.sending.set(false);
        this.scrollSoon();
        this.api.get<any>('/ai/conversations', { petId: pet.id }).subscribe({
          next: (r) => this.conversations.set(r.conversations ?? []),
        });
      },
      error: (err) => {
        this.sending.set(false);
        this.toast.error(err);
        this.messages.update((list) => list.filter((m) => m.id !== userMessage.id));
        this.draft = text;
      },
    });
  }

  searchWeb(): void {
    const query = this.webDraft.trim();
    if (query.length < 3 || this.webSearching()) return;
    this.webSearching.set(true);
    this.webError.set('');
    this.webResults.set([]);
    this.webSearched.set('');
    this.api.get<WebSearchResponse>('/ai/web-search', { q: query }).subscribe({
      next: (res) => {
        this.webResults.set(res.results ?? []);
        this.webNotice.set(res.notice ?? '');
        this.webSearched.set(query);
        this.webSearching.set(false);
      },
      error: (err) => {
        this.webSearching.set(false);
        this.webError.set(ApiService.message(err));
      },
    });
  }

  hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  publishedOn(value: string): string {
    try {
      return new Intl.DateTimeFormat('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
      }).format(new Date(value));
    } catch {
      return '';
    }
  }

  scrollSoon(): void {
    setTimeout(() => {
      const el = this.messagesEl()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 60);
  }

  timeOnly(value: string): string {
    try {
      return new Intl.DateTimeFormat('en-IN', {
        hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
      }).format(new Date(value));
    } catch {
      return '';
    }
  }
}
