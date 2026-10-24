import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../core/api.service';

/**
 * Password reset, step 1: ask the API to email a one-time link.
 *
 * The API answers the same way for every address. The `delivery` field says
 * whether this server can send email at all, which is the one thing the owner
 * genuinely needs to know — a silent "check your inbox" when no sender is
 * configured just sends them looking through spam for nothing.
 */
@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <div class="auth-wrap" style="grid-template-columns:1fr">
      <section class="auth-form-side">
        <div class="auth-card">
          <span class="eyebrow">Password help</span>
          <h2>Forgot your password?</h2>
          <p class="muted small">
            Enter the email you signed up with and we will send a one-time link. It expires in
            30 minutes and works once.
          </p>

          @if (sent()) {
            <div class="banner" [class.banner-ok]="delivered()" [class.banner-danger]="!delivered()" role="status">
              <span class="banner-icon">{{ delivered() ? '✉️' : '⚠️' }}</span>
              <div>
                <strong>{{ delivered() ? 'Check your inbox' : 'No email was sent' }}</strong>
                <p>{{ sentMessage() }}</p>
              </div>
            </div>
          }

          @if (error()) {
            <div class="banner banner-danger" role="alert">
              <span class="banner-icon">⚠️</span>
              <div><strong>Could not send the link</strong><p>{{ error() }}</p></div>
            </div>
          }

          @if (!sent()) {
            <form [formGroup]="form" (ngSubmit)="submit()" class="stack" novalidate>
              <mat-form-field appearance="outline">
                <mat-label>Email address</mat-label>
                <input matInput type="email" formControlName="email" autocomplete="email" placeholder="you@example.com" />
                @if (form.controls.email.touched && form.controls.email.invalid) {
                  <mat-error>Enter a valid email address</mat-error>
                }
              </mat-form-field>

              <button mat-flat-button color="primary" type="submit" class="w-full" [disabled]="loading()">
                @if (loading()) { <span class="spinner" style="border-top-color:#fff"></span> }
                {{ loading() ? 'Sending…' : 'Send reset link' }}
              </button>
            </form>
          }

          <p class="small muted mt-2">
            <a routerLink="/login">Back to sign in</a>
            @if (sent() && !delivered()) {
              · <a routerLink="/forgot-password" (click)="reset()">Try another email</a>
            }
          </p>

          <p class="small muted mb-0">
            No link? Check the spam folder, then make sure you used the address on the account.
            Still stuck? Ask your administrator to reset it.
          </p>
        </div>
      </section>
    </div>
  `,
})
export class ForgotPasswordComponent {
  private fb = inject(FormBuilder);
  private api = inject(ApiService);

  readonly loading = signal(false);
  readonly error = signal('');
  readonly sent = signal(false);
  readonly delivered = signal(false);
  readonly sentMessage = signal('');

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  submit(): void {
    this.error.set('');
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.loading.set(true);
    this.api
      .post<{ ok: boolean; delivery: 'sent' | 'skipped' | 'failed' }>('/auth/forgot-password', {
        email: this.form.getRawValue().email,
      })
      .subscribe({
        next: (res) => {
          this.loading.set(false);
          this.delivered.set(res.delivery === 'sent');
          this.sentMessage.set(messageFor(res.delivery));
          this.sent.set(true);
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(ApiService.message(err));
        },
      });
  }

  reset(): void {
    this.sent.set(false);
    this.delivered.set(false);
    this.sentMessage.set('');
    this.error.set('');
  }
}

function messageFor(delivery: 'sent' | 'skipped' | 'failed'): string {
  if (delivery === 'skipped') {
    return (
      'This server has no email sender configured, so the link could not be sent. ' +
      'The administrator needs to set EMAIL_PROVIDER and EMAIL_API_KEY on the API.'
    );
  }
  if (delivery === 'failed') {
    return 'The email service refused the message just now. Please try again in a few minutes.';
  }
  return (
    'If that address has an account, a reset link is on its way. It can take a minute to arrive — ' +
    'check the spam folder too.'
  );
}
