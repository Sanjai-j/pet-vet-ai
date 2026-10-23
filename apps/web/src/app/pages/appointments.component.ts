import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { Appointment, ConsultationNote } from '../core/models';

@Component({
  selector: 'app-appointments',
  standalone: true,
  imports: [RouterLink, ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">Appointments</span>
          <h1>{{ auth.isVet() ? 'Consultation requests' : 'Your veterinary visits' }}</h1>
          <p>
            {{ auth.isVet()
              ? 'Accept requests you can attend, then add notes and a care plan after the consultation.'
              : 'Every request is pending until the veterinarian accepts. Video calls use real WebRTC signalling.' }}
          </p>
        </div>
        <a mat-flat-button color="primary" routerLink="/find-care">Find care</a>
      </div>

      <div class="pill-tabs" style="margin-bottom:1rem">
        @for (tab of tabs; track tab.value) {
          <button type="button" [class.active]="filter() === tab.value" (click)="filter.set(tab.value)">{{ tab.label }}</button>
        }
      </div>

      @if (loading()) {
        <div class="loading-block"><span class="spinner"></span> Loading appointments…</div>
      } @else if (!filtered().length) {
        <div class="card empty">
          <span class="empty-icon">📅</span>
          <h3>No appointments here</h3>
          <p class="muted">{{ auth.isVet() ? 'New owner requests will appear here.' : 'Book a visit with a verified veterinarian to get started.' }}</p>
          <a mat-stroked-button routerLink="/find-care">Browse veterinary care</a>
        </div>
      } @else {
        <div class="stack">
          @for (appt of filtered(); track appt.id) {
            <div class="card appt-card" [class.appt-pending]="appt.status === 'pending'" [class.appt-accepted]="appt.status === 'accepted'" [class.appt-completed]="appt.status === 'completed'" [class.appt-rejected]="appt.status === 'rejected'" [class.appt-cancelled]="appt.status === 'cancelled'">
              <div class="card-head">
                <div>
                  <div class="row">
                    <h3 style="margin:0">{{ appt.petName }}</h3>
                    <span class="badge"
                      [class.badge-warn]="appt.status === 'pending'"
                      [class.badge-teal]="appt.status === 'accepted'"
                      [class.badge-ok]="appt.status === 'completed'"
                      [class.badge-danger]="appt.status === 'rejected' || appt.status === 'cancelled'">
                      {{ appt.status }}
                    </span>
                    <span class="badge badge-neutral">{{ appt.mode === 'video' ? 'Video consultation' : 'In person' }}</span>
                  </div>
                  <p class="muted small" style="margin:.25rem 0 0">
                    {{ formatDateTime(appt.scheduledFor) }}
                    · {{ auth.isVet() ? 'Owner: ' + appt.ownerName : 'Vet: ' + appt.vetName }}
                    @if (appt.clinicName) { · {{ appt.clinicName }} }
                    @if (appt.feeInr) { · ₹{{ appt.feeInr }} (demo fee) }
                  </p>
                </div>
                <span class="badge badge-demo" title="Synthetic demo record">Demo record</span>
              </div>

              <p class="small"><strong>Reason:</strong> {{ appt.reason }}</p>
              @if (appt.responseNote) {
                <p class="small muted"><strong>Response:</strong> {{ appt.responseNote }}</p>
              }

              <div class="row">
                @if (!auth.isVet() && appt.status === 'pending') {
                  <button class="btn btn-secondary btn-sm" type="button" (click)="cancel(appt)">Cancel request</button>
                }
                @if (!auth.isVet() && appt.status === 'accepted') {
                  <button class="btn btn-secondary btn-sm" type="button" (click)="cancel(appt)">Cancel appointment</button>
                  <a class="btn btn-secondary btn-sm" routerLink="/messages">Message vet</a>
                  @if (appt.mode === 'video') {
                    <a class="btn btn-primary btn-sm" [routerLink]="['/video', appt.id]">Join video room</a>
                  }
                }
                @if (auth.isVet() && appt.status === 'pending') {
                  <button class="btn btn-primary btn-sm" type="button" (click)="decide(appt, 'accepted')">Accept</button>
                  <button class="btn btn-secondary btn-sm" type="button" (click)="decide(appt, 'rejected')">Reject</button>
                }
                @if (auth.isVet() && appt.status === 'accepted') {
                  @if (appt.mode === 'video') {
                    <a class="btn btn-primary btn-sm" [routerLink]="['/video', appt.id]">Start video consultation</a>
                  }
                  <button class="btn btn-secondary btn-sm" type="button" (click)="decide(appt, 'completed')">Mark completed</button>
                  <a class="btn btn-secondary btn-sm" routerLink="/messages">Message owner</a>
                }
                <button class="btn btn-ghost btn-sm" type="button" (click)="toggleNotes(appt)">
                  {{ expandedId() === appt.id ? 'Hide' : 'View' }} notes
                </button>
              </div>

              @if (expandedId() === appt.id) {
                <div class="divider"></div>
                <div class="stack">
                  @if (!notes().length) {
                    <p class="small muted">No consultation notes recorded for this appointment.</p>
                  }
                  @for (note of notes(); track note.id) {
                    <div class="card tight" style="background:#FFFCF6">
                      <div class="row" style="justify-content:space-between">
                        <strong class="small">{{ note.vetName }}</strong>
                        <span class="tiny muted">{{ formatDateTime(note.createdAt) }}</span>
                      </div>
                      <p class="small" style="white-space:pre-wrap;margin:.4rem 0">{{ note.notes }}</p>
                      @if (note.carePlan) { <p class="small muted" style="white-space:pre-wrap"><strong>Care plan:</strong> {{ note.carePlan }}</p> }
                      @if (note.followUpOn) { <span class="badge badge-warn">Follow-up: {{ note.followUpOn }}</span> }
                    </div>
                  }

                  @if (auth.isVet() && (appt.status === 'accepted' || appt.status === 'completed')) {
                    <form [formGroup]="noteForm" (ngSubmit)="addNote(appt)" class="mt-1">
                      <div class="form-grid">
                        <mat-form-field appearance="outline" class="full">
                          <mat-label>Consultation notes (visible to the owner)</mat-label>
                          <textarea matInput rows="3" formControlName="notes" placeholder="Findings, advice given, what was discussed…"></textarea>
                        </mat-form-field>
                        <mat-form-field appearance="outline" class="full">
                          <mat-label>Care plan</mat-label>
                          <textarea matInput rows="2" formControlName="carePlan" placeholder="Follow-up steps for the owner"></textarea>
                        </mat-form-field>
                        <mat-form-field appearance="outline">
                          <mat-label>Follow-up date (optional)</mat-label>
                          <input matInput type="date" formControlName="followUpOn" />
                        </mat-form-field>
                      </div>
                      <button mat-flat-button color="primary" type="submit" [disabled]="savingNote()">Save consultation note</button>
                    </form>
                  }
                </div>
              }
            </div>
          }
        </div>
      }

      @if (decision(); as d) {
        <div class="modal-backdrop" role="dialog" aria-modal="true" [attr.aria-label]="d.title">
          <div class="card raised modal-card">
            <h3>{{ d.title }}</h3>
            <p class="small muted">{{ d.label }}</p>
            <textarea class="input" rows="3" [(ngModel)]="rejectNote" placeholder="Optional note"></textarea>
            <div class="form-actions">
              <button class="btn btn-secondary" type="button" (click)="decision.set(null)">Keep appointment</button>
              <button class="btn btn-primary" type="button" (click)="confirmDecision()">Confirm {{ d.status }}</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class AppointmentsComponent implements OnInit {
  readonly auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private fb = inject(FormBuilder);

  readonly appointments = signal<Appointment[]>([]);
  readonly loading = signal(true);
  readonly filter = signal('all');
  readonly expandedId = signal<string | null>(null);
  readonly notes = signal<ConsultationNote[]>([]);
  readonly savingNote = signal(false);

  readonly tabs = [
    { label: 'All', value: 'all' },
    { label: 'Pending', value: 'pending' },
    { label: 'Accepted', value: 'accepted' },
    { label: 'Completed', value: 'completed' },
    { label: 'Closed', value: 'closed' },
  ];

  readonly noteForm = this.fb.nonNullable.group({
    notes: ['', [Validators.required, Validators.minLength(3)]],
    carePlan: [''],
    followUpOn: [''],
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.get<{ appointments: Appointment[] }>('/appointments').subscribe({
      next: (res) => {
        this.appointments.set(res.appointments ?? []);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(err);
      },
    });
  }

  filtered(): Appointment[] {
    const filter = this.filter();
    if (filter === 'all') return this.appointments();
    if (filter === 'closed') return this.appointments().filter((a) => ['rejected', 'cancelled'].includes(a.status));
    return this.appointments().filter((a) => a.status === filter);
  }

  cancel(appt: Appointment): void {
    this.rejectNote = '';
    this.decision.set({
      appointment: appt,
      status: 'cancelled',
      title: 'Cancel appointment',
      label: 'The veterinarian will be notified. Add an optional note.',
    });
  }

  confirmDecision(): void {
    const decision = this.decision();
    if (!decision) return;
    this.api.patch(`/appointments/${decision.appointment.id}/status`, {
      status: decision.status,
      note: this.rejectNote.trim() || undefined,
    }).subscribe({
      next: () => {
        this.decision.set(null);
        this.toast.success(`Appointment ${decision.status}`);
        this.load();
      },
      error: (err) => this.toast.error(err),
    });
  }

  readonly decision = signal<{
    appointment: Appointment;
    status: 'cancelled' | 'rejected';
    title: string;
    label: string;
  } | null>(null);
  rejectNote = '';

  decide(appt: Appointment, status: 'accepted' | 'rejected' | 'completed'): void {
    if (status === 'rejected') {
      this.rejectNote = '';
      this.decision.set({
        appointment: appt,
        status: 'rejected',
        title: `Reject the request from ${appt.ownerName}`,
        label: 'Rejecting notifies the owner. A short reason helps them find alternative care.',
      });
      return;
    }
    this.api.patch(`/appointments/${appt.id}/status`, { status }).subscribe({
      next: () => {
        this.toast.success(`Appointment ${status}`);
        this.load();
      },
      error: (err) => this.toast.error(err),
    });
  }

  toggleNotes(appt: Appointment): void {
    if (this.expandedId() === appt.id) {
      this.expandedId.set(null);
      return;
    }
    this.expandedId.set(appt.id);
    this.notes.set([]);
    this.api.get<any>(`/appointments/${appt.id}`).subscribe({
      next: (res) => this.notes.set(res.notes ?? []),
      error: (err) => this.toast.error(err),
    });
  }

  addNote(appt: Appointment): void {
    if (this.noteForm.invalid) {
      this.noteForm.markAllAsTouched();
      return;
    }
    const v = this.noteForm.getRawValue();
    this.savingNote.set(true);
    this.api.post(`/appointments/${appt.id}/notes`, {
      notes: v.notes,
      carePlan: v.carePlan || undefined,
      followUpOn: v.followUpOn || undefined,
    }).subscribe({
      next: () => {
        this.savingNote.set(false);
        this.toast.success('Consultation note saved and shared with the owner');
        this.noteForm.reset({ notes: '', carePlan: '', followUpOn: '' });
        this.toggleNotes(appt);
        this.toggleNotes(appt);
      },
      error: (err) => {
        this.savingNote.set(false);
        this.toast.error(err);
      },
    });
  }

  formatDateTime(value: string): string {
    return new Intl.DateTimeFormat('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
    }).format(new Date(value)) + ' IST';
  }
}
