import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, tap } from 'rxjs';
import { User } from './models';

const TOKEN_KEY = 'petvet_token';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);

  private tokenState = signal<string | null>(localStorage.getItem(TOKEN_KEY));
  private userState = signal<User | null>(null);
  private loadingState = signal(Boolean(localStorage.getItem(TOKEN_KEY)));

  readonly token = this.tokenState.asReadonly();
  readonly user = this.userState.asReadonly();
  readonly loading = this.loadingState.asReadonly();
  readonly isLoggedIn = computed(() => Boolean(this.tokenState()));
  readonly isOwner = computed(() => this.userState()?.role === 'owner');
  readonly isVet = computed(() => this.userState()?.role === 'vet');
  readonly isAdmin = computed(() => this.userState()?.role === 'admin');

  constructor() {
    if (this.tokenState()) {
      this.refresh().subscribe({
        error: () => this.clearSession(),
        complete: () => this.loadingState.set(false),
      });
    }
  }

  login(email: string, password: string): Observable<{ token: string; user: User }> {
    return this.http
      .post<{ token: string; user: User }>('/api/auth/login', { email, password })
      .pipe(tap((res) => this.setSession(res)));
  }

  register(payload: Record<string, unknown>): Observable<{ token: string; user: User }> {
    return this.http
      .post<{ token: string; user: User }>('/api/auth/register', payload)
      .pipe(tap((res) => this.setSession(res)));
  }

  refresh(): Observable<{ user: User }> {
    return this.http
      .get<{ user: User }>('/api/auth/me')
      .pipe(tap((res) => this.userState.set(res.user)));
  }

  updateProfile(body: Record<string, unknown>): Observable<{ user: User }> {
    return this.http
      .patch<{ user: User }>('/api/auth/me', body)
      .pipe(tap((res) => this.userState.set(res.user)));
  }

  updateNotificationPrefs(prefs: Record<string, boolean>): Observable<{ notificationPrefs: Record<string, boolean> }> {
    return this.http
      .patch<{ notificationPrefs: Record<string, boolean> }>('/api/auth/me/notifications', prefs)
      .pipe(
        tap((res) => {
          const current = this.userState();
          if (current) this.userState.set({ ...current, notificationPrefs: res.notificationPrefs });
        }),
      );
  }

  setSession(res: { token: string; user: User }): void {
    localStorage.setItem(TOKEN_KEY, res.token);
    this.tokenState.set(res.token);
    this.userState.set(res.user);
    this.loadingState.set(false);
  }

  clearSession(): void {
    localStorage.removeItem(TOKEN_KEY);
    this.tokenState.set(null);
    this.userState.set(null);
    this.loadingState.set(false);
  }

  logout(navigate = true): void {
    this.clearSession();
    if (navigate) this.router.navigate(['/login']);
  }

  initials(): string {
    const name = this.userState()?.fullName ?? '';
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('');
  }
}
