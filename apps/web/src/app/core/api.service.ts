import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, throwError } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Observable<T> {
    const query = params
      ? Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    return this.http
      .get<T>(`/api${path}${query ? `?${query}` : ''}`)
      .pipe(catchError((err) => this.fail(err)));
  }

  post<T>(path: string, body: unknown): Observable<T> {
    return this.http.post<T>(`/api${path}`, body).pipe(catchError((err) => this.fail(err)));
  }

  patch<T>(path: string, body: unknown): Observable<T> {
    return this.http.patch<T>(`/api${path}`, body).pipe(catchError((err) => this.fail(err)));
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.http.put<T>(`/api${path}`, body).pipe(catchError((err) => this.fail(err)));
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(`/api${path}`).pipe(catchError((err) => this.fail(err)));
  }

  upload(path: string, form: FormData): Observable<any> {
    return this.http.post(`/api${path}`, form).pipe(catchError((err) => this.fail(err)));
  }

  fileUrl(fileId: string): string {
    return `/api/files/${fileId}`;
  }

  private fail(err: HttpErrorResponse) {
    if (err.status === 0) {
      return throwError(() => new Error('Cannot reach the Pet Vet AI server. Check that the API is running.'));
    }
    const message =
      err.error?.error?.message ||
      err.error?.message ||
      (err.status === 401 ? 'Your session has expired. Please sign in again.' : 'Something went wrong.');
    const details = err.error?.error?.details;
    const extra = Array.isArray(details) && details.length ? ` (${details.map((d: any) => d.message).join('; ')})` : '';
    return throwError(() => new Error(`${message}${extra}`));
  }

  static message(err: unknown): string {
    return err instanceof Error ? err.message : 'Something went wrong.';
  }
}
