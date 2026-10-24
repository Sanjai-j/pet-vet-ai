import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../core/api.service';

/**
 * Password reset, step 2: the screen behind the emailed link.
 *
 * `/reset-password?token=…` first asks the API whether the token is still
 * usable, so an expired link says so immediately instead of after the owner
 * has typed a new password twice. On success the token is spent and the owner
 * is sent to the sign-in screen — a reset never signs them in on its own.
 */
@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <div class="auth-wrap" style="grid-template-columns:1fr">
      <section class="auth-form-side">
        <div class="auth-card">
          <span class="eyebrow">Password help</span>
          <h2>Choose a new password</h2>

          @if (checking()) {
            <p class="muted small"><span class="spinner"></span> Checking your link…</p>
          } @else if (!token()) {
            <div class="banner banner-danger" role="alert">
              <span class="banner-icon">⚠️</span>
              <div>
                <strong>This link is incomplete</strong>
                <p>Open the link from the email again, or request a new one.</p>
              </div>
            </div>
          } @else if (!valid()) {
            <div class="banner banner-danger" role="alert">
              <span class="banner-icon">⌛</span>
              <div>
                <strong>This link has expired</strong>
                <p>Reset links work once and last 30 minutes. Request a fresh one below.</p>
              </div>
            </div>
          }

          @if (done()) {
            <div class="banner banner-ok" role="status">
              <span class="banner-icon">✅</span>
              <div>
                <strong>Password changed</strong>
                <p>Sign in with your new password. Other devices stay signed in until their session expires.</p>
              </div>
            </div>
            <button mat-flat-button color="primary" class="w-full mt-2" type="button" (click)="goToLogin()">
              Go to sign in
            </button>
          } @else if (valid()) {
            @if (error()) {
              <div class="banner banner-danger" role="alert">
                <span class="banner-icon">⚠️</span>
                <div><strong>Could not change the password</strong><p>{{ error() }}</p></div>
              </div>
            }

            <form [formGroup]="form" (ngSubmit)="submit()" class="stack" novalidate>
              <mat-form-field appearance="outline">
                <mat-label>New password</mat-label>
                <input
                  matInput
                  [type]="showPassword() ? 'text' : 'password'"
                  formControlName="newPassword"
                  autocomplete="new-password"
                />
                <button
                  mat-icon-button
                  matSuffix
                  type="button"
                  class="password-toggle"
                  (click)="showPassword.set(!showPassword())"
                  [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
                >
                  <span aria-hidden="true">{{ showPassword() ? '🙈' : '👁️' }}</span>
                </button>
                @if (form.controls.newPassword.touched && form.controls.newPassword.invalid) {
                  <mat-error>Use at least 8 characters</mat-error>
                }
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Confirm new password</mat-label>
                <input matInput type="password" formControlName="confirmPassword" autocomplete="new-password" />
                @if (form.controls.confirmPassword.touched && form.controls.confirmPassword.invalid) {
                  <mat-error>Type the same password again</mat-error>
                }
              </mat-form-field>

              <button mat-flat-button color="primary" type="submit" class="w-full" [disabled]="saving()">
                @if (saving()) { <span class="spinner" style="border-top-color:#fff"></span> }
                {{ saving() ? 'Saving…' : 'Save new password' }}
              </button>
            </form>
          }

          <p class="small muted mt-2">
            <a routerLink="/forgot-password">Request a new link</a> · <a routerLink="/login">Back to sign in</a>
          </p>
        </div>
      </section>
    </div>
  `,
})
export class ResetPasswordComponent implements OnInit {
  private fb = inject(FormBuilder);
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly checking = signal(true);
  readonly valid = signal(false);
  readonly saving = signal(false);
  readonly done = signal(false);
  readonly error = signal('');
  readonly showPassword = signal(false);
  readonly token = signal('');

  readonly form = this.fb.nonNullable.group({
    newPassword: ['', [Validators.required, Validators.minLength(8)]],
    confirmPassword: ['', [Validators.required, Validators.minLength(8)]],
  });

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token') ?? '';
    this.token.set(token);
    if (!token) {
      this.checking.set(false);
      return;
    }
    this.api.get<{ valid: boolean }>(`/auth/reset-password/${encodeURIComponent(token)}`).subscribe({
      next: (res) => {
        this.valid.set(Boolean(res.valid));
        this.checking.set(false);
      },
      error: () => {
        this.valid.set(false);
        this.checking.set(false);
      },
    });
  }

  submit(): void {
    this.error.set('');
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { newPassword, confirmPassword } = this.form.getRawValue();
    if (newPassword !== confirmPassword) {
      this.error.set('The two passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      this.error.set('Use at least 8 characters.');
      return;
    }
    this.saving.set(true);
    this.api
      .post<{ ok: boolean }>('/auth/reset-password', { token: this.token(), newPassword })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.done.set(true);
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(ApiService.message(err));
        },
      });
  }

  goToLogin(): void {
    this.router.navigate(['/login']);
  }
}
