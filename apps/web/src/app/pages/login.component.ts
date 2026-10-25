import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from '../core/auth.service';
import { ApiService } from '../core/api.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <div class="auth-wrap">
      <section class="auth-visual">
        <div>
          <span class="eyebrow" style="color:#FFE2B8">India-focused pet care</span>
          <h1>Calm, clear care for the dogs and cats who trust you.</h1>
          <p>
            Daily routines, vaccine records, food-safety checks and a cautious AI assistant —
            with verified veterinarians one tap away.
          </p>
        </div>
        <ul class="auth-points">
          <li><span aria-hidden="true">🐶</span><span><b>Know what is due.</b> Feeding, grooming and vaccination reminders stay off until you opt in.</span></li>
          <li><span aria-hidden="true">🐱</span><span><b>Safety first.</b> Emergency red flags are checked before any AI answer.</span></li>
          <li><span aria-hidden="true">🩺</span><span><b>No invented diagnoses.</b> Limited coverage is stated plainly, with a referral.</span></li>
        </ul>
        <p class="auth-pets">
          <span aria-hidden="true">🐕</span><span aria-hidden="true">🐈</span>
          Built for dogs, cats and the people who love them.
        </p>
        <p class="small" style="opacity:.75;position:relative">
          Not a substitute for a veterinary examination. Hospital listings come from community maps; always call ahead.
        </p>
      </section>

      <section class="auth-form-side">
        <div class="auth-card">
          <div class="cat-peek" [class.watching]="focused()" aria-hidden="true">
            <svg class="cat-svg" viewBox="0 0 170 154" focusable="false">
              <defs>
                <clipPath id="mimi-head"><ellipse cx="85" cy="76" rx="57" ry="48" /></clipPath>
              </defs>

              <!-- ears: white on the left, black on the right -->
              <path d="M40 48 L44 6 L78 32 Z" fill="#FFFFFF" stroke="#2E2A28" stroke-width="3" stroke-linejoin="round" />
              <path d="M130 48 L126 6 L92 32 Z" fill="#2E2A28" stroke="#2E2A28" stroke-width="3" stroke-linejoin="round" />
              <path d="M49 38 L52 20 L66 32 Z" fill="#F3B9BE" />
              <path d="M121 38 L118 20 L104 32 Z" fill="#8C6F6B" />

              <g class="cat-head">
                <g clip-path="url(#mimi-head)">
                  <ellipse cx="85" cy="76" rx="57" ry="48" fill="#FFFFFF" />
                  <!-- black tuxedo mark: runs down from the black ear, over the right eye -->
                  <ellipse cx="122" cy="58" rx="36" ry="34" fill="#2E2A28" />
                  <!-- soft shading under the chin so a white face still has shape -->
                  <ellipse cx="85" cy="120" rx="48" ry="24" fill="#EFE6DC" opacity=".5" />
                </g>
                <ellipse cx="85" cy="76" rx="57" ry="48" fill="none" stroke="#2E2A28" stroke-width="3" />

                <!-- eyes -->
                <g class="cat-eyes">
                  <ellipse cx="65" cy="73" rx="12" ry="13" fill="#FFFAF0" />
                  <circle cx="65" cy="74" r="8.5" fill="#5F8F4C" />
                  <ellipse cx="65" cy="74" rx="3.6" ry="9" fill="#2B1D14" />
                  <circle cx="68" cy="68" r="2.6" fill="#fff" />
                  <ellipse cx="105" cy="73" rx="12" ry="13" fill="#FFFAF0" />
                  <circle cx="105" cy="74" r="8.5" fill="#4F86A8" />
                  <ellipse cx="105" cy="74" rx="3.6" ry="9" fill="#2B1D14" />
                  <circle cx="108" cy="68" r="2.6" fill="#fff" />
                </g>
                <!-- muzzle -->
                <ellipse cx="85" cy="95" rx="25" ry="16" fill="#FBF1E6" />
                <path d="M78 90 c0-3 14-3 14 0 s-7 8 -7 8 -7-5 -7-8 z" fill="#D97B79" />
                <path d="M85 98 q-2 8 -9 6 M85 98 q2 8 9 6" fill="none" stroke="#8A7A70" stroke-width="2.4" stroke-linecap="round" />
                <!-- whiskers: dark on the white side, pale on the black side -->
                <g stroke="#6C625B" stroke-width="2" stroke-linecap="round" opacity=".85">
                  <path d="M50 86 L16 79" />
                  <path d="M50 95 L13 95" />
                  <path d="M50 103 L17 108" />
                </g>
                <g stroke="#F3E9DE" stroke-width="2" stroke-linecap="round" opacity=".9">
                  <path d="M120 86 L154 79" />
                  <path d="M120 95 L157 95" />
                  <path d="M120 103 L153 108" />
                </g>
                <ellipse cx="49" cy="96" rx="8" ry="5" fill="#F6B5BB" opacity=".5" />
              </g>

              <!-- left paw, resting on the card edge -->
              <g>
                <ellipse cx="62" cy="137" rx="21" ry="15" fill="#FFFFFF" stroke="#2E2A28" stroke-width="2.6" />
                <g stroke="#8A7E76" stroke-width="2" stroke-linecap="round" opacity=".6">
                  <path d="M53 129 v8" />
                  <path d="M62 127 v10" />
                  <path d="M71 129 v8" />
                </g>
              </g>

              <!-- right paw: the one that taps along as you type -->
              @if (strikeId() === 0) {
                <g>
                  <ellipse cx="108" cy="137" rx="21" ry="15" fill="#FFFFFF" stroke="#2E2A28" stroke-width="2.6" />
                  <g stroke="#8A7E76" stroke-width="2" stroke-linecap="round" opacity=".6">
                    <path d="M99 129 v8" />
                    <path d="M108 127 v10" />
                    <path d="M117 129 v8" />
                  </g>
                </g>
              }
              @for (s of [strikeId()]; track s) {
                @if (s > 0) {
                  <g class="paw-swing">
                    <ellipse cx="108" cy="137" rx="21" ry="15" fill="#FFFFFF" stroke="#2E2A28" stroke-width="2.6" />
                    <g stroke="#8A7E76" stroke-width="2" stroke-linecap="round" opacity=".6">
                      <path d="M99 129 v8" />
                      <path d="M108 127 v10" />
                      <path d="M117 129 v8" />
                    </g>
                  </g>
                }
              }
            </svg>

            @for (s of [strikeId()]; track s) {
              @if (s > 0) {
                <span class="cat-smack">🐾</span>
              }
            }
          </div>

          <div class="cat-line" aria-hidden="true">{{ catLine() }}</div>

          <span class="eyebrow">Welcome back</span>
          <h2>Sign in to Pet Vet AI</h2>
          <p class="muted small mb-0">Your pets, records and care plan in one place.</p>

          @if (error()) {
            <div class="banner banner-danger mt-2" role="alert">
              <span class="banner-icon">⚠️</span>
              <div><strong>Could not sign in</strong><p>{{ error() }}</p></div>
            </div>
          }

          <form [formGroup]="form" (ngSubmit)="submit()" class="stack" style="margin-top:1rem" novalidate>
            <mat-form-field appearance="outline">
              <mat-label>Email address</mat-label>
              <input
                matInput
                type="email"
                formControlName="email"
                autocomplete="email"
                placeholder="you@example.com"
                (focus)="focused.set(true)"
                (blur)="focused.set(false)"
              />
              @if (form.controls.email.touched && form.controls.email.invalid) {
                <mat-error>Enter a valid email address</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Password</mat-label>
              <input
                matInput
                [type]="showPassword() ? 'text' : 'password'"
                formControlName="password"
                autocomplete="current-password"
                (focus)="focused.set(true)"
                (blur)="focused.set(false)"
              />
              <button
                mat-icon-button
                matSuffix
                type="button"
                class="password-toggle"
                (click)="showPassword.set(!showPassword())"
                [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
                [attr.aria-pressed]="showPassword()"
                [title]="showPassword() ? 'Hide password' : 'Show password'"
              >
                <span aria-hidden="true">{{ showPassword() ? '🙈' : '👁️' }}</span>
              </button>
              @if (form.controls.password.touched && form.controls.password.invalid) {
                <mat-error>Password is required</mat-error>
              }
            </mat-form-field>

            <p class="small" style="margin:-.35rem 0 0;text-align:right">
              <a routerLink="/forgot-password">Forgot your password?</a>
            </p>

            <button mat-flat-button color="primary" type="submit" class="w-full" [disabled]="loading()">
              @if (loading()) { <span class="spinner" style="border-top-color:#fff"></span> }
              {{ loading() ? 'Signing in…' : 'Sign in' }}
            </button>
          </form>

          <p class="small muted mt-2">
            New here? <a routerLink="/register">Create an owner or veterinarian account</a>.
          </p>

        </div>
      </section>
    </div>
  `,
  styles: [
    `
      .cat-peek {
        position: absolute;
        top: -112px;
        right: -8px;
        width: 152px;
        height: 138px;
        z-index: 3;
        pointer-events: none;
      }
      .cat-svg { width: 100%; height: 100%; display: block; overflow: visible; }
      .cat-head {
        transform-box: fill-box;
        transform-origin: center;
        transition: transform 0.4s ease;
      }
      .cat-peek.watching .cat-head { transform: translateY(5px) rotate(-2deg); }
      .cat-eyes {
        transform-box: fill-box;
        transform-origin: center;
        animation: cat-blink 6.5s ease-in-out infinite;
      }
      .paw-swing {
        transform-box: fill-box;
        transform-origin: 55% 12%;
        animation: paw-tap 0.45s cubic-bezier(0.3, 1.3, 0.5, 1) both;
      }
      .cat-smack {
        position: absolute;
        right: 4px;
        bottom: -2px;
        font-size: 0.9rem;
        animation: smack 0.5s ease-out both;
      }
      .cat-line {
        position: absolute;
        top: 14px;
        left: 1.1rem;
        right: 112px;
        padding: 0.45rem 0.65rem;
        border-radius: 14px;
        background: var(--honey-soft);
        border: 1px solid #f3d8af;
        color: var(--ink-soft);
        font-size: 0.74rem;
        line-height: 1.4;
        font-weight: 600;
      }
      .cat-line::after {
        content: '';
        position: absolute;
        right: -6px;
        top: 16px;
        width: 11px;
        height: 11px;
        background: inherit;
        border-top: 1px solid #f3d8af;
        border-right: 1px solid #f3d8af;
        transform: rotate(45deg);
      }
      @keyframes paw-tap {
        0% { transform: translateY(0) rotate(0); }
        35% { transform: translateY(-15px) rotate(-16deg); }
        58% { transform: translateY(9px) rotate(7deg); }
        78% { transform: translateY(1px) rotate(-3deg); }
        100% { transform: translateY(0) rotate(0); }
      }
      @keyframes cat-blink {
        0%, 92%, 100% { transform: scaleY(1); }
        95% { transform: scaleY(0.12); }
      }
      @keyframes smack {
        0% { opacity: 0; transform: translate(0, -8px) scale(0.5) rotate(-20deg); }
        45% { opacity: 1; transform: translate(6px, 4px) scale(1.15) rotate(8deg); }
        100% { opacity: 0; transform: translate(12px, 14px) scale(0.9) rotate(20deg); }
      }
      @media (max-width: 520px) {
        .cat-line {
          left: 0.75rem;
          right: 96px;
          font-size: 0.7rem;
        }
        .cat-peek { width: 128px; height: 116px; top: -94px; }
      }
    `,
  ],
})
export class LoginComponent {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);
  private api = inject(ApiService);

  readonly loading = signal(false);
  readonly error = signal('');
  readonly showPassword = signal(false);
  readonly focused = signal(false);

  /** words the owner has typed so far — drives the cat's commentary */
  readonly typedWords = signal(0);
  /** increments on every keystroke; the template keys the paw on it so the tap replays */
  readonly strikeId = signal(0);


  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(1)]],
  });

  readonly catLine = computed(() => {
    if (this.error()) return 'Mrrow. That did not go through — check the email and password?';
    if (this.loading()) return 'Sniffing out your account…';
    const words = this.typedWords();
    if (words === 0) return "Hi, I'm Mimi. Every key press gets a paw tap.";
    if (words === 1) return 'Boop! One word down.';
    if (words < 5) return `${words} words — nice rhythm.`;
    return "You're quick! My paw needs a break.";
  });

  constructor() {
    this.form.valueChanges.subscribe(() => this.reactToTyping());
  }

  /** every key press makes the cat tap; the word count feeds her commentary */
  private reactToTyping(): void {
    const { email, password } = this.form.getRawValue();
    const words = wordCount(email) + wordCount(password);
    this.strikeId.update((n) => n + 1);
    this.typedWords.set(words);
  }

  submit(): void {
    this.error.set('');
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.loading.set(true);
    const { email, password } = this.form.getRawValue();
    this.auth.login(email, password).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.user.role === 'vet') this.router.navigate(['/vet']);
        else if (res.user.role === 'admin') this.router.navigate(['/admin']);
        else this.router.navigate(['/dashboard']);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(ApiService.message(err));
      },
    });
  }
}

/** counts word starts, so emails and passwords count as several words ("priya@petvetai.demo" → 3) */
function wordCount(value: string): number {
  return (value.match(/[A-Za-z0-9]+/g) ?? []).length;
}
