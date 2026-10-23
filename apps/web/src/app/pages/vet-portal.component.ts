import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { VetProfile } from '../core/models';

@Component({
  selector: 'app-vet-portal',
  standalone: true,
  imports: [RouterLink, ReactiveFormsModule, DatePipe, MatFormFieldModule, MatInputModule, MatButtonModule, MatSelectModule],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">Practice</span>
          <h1>{{ auth.user()?.fullName }}</h1>
          <p>Credentials, species coverage, clinic details and availability. Administrators review verification status.</p>
        </div>
        <div class="row">
          <a mat-stroked-button routerLink="/appointments">Appointments</a>
          <a mat-flat-button color="primary" routerLink="/messages">Messages</a>
        </div>
      </div>

      @if (loading()) {
        <div class="loading-block"><span class="spinner"></span> Loading practice profile…</div>
      } @else if (profile(); as p) {
        @if (p.verificationStatus === 'pending') {
          <div class="banner banner-warn" style="margin-bottom:1rem">
            <span class="banner-icon">🛡️</span>
            <div>
              <strong>Verification pending</strong>
              <p>Your profile is hidden from the public directory and you cannot accept new appointments until an administrator verifies your credentials. This demo cannot validate a real license.</p>
            </div>
          </div>
        } @else if (p.verificationStatus === 'rejected') {
          <div class="banner banner-danger" style="margin-bottom:1rem">
            <span class="banner-icon">⚠️</span>
            <div>
              <strong>Verification was rejected</strong>
              <p>{{ p.verificationNotes || 'Review your credentials and contact the administrator.' }}</p>
            </div>
          </div>
        } @else {
          <div class="banner banner-ok" style="margin-bottom:1rem">
            <span class="banner-icon">✅</span>
            <div><strong>Verified (demo)</strong><p>Your professional profile is visible in the directory. Changing your license or council sends it back for review.</p></div>
          </div>
        }

        <div class="grid grid-4" style="margin-bottom:1rem">
          <div class="stat"><span class="stat-label">Pending requests</span><span class="stat-value">{{ stats()?.pending ?? 0 }}</span></div>
          <div class="stat"><span class="stat-label">Accepted</span><span class="stat-value">{{ stats()?.accepted ?? 0 }}</span></div>
          <div class="stat"><span class="stat-label">Completed</span><span class="stat-value">{{ stats()?.completed ?? 0 }}</span></div>
          <div class="stat"><span class="stat-label">Unread messages</span><span class="stat-value">{{ stats()?.unread ?? 0 }}</span></div>
        </div>

        <div class="split">
          <form [formGroup]="form" (ngSubmit)="save()" class="card">
            <div class="card-head"><div><h3>Professional profile</h3><p>All fields except credentials can be updated freely.</p></div></div>
            <div class="form-grid">
              <mat-form-field appearance="outline">
                <mat-label>License number</mat-label>
                <input matInput formControlName="licenseNumber" />
                @if (form.controls.licenseNumber.invalid && form.controls.licenseNumber.touched) { <mat-error>Required</mat-error> }
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Veterinary council</mat-label>
                <input matInput formControlName="council" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Years of experience</mat-label>
                <input matInput type="number" min="0" max="70" formControlName="experienceYears" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Consultation fee (₹, demo)</mat-label>
                <input matInput type="number" min="0" formControlName="consultationFeeInr" />
              </mat-form-field>
              <mat-form-field appearance="outline" class="full">
                <mat-label>Professional bio</mat-label>
                <textarea matInput rows="3" formControlName="bio" placeholder="Approach, species focus, languages spoken…"></textarea>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Clinic name</mat-label>
                <input matInput formControlName="clinicName" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Clinic address</mat-label>
                <input matInput formControlName="clinicAddress" />
              </mat-form-field>
              <mat-form-field appearance="outline"><mat-label>City</mat-label><input matInput formControlName="city" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>State</mat-label><input matInput formControlName="state" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Pincode</mat-label><input matInput formControlName="pincode" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Latitude (optional)</mat-label><input matInput type="number" formControlName="latitude" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Longitude (optional)</mat-label><input matInput type="number" formControlName="longitude" /></mat-form-field>
              <mat-form-field appearance="outline" class="full">
                <mat-label>Specialties (comma separated)</mat-label>
                <input matInput formControlName="specialties" />
              </mat-form-field>
              <mat-form-field appearance="outline" class="full">
                <mat-label>Availability slots (24h, comma separated)</mat-label>
                <input matInput formControlName="slots" placeholder="10:00, 11:00, 17:00" />
              </mat-form-field>
            </div>

            <div class="field">
              <span class="field-label">Species you treat</span>
              <div class="row">
                @for (sp of speciesOptions; track sp.code) {
                  <label class="check-row" style="border:1px solid var(--line);border-radius:999px;padding:.35rem .7rem;margin:0">
                    <input type="checkbox" [checked]="species().includes(sp.code)" (change)="toggleSpecies(sp.code)" />
                    <span>{{ sp.icon }} {{ sp.name }}</span>
                  </label>
                }
              </div>
            </div>

            <div class="field">
              <span class="field-label">Available days</span>
              <div class="row">
                @for (day of days; track day) {
                  <label class="check-row" style="border:1px solid var(--line);border-radius:999px;padding:.35rem .7rem;margin:0">
                    <input type="checkbox" [checked]="selectedDays().includes(day)" (change)="toggleDay(day)" />
                    <span>{{ day }}</span>
                  </label>
                }
              </div>
            </div>

            <div class="form-actions">
              <span class="tiny muted spacer" style="align-self:center">Demo profiles are never presented as real practitioners.</span>
              <button mat-flat-button color="primary" type="submit" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save profile' }}</button>
            </div>
          </form>

          <aside class="stack">
            <div class="card">
              <h3>Verification status</h3>
              <p class="small muted">Only verified profiles appear in the public directory and can be booked.</p>
              <div class="cap-row"><span>Status</span><span class="badge" [class.badge-ok]="p.verificationStatus === 'verified'" [class.badge-warn]="p.verificationStatus === 'pending'" [class.badge-danger]="p.verificationStatus === 'rejected'">{{ p.verificationStatus }}</span></div>
              <div class="cap-row"><span>Council</span><span class="small">{{ p.council }}</span></div>
              <div class="cap-row"><span>Verified at</span><span class="small">{{ p.verifiedAt ? (p.verifiedAt | date:'mediumDate') : 'Not yet' }}</span></div>
              @if (p.verificationNotes) { <p class="tiny muted mt-1">{{ p.verificationNotes }}</p> }
            </div>
            <div class="card">
              <h3>Consultation workflow</h3>
              <ol class="small muted" style="padding-left:1.1rem;margin:0">
                <li>Owner requests an appointment for a shared species.</li>
                <li>You accept or reject; acceptance opens a private chat.</li>
                <li>In-person or peer-to-peer video consultation.</li>
                <li>Add consultation notes and a care plan for the owner.</li>
              </ol>
            </div>
            <div class="banner banner-warn">
              <span class="banner-icon">📋</span>
              <div><strong>Clinical responsibility stays with you</strong><p>The platform provides records and communication tools, not diagnostic decision support for veterinarians.</p></div>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
})
export class VetPortalComponent implements OnInit {
  readonly auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private fb = inject(FormBuilder);

  readonly profile = signal<VetProfile | null>(null);
  readonly stats = signal<any>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly species = signal<string[]>(['dog', 'cat']);
  readonly selectedDays = signal<string[]>(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  readonly days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  readonly speciesOptions = [
    { code: 'dog', name: 'Dogs', icon: '🐕' }, { code: 'cat', name: 'Cats', icon: '🐈' },
    { code: 'bird', name: 'Birds', icon: '🦜' }, { code: 'cow', name: 'Cattle', icon: '🐄' },
    { code: 'goat', name: 'Goats', icon: '🐐' }, { code: 'other', name: 'Other', icon: '🐾' },
  ];

  readonly form = this.fb.nonNullable.group({
    licenseNumber: ['', Validators.required],
    council: ['', Validators.required],
    experienceYears: [null as number | null],
    consultationFeeInr: [null as number | null],
    bio: [''],
    clinicName: [''],
    clinicAddress: [''],
    city: [''],
    state: [''],
    pincode: [''],
    latitude: [null as number | null],
    longitude: [null as number | null],
    specialties: [''],
    slots: [''],
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.get<any>('/vet/profile').subscribe({
      next: (res) => {
        this.profile.set(res.profile);
        this.stats.set(res.stats);
        const p: VetProfile = res.profile;
        this.form.patchValue({
          licenseNumber: p.licenseNumber ?? '',
          council: p.council ?? '',
          experienceYears: p.experienceYears ?? null,
          consultationFeeInr: p.consultationFeeInr ?? null,
          bio: p.bio ?? '',
          clinicName: p.clinicName ?? '',
          clinicAddress: p.clinicAddress ?? '',
          city: p.city ?? '',
          state: p.state ?? '',
          pincode: p.pincode ?? '',
          latitude: p.latitude ?? null,
          longitude: p.longitude ?? null,
          specialties: (p.specialties ?? []).join(', '),
          slots: (p.availability?.slots ?? []).join(', '),
        });
        this.species.set(p.species?.length ? p.species : ['dog', 'cat']);
        this.selectedDays.set(p.availability?.days?.length ? p.availability.days : this.days.slice(0, 6));
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(err);
      },
    });
  }

  toggleSpecies(code: string): void {
    this.species.update((list) => (list.includes(code) ? list.filter((c) => c !== code) : [...list, code]));
  }

  toggleDay(day: string): void {
    this.selectedDays.update((list) => (list.includes(day) ? list.filter((d) => d !== day) : [...list, day]));
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const slots = v.slots.split(',').map((s) => s.trim()).filter(Boolean);
    if (slots.some((s) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(s))) {
      this.toast.info('Use 24-hour slot times such as 10:00 or 17:30.');
      return;
    }
    const specialties = v.specialties.split(',').map((s) => s.trim()).filter(Boolean);
    this.saving.set(true);
    this.api.patch<any>('/vet/profile', {
      licenseNumber: v.licenseNumber,
      council: v.council,
      experienceYears: v.experienceYears,
      consultationFeeInr: v.consultationFeeInr,
      bio: v.bio || null,
      clinicName: v.clinicName || null,
      clinicAddress: v.clinicAddress || null,
      city: v.city || null,
      state: v.state || null,
      pincode: v.pincode || null,
      latitude: v.latitude,
      longitude: v.longitude,
      specialties,
      species: this.species(),
      availability: { days: this.selectedDays(), slots },
    }).subscribe({
      next: (res) => {
        this.saving.set(false);
        this.profile.set(res.profile);
        this.toast.success('Practice profile saved');
        if (res.profile.verificationStatus === 'pending') {
          this.toast.info('Credential changes were submitted for re-verification.');
        }
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        this.toast.error(err);
      },
    });
  }
}
