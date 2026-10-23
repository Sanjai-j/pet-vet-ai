import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from './core/auth.service';
import { ApiService } from './core/api.service';
import { WsService } from './core/ws.service';

interface NavLink {
  path: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatButtonModule],
  template: `
    <header class="app-header">
      <div class="header-inner">
        <a class="brand" [routerLink]="auth.user() ? '/dashboard' : '/login'" aria-label="Pet Vet AI home">
          <span class="brand-mark" aria-hidden="true">🐾</span>
          <span>Pet Vet AI<small>Care · records · vets</small></span>
        </a>

        @if (auth.user()) {
          <nav class="desktop-nav" aria-label="Primary navigation">
            @for (link of nav(); track link.path) {
              <a [routerLink]="link.path" routerLinkActive="active">{{ link.label }}</a>
            }
          </nav>
        }

        <div class="header-right">
          @if (auth.user()) {
            <span class="role-chip">{{ roleLabel() }}</span>
            <button
              class="avatar-btn"
              type="button"
              (click)="notificationsOpen.set(!notificationsOpen())"
              [attr.aria-label]="'Notifications, ' + unread() + ' unread'"
              title="Notifications"
            >
              🔔
              @if (unread() > 0) {
                <span class="badge badge-danger" style="margin-left:-6px">{{ unread() }}</span>
              }
            </button>
            <a class="avatar-btn" routerLink="/settings" [attr.aria-label]="'Account settings for ' + auth.user()?.fullName">
              {{ auth.initials() }}
            </a>
            <button class="icon-btn" type="button" (click)="logout()" aria-label="Sign out" title="Sign out">⏻</button>
            <button class="icon-btn mobile-toggle" type="button" (click)="menuOpen.set(!menuOpen())" aria-label="Toggle navigation">
              ☰
            </button>
          } @else {
            <a mat-flat-button color="primary" routerLink="/login">Sign in</a>
          }
        </div>
      </div>

      @if (auth.user() && menuOpen()) {
        <nav class="mobile-nav" aria-label="Mobile navigation">
          @for (link of nav(); track link.path) {
            <a [routerLink]="link.path" routerLinkActive="active" (click)="menuOpen.set(false)">
              {{ link.icon }} {{ link.label }}
            </a>
          }
        </nav>
      }

      @if (auth.user() && notificationsOpen()) {
        <div class="mobile-nav" style="display:block" aria-label="Notifications">
          <div class="row" style="justify-content:space-between;padding:.4rem">
            <strong>Notifications</strong>
            <button class="btn btn-ghost btn-sm" type="button" (click)="markAllRead()">Mark all read</button>
          </div>
          @if (!recentNotifications().length) {
            <p class="small muted" style="padding:.5rem">No notifications yet. Reminders appear here after you opt in.</p>
          }
          @for (n of recentNotifications(); track n.id) {
            <div class="card tight" style="margin:.35rem 0">
              <div class="row" style="justify-content:space-between">
                <strong style="font-size:.84rem">{{ n.title }}</strong>
                <span class="badge" [class.badge-teal]="!n.readAt">{{ n.kind }}</span>
              </div>
              <p class="small muted" style="margin:.2rem 0 0">{{ n.body }}</p>
            </div>
          }
        </div>
      }
    </header>

    <main class="app-main">
      <router-outlet />
    </main>

    <footer class="app-footer">
      <span>
        <strong>Pet Vet AI</strong> — general information and care coordination, not a veterinary diagnosis.
      </span>
      <span>
        Hospital listings come from community maps and are not verifications. AI answers cite approved references
        and never replace an examination.
      </span>
    </footer>
  `,
})
export class AppComponent {
  readonly auth = inject(AuthService);
  readonly ws = inject(WsService);
  private api = inject(ApiService);
  private notifTimer: ReturnType<typeof setInterval> | null = null;

  readonly menuOpen = signal(false);
  readonly notificationsOpen = signal(false);
  readonly unread = signal(0);
  readonly recentNotifications = signal<any[]>([]);

  readonly nav = computed<NavLink[]>(() => {
    const role = this.auth.user()?.role;
    if (role === 'vet') {
      return [
        { path: '/dashboard', label: 'Overview', icon: '🏠' },
        { path: '/vet', label: 'Practice', icon: '🩺' },
        { path: '/vet/apply', label: 'Verification', icon: '🛡️' },
        { path: '/appointments', label: 'Appointments', icon: '📅' },
        { path: '/messages', label: 'Messages', icon: '💬' },
        { path: '/settings', label: 'Settings', icon: '⚙️' },
      ];
    }
    if (role === 'admin') {
      return [
        { path: '/admin', label: 'Administration', icon: '🛡️' },
        { path: '/dashboard', label: 'Overview', icon: '🏠' },
        { path: '/settings', label: 'Settings', icon: '⚙️' },
      ];
    }
    return [
      { path: '/dashboard', label: 'Dashboard', icon: '🏠' },
      { path: '/ai', label: 'Pet Vet AI', icon: '🐾' },
      { path: '/nutrition', label: 'Nutrition', icon: '🍽️' },
      { path: '/food', label: 'Food safety', icon: '🥗' },
      { path: '/find-care', label: 'Find care', icon: '📍' },
      { path: '/appointments', label: 'Appointments', icon: '📅' },
      { path: '/messages', label: 'Messages', icon: '💬' },
      { path: '/settings', label: 'Settings', icon: '⚙️' },
    ];
  });

  readonly roleLabel = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'owner' ? 'Pet owner' : role === 'vet' ? 'Veterinarian' : role === 'admin' ? 'Administrator' : '';
  });

  constructor() {
    effect(() => {
      const user = this.auth.user();
      if (user) {
        this.ws.connect();
        this.refreshNotifications();
        if (!this.notifTimer) {
          this.notifTimer = setInterval(() => this.refreshNotifications(), 60_000);
        }
      } else {
        this.ws.disconnect();
        this.unread.set(0);
        this.recentNotifications.set([]);
        if (this.notifTimer) {
          clearInterval(this.notifTimer);
          this.notifTimer = null;
        }
      }
    });

    this.ws.notifications$.subscribe(() => this.refreshNotifications(true));
    this.ws.messages$.subscribe(() => this.refreshNotifications(true));
  }

  refreshNotifications(increment = false): void {
    if (!this.auth.user()) return;
    this.api.get<any>('/notifications').subscribe({
      next: (res) => {
        this.recentNotifications.set(res.notifications ?? []);
        this.unread.set(res.unread ?? 0);
        if (increment && res.unread) this.unread.set(Math.max(this.unread(), res.unread));
      },
    });
  }

  markAllRead(): void {
    this.api.post('/notifications/read-all', {}).subscribe({
      next: () => {
        this.unread.set(0);
        this.recentNotifications.update((items) => items.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      },
    });
  }

  logout(): void {
    this.ws.disconnect();
    this.auth.logout();
  }
}
