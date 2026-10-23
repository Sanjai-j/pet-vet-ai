import { Component, OnInit, inject, signal } from '@angular/core';
import { SlicePipe } from '@angular/common';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';

interface ApplicationState {
  application: {
    id: string;
    status: string;
    summary: string;
    documentIds: string[];
    reviewNotes: string | null;
    submittedAt: string;
    reviewedAt: string | null;
    reverifyDueOn: string | null;
    reviewerName: string | null;
  } | null;
  profile: {
    verificationStatus: string;
    profileStatus: string;
    suspendedReason: string | null;
    verifiedAt: string | null;
    reverifyDueOn: string | null;
  } | null;
}

/**
 * Verification application. A veterinarian is only listed in the directory and
 * only bookable once an administrator approves the credentials submitted here.
 */
@Component({
  selector: 'app-vet-application',
  standalone: true,
  imports: [
    RouterLink, FormsModule, ReactiveFormsModule, SlicePipe, MatFormFieldModule, MatInputModule, MatButtonModule,
  ],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">Verification</span>
          <h1>Apply to be listed</h1>
          <p>Submit your registration details for review. Pet Vet AI administrators check every application by hand before a profile is published or bookable.</p>
        </div>
        <a mat-stroked-button routerLink="/vet">Back to practice</a>
      </div>

      @if (loading()) {
        <div class="loading-block"><span class="spinner"></span> Loading your application…</div>
      } @else {
        @if (state()?.application; as app) {
          <div class="card" style="margin-bottom:1rem">
            <div class="card-head">
              <div><h3>Current application</h3><p>Submitted {{ app.submittedAt | slice: 0:10 }}</p></div>
              <span class="badge" [class.badge-warn]="isOpen(app.status)" [class.badge-ok]="app.status === 'approved'" [class.badge-danger]="app.status === 'rejected'">
                {{ statusLabel(app.status) }}
              </span>
            </div>
            <p class="small muted">{{ app.summary }}</p>
            @if (app.reviewNotes) {
              <div class="banner banner-info">
                <span class="banner-icon">📝</span>
                <div><strong>Reviewer notes</strong><p>{{ app.reviewNotes }}</p></div>
              </div>
            }
            @if (app.reverifyDueOn) {
              <p class="tiny muted">Re-verification due {{ app.reverifyDueOn }}.</p>
            }
            <p class="tiny muted">
              Uploaded documents: {{ app.documentIds.length }}. Licence checks are a workflow demonstration — this demo cannot validate a real veterinary registration.
            </p>
          </div>
        }

        @if (canApply()) {
          <form [formGroup]="form" (ngSubmit)="submit()" class="card">
            <div class="card-head">
              <div><h3>Professional details</h3><p>Everything here is reviewed. Incomplete applications are sent back, not published.</p></div>
            </div>
            <div class="form-grid">
              <mat-form-field appearance="outline"><mat-label>Full professional name</mat-label><input matInput formControlName="professionalName" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Phone</mat-label><input matInput formControlName="phone" placeholder="+91 …" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Registration / licence number</mat-label><input matInput formControlName="licenseNumber" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Registering authority</mat-label><input matInput formControlName="registrationAuthority" placeholder="State Veterinary Council" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Qualification</mat-label><input matInput formControlName="qualification" placeholder="BVSc & AH" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Years of experience</mat-label><input matInput type="number" min="0" max="70" formControlName="experienceYears" /></mat-form-field>
              <mat-form-field appearance="outline" class="full"><mat-label>Specialities (comma separated)</mat-label><input matInput formControlName="specialization" placeholder="Dermatology, Dentistry" /></mat-form-field>
              <mat-form-field appearance="outline" class="full"><mat-label>Languages spoken (comma separated)</mat-label><input matInput formControlName="languages" placeholder="English, Kannada, Hindi" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Clinic name (optional)</mat-label><input matInput formControlName="clinicName" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Clinic address (optional)</mat-label><input matInput formControlName="clinicAddress" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Service area</mat-label><input matInput formControlName="serviceArea" placeholder="Indiranagar and 10 km around" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Consultation fee (₹, optional)</mat-label><input matInput type="number" min="0" formControlName="consultationFeeInr" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>City</mat-label><input matInput formControlName="city" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>State</mat-label><input matInput formControlName="state" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Pincode</mat-label><input matInput formControlName="pincode" /></mat-form-field>
              <mat-form-field appearance="outline" class="full">
                <mat-label>Short professional bio</mat-label>
                <textarea matInput rows="3" formControlName="bio"></textarea>
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
              <span class="field-label">Consultation types</span>
              <div class="row">
                @for (mode of consultationTypes; track mode.value) {
                  <label class="check-row" style="border:1px solid var(--line);border-radius:999px;padding:.35rem .7rem;margin:0">
                    <input type="checkbox" [checked]="modes().includes(mode.value)" (change)="toggleMode(mode.value)" />
                    <span>{{ mode.label }}</span>
                  </label>
                }
              </div>
            </div>

            <div class="field">
              <span class="field-label">Credential documents</span>
              <p class="tiny muted">Degree certificate, registration certificate or clinic authorisation. PDF or image, up to 10 MB each.</p>
              <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" (change)="onFiles($event)" />
              @if (uploading()) { <span class="tiny muted">Uploading…</span> }
              @for (doc of documents(); track doc.id) {
                <span class="chip">{{ doc.name }} <button class="btn btn-ghost btn-sm" type="button" (click)="removeDoc(doc.id)" aria-label="Remove document">✕</button></span>
              }
            </div>

            <div class="row" style="justify-content:flex-end">
              <span class="tiny muted">A submitted application stays unapproved until an administrator records a decision.</span>
              <button class="btn btn-primary" type="submit" [disabled]="saving()">{{ saving() ? 'Submitting…' : 'Submit for review' }}</button>
            </div>
          </form>
        }
      }
    </div>
  `,
})
export class VetApplicationComponent implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private fb = inject(FormBuilder);

  readonly speciesOptions = [
    { code: 'dog', name: 'Dogs', icon: '🐕' },
    { code: 'cat', name: 'Cats', icon: '🐈' },
    { code: 'bird', name: 'Birds', icon: '🦜' },
    { code: 'cow', name: 'Cattle', icon: '🐄' },
    { code: 'goat', name: 'Goats', icon: '🐐' },
    { code: 'other', name: 'Other', icon: '🐾' },
  ];
  readonly consultationTypes = [
    { value: 'in_person', label: 'In person' },
    { value: 'video', label: 'Video' },
    { value: 'chat', label: 'Chat' },
  ];

  readonly state = signal<ApplicationState | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly uploading = signal(false);
  readonly species = signal<string[]>(['dog', 'cat']);
  readonly modes = signal<string[]>(['in_person']);
  readonly documents = signal<{ id: string; name: string }[]>([]);

  readonly form = this.fb.nonNullable.group({
    professionalName: ['', [Validators.required, Validators.minLength(3)]],
    phone: ['', [Validators.required, Validators.minLength(7)]],
    licenseNumber: ['', [Validators.required, Validators.minLength(3)]],
    registrationAuthority: ['', [Validators.required]],
    qualification: ['', [Validators.required]],
    experienceYears: [0, [Validators.required, Validators.min(0), Validators.max(70)]],
    specialization: ['Small animal medicine', [Validators.required]],
    languages: ['English', [Validators.required]],
    clinicName: [''],
    clinicAddress: [''],
    serviceArea: [''],
    consultationFeeInr: [null as number | null],
    city: ['', [Validators.required]],
    state: ['', [Validators.required]],
    pincode: [''],
    bio: [''],
  });

  ngOnInit(): void {
    const user = this.auth.user();
    if (user) {
      this.form.patchValue({ professionalName: user.fullName, city: user.city ?? '', state: user.state ?? '', phone: user.phone ?? '' });
    }
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api.get<ApplicationState>('/directory/applications/me').subscribe({
      next: (res) => {
        this.state.set(res);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(err);
      },
    });
  }

  /** A new application is only allowed when nothing is pending or approved. */
  canApply(): boolean {
    const app = this.state()?.application;
    const profile = this.state()?.profile;
    if (profile?.verificationStatus === 'verified' || profile?.verificationStatus === 'suspended') return false;
    if (!app) return true;
    return ['rejected', 'additional_info_required'].includes(app.status);
  }

  isOpen(status: string): boolean {
    return ['submitted', 'under_review', 'additional_info_required'].includes(status);
  }

  statusLabel(status: string): string {
    const labels: Record<string, string> = {
      submitted: 'Submitted',
      under_review: 'Under review',
      additional_info_required: 'More information needed',
      approved: 'Approved',
      rejected: 'Not approved',
    };
    return labels[status] ?? status;
  }

  toggleSpecies(code: string): void {
    this.species.update((cur) => (cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]));
  }

  toggleMode(value: string): void {
    this.modes.update((cur) => (cur.includes(value) ? cur.filter((c) => c !== value) : [...cur, value]));
  }

  onFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    this.uploading.set(true);
    let pending = files.length;
    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      form.append('purpose', 'credential');
      this.api.upload('/files', form).subscribe({
        next: (res) => {
          this.documents.update((cur) => [...cur, { id: res.file.id, name: res.file.originalName }]);
          if (--pending === 0) this.uploading.set(false);
        },
        error: (err) => {
          this.toast.error(err);
          if (--pending === 0) this.uploading.set(false);
        },
      });
    }
  }

  removeDoc(id: string): void {
    this.documents.update((cur) => cur.filter((d) => d.id !== id));
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.toast.info('Fill in the required professional details.');
      return;
    }
    if (!this.species().length) {
      this.toast.info('Choose at least one species you treat.');
      return;
    }
    if (!this.modes().length) {
      this.toast.info('Choose at least one consultation type.');
      return;
    }
    const v = this.form.getRawValue();
    const split = (value: string) =>
      value.split(',').map((s) => s.trim()).filter(Boolean);

    this.saving.set(true);
    this.api
      .post('/directory/applications', {
        professionalName: v.professionalName.trim(),
        phone: v.phone.trim(),
        licenseNumber: v.licenseNumber.trim(),
        registrationAuthority: v.registrationAuthority.trim(),
        qualification: v.qualification.trim(),
        specialization: split(v.specialization),
        species: this.species(),
        languages: split(v.languages),
        experienceYears: Number(v.experienceYears ?? 0),
        clinicName: v.clinicName.trim() || undefined,
        clinicAddress: v.clinicAddress.trim() || undefined,
        serviceArea: v.serviceArea.trim() || undefined,
        city: v.city.trim(),
        state: v.state.trim(),
        pincode: v.pincode.trim() || undefined,
        consultationTypes: this.modes(),
        consultationFeeInr: v.consultationFeeInr ?? undefined,
        bio: v.bio.trim() || undefined,
        documentIds: this.documents().map((d) => d.id),
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.toast.success('Application submitted. An administrator will review it.');
          this.documents.set([]);
          this.load();
        },
        error: (err) => {
          this.saving.set(false);
          this.toast.error(err);
        },
      });
  }
}
