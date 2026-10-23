import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { AuthService } from '../core/auth.service';
import { ApiService } from '../core/api.service';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [
    ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule,
    MatButtonModule, MatButtonToggleModule,
  ],
  template: `
    <div class="page page-narrow">
      <div class="card raised" style="padding:clamp(1.25rem,3vw,2.2rem)">
        <span class="eyebrow">Join Pet Vet AI</span>
        <h1 style="font-size:clamp(1.5rem,3vw,2.1rem)">Create your account</h1>
        <p class="muted small">Owners add pets and care plans. Veterinarians submit credentials for verification.</p>

        @if (error()) {
          <div class="banner banner-danger" role="alert">
            <span class="banner-icon">⚠️</span>
            <div><strong>Could not create the account</strong><p>{{ error() }}</p></div>
          </div>
        }

        <form [formGroup]="form" (ngSubmit)="submit()" style="margin-top:1.2rem" novalidate>
          <div class="field">
            <span class="field-label">I am registering as</span>
            <mat-button-toggle-group formControlName="role" aria-label="Account role" style="margin-top:.3rem">
              <mat-button-toggle value="owner">Pet owner</mat-button-toggle>
              <mat-button-toggle value="vet">Veterinarian</mat-button-toggle>
            </mat-button-toggle-group>
          </div>

          <div class="form-grid">
            <mat-form-field appearance="outline">
              <mat-label>Full name</mat-label>
              <input matInput formControlName="fullName" autocomplete="name" />
              @if (form.controls.fullName.touched && form.controls.fullName.invalid) {
                <mat-error>Enter your full name</mat-error>
              }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Email</mat-label>
              <input matInput type="email" formControlName="email" autocomplete="email" />
              @if (form.controls.email.touched && form.controls.email.invalid) {
                <mat-error>Enter a valid email address</mat-error>
              }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Password</mat-label>
              <input matInput type="password" formControlName="password" autocomplete="new-password" />
              <mat-hint>At least 8 characters</mat-hint>
              @if (form.controls.password.touched && form.controls.password.invalid) {
                <mat-error>Use at least 8 characters</mat-error>
              }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Phone (optional)</mat-label>
              <input matInput formControlName="phone" autocomplete="tel" />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>City</mat-label>
              <input matInput formControlName="city" />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>State</mat-label>
              <input matInput formControlName="state" />
            </mat-form-field>
          </div>

          @if (form.controls.role.value === 'vet') {
            <div class="divider"></div>
            <div class="banner banner-info" style="margin-bottom:1rem">
              <span class="banner-icon">🛡️</span>
              <div>
                <strong>Verification is required</strong>
                <p>Your profile stays hidden from the directory until an administrator reviews your credentials. This demo platform cannot verify a real license.</p>
              </div>
            </div>
            <div class="form-grid">
              <mat-form-field appearance="outline">
                <mat-label>Registration / license number</mat-label>
                <input matInput formControlName="licenseNumber" />
                @if (form.controls.licenseNumber.touched && form.controls.licenseNumber.invalid) {
                  <mat-error>License number is required</mat-error>
                }
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Veterinary council</mat-label>
                <input matInput formControlName="council" placeholder="State Veterinary Council" />
                @if (form.controls.council.touched && form.controls.council.invalid) {
                  <mat-error>Council is required</mat-error>
                }
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Clinic name (optional)</mat-label>
                <input matInput formControlName="clinicName" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Years of experience</mat-label>
                <input matInput type="number" min="0" max="70" formControlName="experienceYears" />
              </mat-form-field>
              <mat-form-field appearance="outline" class="full">
                <mat-label>Specialties (comma separated)</mat-label>
                <input matInput formControlName="specialties" placeholder="General medicine, dermatology" />
              </mat-form-field>
            </div>
            <div class="field">
              <span class="field-label">Species you treat</span>
              <div class="row">
                @for (sp of speciesOptions; track sp.code) {
                  <label class="check-row" style="border:1px solid var(--line);border-radius:999px;padding:.35rem .7rem;margin:0">
                    <input type="checkbox" [checked]="selectedSpecies().includes(sp.code)" (change)="toggleSpecies(sp.code)" />
                    <span>{{ sp.icon }} {{ sp.name }}</span>
                  </label>
                }
              </div>
            </div>
          }

          <div class="form-actions">
            <a mat-button routerLink="/login">I already have an account</a>
            <button mat-flat-button color="primary" type="submit" [disabled]="loading()">
              {{ loading() ? 'Creating account…' : 'Create account' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  `,
})
export class RegisterComponent {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);

  readonly loading = signal(false);
  readonly error = signal('');
  readonly selectedSpecies = signal<string[]>(['dog', 'cat']);
  readonly speciesOptions = [
    { code: 'dog', name: 'Dogs', icon: '🐕' },
    { code: 'cat', name: 'Cats', icon: '🐈' },
    { code: 'bird', name: 'Birds', icon: '🦜' },
    { code: 'cow', name: 'Cattle', icon: '🐄' },
    { code: 'goat', name: 'Goats', icon: '🐐' },
    { code: 'other', name: 'Other', icon: '🐾' },
  ];

  readonly form = this.fb.nonNullable.group({
    role: ['owner' as 'owner' | 'vet'],
    fullName: ['', [Validators.required, Validators.minLength(2)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
    phone: [''],
    city: [''],
    state: [''],
    licenseNumber: [''],
    council: [''],
    clinicName: [''],
    experienceYears: [null as number | null],
    specialties: [''],
  });

  toggleSpecies(code: string): void {
    this.selectedSpecies.update((list) =>
      list.includes(code) ? list.filter((c) => c !== code) : [...list, code],
    );
  }

  submit(): void {
    this.error.set('');
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    if (value.role === 'vet' && (!value.licenseNumber.trim() || !value.council.trim())) {
      this.error.set('Add your license number and veterinary council before registering.');
      return;
    }
    const payload: Record<string, unknown> = {
      email: value.email.trim(),
      password: value.password,
      fullName: value.fullName.trim(),
      role: value.role,
      phone: value.phone || undefined,
      city: value.city || undefined,
      state: value.state || undefined,
    };
    if (value.role === 'vet') {
      payload['vet'] = {
        licenseNumber: value.licenseNumber.trim(),
        council: value.council.trim(),
        experienceYears: value.experienceYears ?? undefined,
        clinicName: value.clinicName || undefined,
        specialties: value.specialties
          ? value.specialties.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12)
          : undefined,
        species: this.selectedSpecies(),
      };
    }
    this.loading.set(true);
    this.auth.register(payload).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.user.role === 'vet') this.router.navigate(['/vet']);
        else this.router.navigate(['/onboarding']);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(ApiService.message(err));
      },
    });
  }
}
