import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { Appointment, AppNotification, CareTask, Pet } from '../core/models';

interface PetCare {
  petId: string;
  petName: string;
  speciesIcon: string;
  due: number;
  completed: number;
  tasks: CareTask[];
}

interface DashboardData {
  date: string;
  care: PetCare[];
  pets: Pet[];
  upcomingVaccinations: any[];
  appointments: Appointment[];
  notifications: AppNotification[];
  unreadNotifications: number;
  notificationPrefs: Record<string, boolean>;
  vetQueue: number;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterLink, MatButtonModule],
  template: `
    <div class="page">
      @if (loading()) {
        <div class="loading-block"><span class="spinner"></span> Loading your care plan…</div>
      } @else if (data(); as d) {
        <div class="greeting">
          <div>
            <span class="eyebrow">{{ todayLabel() }}</span>
            <h1>{{ greeting() }}, {{ firstName() }}.</h1>
            <p>
              @if (auth.isOwner()) {
                Here is what needs attention today. Reminders stay quiet until you turn them on.
              } @else if (auth.isVet()) {
                Your practice overview, shared records and pending requests.
              } @else {
                Platform operations at a glance.
              }
            </p>
          </div>
          @if (auth.isOwner()) {
            <div class="row">
              <a mat-stroked-button routerLink="/onboarding">＋ Add a pet</a>
              <a mat-flat-button color="primary" routerLink="/ai">Ask Pet Vet AI</a>
            </div>
          }
        </div>

        @if (auth.isOwner() && !d.pets.length) {
          <section class="hero">
            <span class="eyebrow">Start here</span>
            <h1>Let's get to know your pet.</h1>
            <p>Add a dog, cat, bird, cow, goat or another animal. You choose the species, and we show only the relevant breed options and honest AI coverage limits.</p>
            <div class="hero-actions">
              <a mat-flat-button color="primary" routerLink="/onboarding">Add your first pet</a>
              <a mat-stroked-button routerLink="/food">Check a food</a>
            </div>
          </section>
        }

        @if (auth.isOwner()) {
          <div class="grid grid-4 mt-2">
            <div class="stat">
              <span class="stat-label">Pets</span>
              <span class="stat-value">{{ d.pets.length }}</span>
              <span class="stat-note">Under your account</span>
            </div>
            <div class="stat">
              <span class="stat-label">Care today</span>
              <span class="stat-value">{{ completedToday() }}/{{ dueToday() }}</span>
              <span class="stat-note">Tasks completed</span>
            </div>
            <div class="stat">
              <span class="stat-label">Upcoming visits</span>
              <span class="stat-value">{{ d.appointments.length }}</span>
              <span class="stat-note">Pending or accepted</span>
            </div>
            <div class="stat">
              <span class="stat-label">Notifications</span>
              <span class="stat-value">{{ d.unreadNotifications }}</span>
              <span class="stat-note">Unread updates</span>
            </div>
          </div>

          @if (d.pets.length) {
            <div class="section-title">
              <h2>Your pets</h2>
              <a routerLink="/find-care" class="small">Find veterinary care →</a>
            </div>
            <div class="pet-strip">
              @for (pet of d.pets; track pet.id) {
                <a class="pet-card" [routerLink]="['/pets', pet.id]">
                  <span class="pet-avatar">
                    @if (pet.photoFileId) {
                      <img [src]="photoUrl(pet.photoFileId)" [alt]="pet.name" />
                    } @else {
                      {{ pet.speciesIcon }}
                    }
                  </span>
                  <span>
                    <strong>{{ pet.name }}</strong>
                    <small>{{ pet.speciesName }} · {{ breedLabel(pet) }}</small>
                    <small>{{ ageLabel(pet) }}</small>
                  </span>
                </a>
              }
            </div>
          }

          <div class="split mt-3">
            <div class="stack">
              <div class="card">
                <div class="card-head">
                  <div>
                    <h3>Today's care</h3>
                    <p>{{ d.date }} · {{ timezone }} · tap a circle to log it</p>
                  </div>
                  <span class="badge badge-teal">{{ completedToday() }}/{{ dueToday() }} done</span>
                </div>

                @if (!d.care.length) {
                  <div class="empty"><span class="empty-icon">📋</span>No care tasks yet. Open a pet to add a feeding, walk or grooming routine.</div>
                }

                @for (care of d.care; track care.petId) {
                  <div class="mb-0" style="margin-bottom:1rem">
                    <div class="row" style="justify-content:space-between">
                      <a [routerLink]="['/pets', care.petId]" class="strong" style="color:var(--ink)">
                        {{ care.speciesIcon }} {{ care.petName }}
                      </a>
                      <span class="tiny muted">{{ care.completed }}/{{ care.due }} completed</span>
                    </div>
                    <div class="progress mt-1" style="margin-bottom:.4rem">
                      <span [style.width.%]="care.due ? (care.completed / care.due) * 100 : 0"></span>
                    </div>
                    <div class="care-list">
                      @for (task of care.tasks; track task.id) {
                        <div class="care-item" [class.done]="task.completed">
                          <button
                            class="care-check"
                            type="button"
                            [class.done]="task.completed"
                            [disabled]="task.completed || logging() === task.id"
                            [attr.aria-label]="'Mark ' + task.title + ' complete'"
                            (click)="completeTask(care.petId, task)"
                          >✓</button>
                          <div>
                            <div class="care-title">{{ task.title }}</div>
                            <div class="care-meta">
                              {{ iconFor(task.type) }} {{ task.type }} · {{ task.times?.join(', ') || 'any time' }}
                              @if (task.completedAt) { · logged {{ timeOnly(task.completedAt) }} }
                            </div>
                          </div>
                        </div>
                      }
                    </div>
                  </div>
                }
              </div>

              <div class="card">
                <div class="card-head">
                  <div>
                    <h3>Vaccination follow-ups</h3>
                    <p>Based on records you or a vet documented. Confirm every schedule with your veterinarian.</p>
                  </div>
                  <a mat-button routerLink="/appointments">Book a visit</a>
                </div>
                @if (!d.upcomingVaccinations.length) {
                  <div class="empty"><span class="empty-icon">💉</span>No upcoming vaccination records in the next 60 days.</div>
                }
                @for (v of d.upcomingVaccinations; track v.id) {
                  <div class="care-item">
                    <div class="timeline-dot">💉</div>
                    <div>
                      <div class="care-title">{{ v.vaccineName }} — {{ v.petName }}</div>
                      <div class="care-meta">
                        Due {{ formatDate(v.nextDueOn) }}
                        <span class="badge" [class.badge-warn]="daysUntil(v.nextDueOn) <= 14" [class.badge-neutral]="daysUntil(v.nextDueOn) > 14">
                          {{ dueLabel(v.nextDueOn) }}
                        </span>
                      </div>
                    </div>
                  </div>
                }
              </div>
            </div>

            <div class="stack">
              <div class="card">
                <div class="card-head"><h3>Quick actions</h3></div>
                <div class="quick-actions">
                  <a class="quick-action" routerLink="/ai"><span>🐾</span><strong>Ask the AI</strong><small>Evidence-linked, cautious</small></a>
                  <a class="quick-action" routerLink="/food"><span>🥗</span><strong>Food safety</strong><small>Can my pet eat this?</small></a>
                  <a class="quick-action" routerLink="/find-care"><span>📍</span><strong>Find care</strong><small>Vets and hospitals</small></a>
                  <a class="quick-action" routerLink="/appointments"><span>📅</span><strong>Appointments</strong><small>Chat, video, in-person</small></a>
                </div>
              </div>

              <div class="card">
                <div class="card-head"><h3>Upcoming appointments</h3></div>
                @if (!d.appointments.length) {
                  <div class="empty" style="padding:1rem"><span class="empty-icon">📅</span>No visits booked.</div>
                }
                @for (appt of d.appointments; track appt.id) {
                  <div class="care-item">
                    <div class="timeline-dot">📅</div>
                    <div>
                      <div class="care-title">{{ appt.petName }} with {{ appt.vetName }}</div>
                      <div class="care-meta">{{ formatDateTime(appt.scheduledFor) }} · {{ appt.mode === 'video' ? 'Video' : 'In person' }}</div>
                      <span class="badge" [class.badge-warn]="appt.status === 'pending'" [class.badge-teal]="appt.status === 'accepted'">{{ appt.status }}</span>
                    </div>
                  </div>
                }
                <a mat-button routerLink="/appointments" class="mt-1">View all appointments</a>
              </div>

              <div class="card">
                <div class="card-head">
                  <h3>Reminder preferences</h3>
                  <a routerLink="/settings" class="small">Edit</a>
                </div>
                <div class="stack" style="gap:.4rem">
                  <div class="cap-row"><span>Feeding reminders</span><span class="badge" [class.badge-ok]="d.notificationPrefs?.['feeding']" [class.badge-neutral]="!d.notificationPrefs?.['feeding']">{{ d.notificationPrefs?.['feeding'] ? 'On' : 'Off' }}</span></div>
                  <div class="cap-row"><span>Grooming reminders</span><span class="badge" [class.badge-ok]="d.notificationPrefs?.['grooming']" [class.badge-neutral]="!d.notificationPrefs?.['grooming']">{{ d.notificationPrefs?.['grooming'] ? 'On' : 'Off' }}</span></div>
                  <div class="cap-row"><span>Vaccination reminders</span><span class="badge" [class.badge-ok]="d.notificationPrefs?.['vaccination']" [class.badge-neutral]="!d.notificationPrefs?.['vaccination']">{{ d.notificationPrefs?.['vaccination'] ? 'On' : 'Off' }}</span></div>
                </div>
                @if (!d.notificationPrefs?.['feeding'] && !d.notificationPrefs?.['grooming'] && !d.notificationPrefs?.['vaccination']) {
                  <p class="tiny muted mt-1 mb-0">Everything is off by default. Turn on only the reminders you want.</p>
                }
              </div>
            </div>
          </div>

          <div class="section-title"><h2>Recent updates</h2></div>
          <div class="card">
            @if (!d.notifications.length) {
              <div class="empty"><span class="empty-icon">🔔</span>No updates yet.</div>
            }
            @for (n of d.notifications; track n.id) {
              <div class="care-item">
                <div class="timeline-dot">{{ n.kind === 'appointment' ? '📅' : n.kind === 'message' ? '💬' : '🔔' }}</div>
                <div style="flex:1">
                  <div class="row" style="justify-content:space-between">
                    <div class="care-title">{{ n.title }}</div>
                    <span class="tiny muted">{{ timeAgo(n.createdAt) }}</span>
                  </div>
                  <div class="care-meta">{{ n.body }}</div>
                </div>
              </div>
            }
          </div>
        }

        @if (auth.isVet()) {
          <div class="grid grid-3 mt-2">
            <div class="stat"><span class="stat-label">Awaiting your response</span><span class="stat-value">{{ d.vetQueue }}</span><span class="stat-note">Appointment requests</span></div>
            <div class="stat"><span class="stat-label">Shared pets</span><span class="stat-value">{{ d.pets.length }}</span><span class="stat-note">Accepted consultations</span></div>
            <div class="stat"><span class="stat-label">Upcoming</span><span class="stat-value">{{ d.appointments.length }}</span><span class="stat-note">Pending and accepted</span></div>
          </div>
          <div class="split mt-2">
            <div class="card">
              <div class="card-head"><div><h3>Request queue</h3><p>Accept only what you can attend. Owners are notified of every decision.</p></div><a mat-flat-button color="primary" routerLink="/appointments">Open appointments</a></div>
              @if (!d.appointments.length) { <div class="empty"><span class="empty-icon">✅</span>No open requests.</div> }
              @for (appt of d.appointments; track appt.id) {
                <div class="care-item">
                  <div class="timeline-dot">🩺</div>
                  <div style="flex:1">
                    <div class="row" style="justify-content:space-between">
                      <div class="care-title">{{ appt.petName }} — {{ appt.ownerName }}</div>
                      <span class="badge" [class.badge-warn]="appt.status === 'pending'" [class.badge-teal]="appt.status === 'accepted'">{{ appt.status }}</span>
                    </div>
                    <div class="care-meta">{{ formatDateTime(appt.scheduledFor) }} · {{ appt.mode }} · {{ appt.reason }}</div>
                  </div>
                </div>
              }
            </div>
            <div class="stack">
              <div class="card">
                <h3>Practice profile</h3>
                <p class="small muted">Keep credentials, species and availability current. Verification status is controlled by administrators.</p>
                <a mat-stroked-button routerLink="/vet">Manage practice</a>
              </div>
              <div class="card">
                <h3>Messages</h3>
                <p class="small muted">Owner conversations open automatically after you accept an appointment.</p>
                <a mat-stroked-button routerLink="/messages">Open messages</a>
              </div>
            </div>
          </div>
        }

        @if (auth.isAdmin()) {
          <div class="grid grid-3 mt-2">
            <div class="stat"><span class="stat-label">Veterinarian review</span><span class="stat-value">{{ d.vetQueue }}</span><span class="stat-note">Pending verification</span></div>
            <div class="stat"><span class="stat-label">Pets on platform</span><span class="stat-value">{{ d.pets.length }}</span><span class="stat-note">All owners</span></div>
            <div class="stat"><span class="stat-label">Appointments</span><span class="stat-value">{{ d.appointments.length }}</span><span class="stat-note">Open</span></div>
          </div>
          <div class="card mt-2">
            <div class="card-head"><div><h3>Administration</h3><p>Verify clinicians, review knowledge documents, configure AI capability levels and inspect the audit trail.</p></div><a mat-flat-button color="primary" routerLink="/admin">Open admin console</a></div>
            @if (d.vetQueue > 0) {
              <div class="banner banner-warn"><span class="banner-icon">🛡️</span><div><strong>{{ d.vetQueue }} veterinarian(s) awaiting review</strong><p>Unverified profiles are hidden from the directory and cannot take bookings.</p></div></div>
            }
          </div>
        }
      }
    </div>
  `,
})
export class DashboardComponent implements OnInit {
  readonly auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);

  readonly data = signal<DashboardData | null>(null);
  readonly loading = signal(true);
  readonly logging = signal<string | null>(null);
  readonly timezone = 'Asia/Kolkata';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.get<DashboardData>('/dashboard').subscribe({
      next: (res) => {
        this.data.set(res);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(err);
      },
    });
  }

  firstName(): string {
    return this.auth.user()?.fullName?.split(' ')[0] ?? 'there';
  }

  greeting(): string {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: this.timezone }).format(new Date()),
    );
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  todayLabel(): string {
    return new Intl.DateTimeFormat('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: this.timezone,
    }).format(new Date());
  }

  dueToday(): number {
    return (this.data()?.care ?? []).reduce((sum, c) => sum + c.due, 0);
  }

  completedToday(): number {
    return (this.data()?.care ?? []).reduce((sum, c) => sum + c.completed, 0);
  }

  breedLabel(pet: Pet): string {
    return pet.breedName || pet.customBreed || 'Breed not specified';
  }

  ageLabel(pet: Pet): string {
    if (pet.birthDate) {
      const months = Math.max(0, Math.floor((Date.now() - new Date(pet.birthDate).getTime()) / (30.44 * 86400000)));
      return this.monthsLabel(months);
    }
    if (pet.ageEstimateMonths != null) return `~${this.monthsLabel(pet.ageEstimateMonths)}`;
    return 'Age unknown';
  }

  monthsLabel(months: number): string {
    if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
    const years = Math.floor(months / 12);
    return `${years} year${years === 1 ? '' : 's'}`;
  }

  iconFor(type: string): string {
    const map: Record<string, string> = {
      feeding: '🍲', water: '💧', walk: '🐕', grooming: '🪮', medication: '💊',
      vaccination: '💉', observation: '👀', other: '📌',
    };
    return map[type] ?? '📌';
  }

  completeTask(petId: string, task: CareTask): void {
    if (task.completed) return;
    this.logging.set(task.id);
    this.api.post(`/pets/${petId}/care/logs`, {
      type: task.type,
      taskId: task.id,
      notes: 'Logged from the dashboard checklist',
    }).subscribe({
      next: () => {
        this.logging.set(null);
        this.toast.success(`${task.title} logged`);
        this.load();
      },
      error: (err) => {
        this.logging.set(null);
        this.toast.error(err);
      },
    });
  }

  photoUrl(fileId: string): string {
    return `${this.api.fileUrl(fileId)}?token=${encodeURIComponent(this.auth.token() ?? '')}`;
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return 'date not recorded';
    return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: this.timezone }).format(new Date(value));
  }

  formatDateTime(value: string): string {
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: this.timezone,
    }).format(new Date(value));
  }

  timeOnly(value: string): string {
    return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: this.timezone }).format(new Date(value));
  }

  timeAgo(value: string): string {
    const diff = Date.now() - new Date(value).getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  daysUntil(value: string): number {
    // The API returns full ISO timestamps, but accept date-only strings too.
    const iso = /T/.test(value) ? value : `${value}T00:00:00`;
    const target = new Date(iso).getTime();
    if (Number.isNaN(target)) return Number.MAX_SAFE_INTEGER;
    return Math.ceil((target - Date.now()) / 86400000);
  }

  dueLabel(value: string): string {
    const days = this.daysUntil(value);
    if (days < 0) return `${Math.abs(days)}d overdue`;
    if (days === 0) return 'due today';
    return `in ${days}d`;
  }
}
