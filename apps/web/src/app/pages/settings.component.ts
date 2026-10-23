import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatSlideToggleModule],
  template: `
    <div class="page page-narrow">
      <div class="page-head">
        <div>
          <span class="eyebrow">Settings</span>
          <h1>Your account</h1>
          <p>Control reminders, privacy and security. Nothing is shared unless you choose to share it.</p>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Profile</h3><p>Shown to veterinarians you contact.</p></div></div>
          <form [formGroup]="profileForm" (ngSubmit)="saveProfile()">
            <div class="form-grid">
              <mat-form-field appearance="outline"><mat-label>Full name</mat-label><input matInput formControlName="fullName" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Email</mat-label><input matInput [value]="auth.user()?.email" disabled /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Phone</mat-label><input matInput formControlName="phone" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>City</mat-label><input matInput formControlName="city" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>State</mat-label><input matInput formControlName="state" /></mat-form-field>
            </div>
            <div class="form-actions">
              <button mat-flat-button color="primary" type="submit" [disabled]="savingProfile()">Save profile</button>
            </div>
          </form>
        </div>

        @if (auth.isOwner()) {
          <div class="card">
            <div class="card-head"><div><h3>Care reminders</h3><p>Off by default. Feeding, grooming and vaccination reminders only start after you opt in.</p></div></div>
            <div class="switch-row">
              <div><strong>Feeding reminders</strong><p>Notify me when a feeding task is due. In-app only unless email or push is enabled.</p></div>
              <mat-slide-toggle [ngModel]="pref('feeding')" (ngModelChange)="setPref('feeding', $event)"></mat-slide-toggle>
            </div>
            <div class="switch-row">
              <div><strong>Grooming reminders</strong><p>Weekly coat and skin-check reminders based on your routine.</p></div>
              <mat-slide-toggle [ngModel]="pref('grooming')" (ngModelChange)="setPref('grooming', $event)"></mat-slide-toggle>
            </div>
            <div class="switch-row">
              <div><strong>Vaccination follow-ups</strong><p>Escalates up to 7 days before a documented next-due date. Never invents a schedule.</p></div>
              <mat-slide-toggle [ngModel]="pref('vaccination')" (ngModelChange)="setPref('vaccination', $event)"></mat-slide-toggle>
            </div>
          </div>
        }

        <div class="card">
          <div class="card-head"><div><h3>Channels</h3><p>In-app notifications are always available. Email and browser push require server configuration.</p></div></div>
          <div class="switch-row">
            <div><strong>In-app notifications</strong><p>Show reminders and appointment updates in the app.</p></div>
            <mat-slide-toggle [ngModel]="pref('inApp')" (ngModelChange)="setPref('inApp', $event)"></mat-slide-toggle>
          </div>
          <div class="switch-row">
            <div><strong>Email notifications</strong><p>{{ config()?.emailConfigured ? 'SMTP is configured on this server.' : 'SMTP is not configured on this server — email will not be delivered.' }}</p></div>
            <mat-slide-toggle [ngModel]="pref('email')" (ngModelChange)="setPref('email', $event)" [disabled]="!config()?.emailConfigured"></mat-slide-toggle>
          </div>
          <div class="switch-row">
            <div><strong>Browser push</strong><p>{{ config()?.pushConfigured ? 'Web push keys are configured. Enable the preference, then allow notifications in your browser.' : 'Push is not configured on this server (no VAPID keys).' }}</p></div>
            <mat-slide-toggle [ngModel]="pref('push')" (ngModelChange)="setPref('push', $event)" [disabled]="!config()?.pushConfigured"></mat-slide-toggle>
          </div>
          @if (config()?.pushConfigured) {
            <button mat-stroked-button (click)="requestPush()">Allow browser notifications</button>
          }
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Privacy</h3><p>Medical records are private by default and only shared for care.</p></div></div>
          <div class="switch-row">
            <div><strong>Share records with treating veterinarians</strong><p>Vets with an accepted appointment or conversation can view the pet record.</p></div>
            <mat-slide-toggle [ngModel]="privacy('shareRecordsWithVet')" (ngModelChange)="setPrivacy('shareRecordsWithVet', $event)"></mat-slide-toggle>
          </div>
          <div class="switch-row">
            <div><strong>Allow AI improvement use</strong><p>Off by default. This deployment does not train any model on your data.</p></div>
            <mat-slide-toggle [ngModel]="privacy('allowAiTraining')" (ngModelChange)="setPrivacy('allowAiTraining', $event)"></mat-slide-toggle>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Password</h3><p>Use at least 8 characters. You will stay signed in on this device.</p></div></div>
          <form [formGroup]="passwordForm" (ngSubmit)="changePassword()">
            <div class="form-grid">
              <mat-form-field appearance="outline"><mat-label>Current password</mat-label><input matInput type="password" formControlName="currentPassword" autocomplete="current-password" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>New password</mat-label><input matInput type="password" formControlName="newPassword" autocomplete="new-password" /></mat-form-field>
            </div>
            <div class="form-actions">
              <button mat-flat-button color="primary" type="submit" [disabled]="savingPassword()">Change password</button>
            </div>
          </form>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Server capabilities</h3><p>Honest status of optional integrations. No feature pretends to be connected when it is not.</p></div></div>
          <div class="cap-row"><span>AI mode</span><span class="badge" [class.badge-warn]="config()?.aiMode !== 'llm'" [class.badge-ok]="config()?.aiMode === 'llm'">{{ config()?.aiMode }}</span></div>
          <div class="cap-row"><span>Hospital search</span><span class="badge" [class.badge-ok]="config()?.nearbyConfigured" [class.badge-neutral]="!config()?.nearbyConfigured">{{ config()?.nearbyProvider === 'google_places' ? 'Google Places' : config()?.nearbyProvider === 'openstreetmap' ? 'OpenStreetMap (free)' : 'Off' }}</span></div>
          <div class="cap-row"><span>Email</span><span class="badge" [class.badge-ok]="config()?.emailConfigured" [class.badge-neutral]="!config()?.emailConfigured">{{ config()?.emailConfigured ? 'Configured' : 'Not configured' }}</span></div>
          <div class="cap-row"><span>Browser push</span><span class="badge" [class.badge-ok]="config()?.pushConfigured" [class.badge-neutral]="!config()?.pushConfigured">{{ config()?.pushConfigured ? 'Configured' : 'Not configured' }}</span></div>
          <div class="cap-row"><span>TURN relay</span><span class="badge" [class.badge-ok]="config()?.turnConfigured" [class.badge-warn]="!config()?.turnConfigured">{{ config()?.turnConfigured ? 'Configured' : 'STUN only' }}</span></div>
          <p class="tiny muted mt-1">Configure these through server environment variables. Keys are never exposed to the browser.</p>
        </div>

      </div>
    </div>
  `,
})
export class SettingsComponent implements OnInit {
  readonly auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private fb = inject(FormBuilder);

  readonly config = signal<any>(null);
  readonly savingProfile = signal(false);
  readonly savingPassword = signal(false);

  readonly profileForm = this.fb.nonNullable.group({
    fullName: ['', Validators.required],
    phone: [''],
    city: [''],
    state: [''],
  });

  readonly passwordForm = this.fb.nonNullable.group({
    currentPassword: ['', Validators.required],
    newPassword: ['', [Validators.required, Validators.minLength(8)]],
  });

  ngOnInit(): void {
    const user = this.auth.user();
    this.profileForm.patchValue({
      fullName: user?.fullName ?? '',
      phone: user?.phone ?? '',
      city: user?.city ?? '',
      state: user?.state ?? '',
    });
    this.api.get<any>('/config/public').subscribe({ next: (res) => this.config.set(res) });
  }

  pref(key: string): boolean {
    return this.auth.user()?.notificationPrefs?.[key] === true;
  }

  privacy(key: string): boolean {
    return this.auth.user()?.privacy?.[key] !== false;
  }

  setPref(key: string, value: boolean): void {
    this.auth.updateNotificationPrefs({ [key]: value }).subscribe({
      next: () => this.toast.success('Notification preference saved'),
      error: (err) => this.toast.error(err),
    });
  }

  setPrivacy(key: string, value: boolean): void {
    this.auth.updateProfile({ privacy: { [key]: value } }).subscribe({
      next: () => this.toast.success('Privacy preference saved'),
      error: (err) => this.toast.error(err),
    });
  }

  saveProfile(): void {
    if (this.profileForm.invalid) {
      this.profileForm.markAllAsTouched();
      return;
    }
    this.savingProfile.set(true);
    const v = this.profileForm.getRawValue();
    this.auth.updateProfile({
      fullName: v.fullName,
      phone: v.phone || null,
      city: v.city || null,
      state: v.state || null,
    }).subscribe({
      next: () => {
        this.savingProfile.set(false);
        this.toast.success('Profile updated');
      },
      error: (err) => {
        this.savingProfile.set(false);
        this.toast.error(err);
      },
    });
  }

  changePassword(): void {
    if (this.passwordForm.invalid) {
      this.passwordForm.markAllAsTouched();
      return;
    }
    this.savingPassword.set(true);
    const v = this.passwordForm.getRawValue();
    this.api.post('/auth/me/password', {
      currentPassword: v.currentPassword,
      newPassword: v.newPassword,
    }).subscribe({
      next: () => {
        this.savingPassword.set(false);
        this.passwordForm.reset({ currentPassword: '', newPassword: '' });
        this.toast.success('Password changed');
      },
      error: (err) => {
        this.savingPassword.set(false);
        this.toast.error(err);
      },
    });
  }

  async requestPush(): Promise<void> {
    if (!('Notification' in window)) {
      this.toast.info('This browser does not support notifications.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      this.toast.info('Notification permission was not granted.');
      return;
    }
    this.toast.info('Browser permission granted. A service worker and VAPID subscription are required to deliver push messages.');
  }
}
