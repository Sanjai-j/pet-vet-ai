import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class ToastService {
  private snack = inject(MatSnackBar);

  success(message: string): void {
    this.snack.open(message, 'Dismiss', { duration: 4200, panelClass: ['toast-success'] });
  }

  info(message: string): void {
    this.snack.open(message, 'Dismiss', { duration: 4500, panelClass: ['toast-info'] });
  }

  error(err: unknown): void {
    this.snack.open(ApiService.message(err), 'Dismiss', {
      duration: 6500,
      panelClass: ['toast-error'],
    });
  }
}
