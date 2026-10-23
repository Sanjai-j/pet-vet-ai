import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../core/api.service';
import { FoodItem } from '../core/models';

@Component({
  selector: 'app-food-safety',
  standalone: true,
  imports: [FormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    <div class="page page-narrow">
      <div class="page-head">
        <div>
          <span class="eyebrow">Food safety</span>
          <h1>Can my pet eat this?</h1>
          <p>A cautious lookup over a curated demo dataset. “Not listed” never means safe.</p>
        </div>
        <a mat-stroked-button routerLink="/ai">Ask Pet Vet AI</a>
      </div>

      <div class="card raised">
        <div class="form-grid">
          <mat-form-field appearance="outline">
            <mat-label>Species</mat-label>
            <mat-select [(ngModel)]="species" (ngModelChange)="search()">
              <mat-option value="dog">🐕 Dog</mat-option>
              <mat-option value="cat">🐈 Cat</mat-option>
              <mat-option value="bird">🦜 Bird</mat-option>
              <mat-option value="cow">🐄 Cow</mat-option>
              <mat-option value="goat">🐐 Goat</mat-option>
              <mat-option value="other">🐾 Other</mat-option>
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Food or ingredient</mat-label>
            <input matInput [(ngModel)]="query" (keydown.enter)="search()" placeholder="e.g. chocolate, grapes, milk" />
          </mat-form-field>
        </div>
        <div class="row">
          <button class="btn btn-primary" type="button" [disabled]="loading() || !query.trim()" (click)="search()">
            {{ loading() ? 'Checking…' : 'Check safety' }}
          </button>
          @for (quick of quickFoods; track quick) {
            <button class="chip" type="button" (click)="quickSearch(quick)">{{ quick }}</button>
          }
        </div>
      </div>

      @if (note()) {
        <div class="banner" [class.banner-warn]="!results().length" [class.banner-info]="results().length" style="margin-top:1rem">
          <span class="banner-icon">ℹ️</span>
          <div><strong>{{ results().length ? 'Demo safety dataset' : 'Not in the curated dataset' }}</strong><p>{{ note() }}</p></div>
        </div>
      }

      <div class="stack mt-2">
        @for (item of results(); track item.id) {
          <div class="card food-result" [class.food-toxic]="item.safety === 'toxic'" [class.food-caution]="item.safety === 'caution'" [class.food-safe]="item.safety === 'safe'" [class.food-unknown]="item.safety === 'unknown'">
            <div class="row" style="justify-content:space-between">
              <h3 style="margin:0">{{ item.name }}</h3>
              <span class="badge"
                [class.badge-danger]="item.safety === 'toxic'"
                [class.badge-warn]="item.safety === 'caution'"
                [class.badge-ok]="item.safety === 'safe'"
                [class.badge-neutral]="item.safety === 'unknown'">
                {{ safetyLabel(item.safety) }}
              </span>
            </div>
            <p class="small" style="margin:.5rem 0 .3rem">{{ item.notes }}</p>
            <p class="tiny muted mb-0">{{ item.sourceNote }} · {{ item.isDemo ? 'Synthetic demo entry' : 'Curated entry' }}</p>
            @if (item.safety === 'toxic') {
              <div class="banner banner-danger" style="margin-top:.7rem">
                <span class="banner-icon">⚠️</span>
                <div><strong>Contact a veterinarian now</strong><p>Do not wait for symptoms. Keep the packaging and record the estimated amount eaten.</p></div>
              </div>
            }
          </div>
        }
      </div>

      <div class="split mt-3">
        <div class="card">
          <h3>What this tool does not do</h3>
          <ul class="small muted" style="margin:0;padding-left:1.1rem">
            <li>It does not calculate a toxic dose for your pet's weight.</li>
            <li>It does not know your pet's individual health conditions.</li>
            <li>“Safe” means generally tolerated in small amounts — not a complete diet.</li>
            <li>Coverage for birds, cattle and goats is deliberately limited.</li>
          </ul>
        </div>
        <div class="banner banner-warn">
          <span class="banner-icon">🚨</span>
          <div>
            <strong>If ingestion already happened</strong>
            <p>Contact your veterinarian or nearest 24×7 veterinary hospital. Do not induce vomiting unless a veterinarian instructs you to.</p>
            <a routerLink="/find-care">Find veterinary care →</a>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class FoodSafetyComponent {
  private api = inject(ApiService);

  species = 'dog';
  query = '';
  readonly results = signal<FoodItem[]>([]);
  readonly note = signal('');
  readonly loading = signal(false);
  readonly quickFoods = ['chocolate', 'grapes', 'onion', 'milk', 'avocado'];

  quickSearch(food: string): void {
    this.query = food;
    this.search();
  }

  search(): void {
    if (!this.query.trim()) return;
    this.loading.set(true);
    this.api.get<any>('/food-safety', { species: this.species, q: this.query.trim() }).subscribe({
      next: (res) => {
        this.results.set(res.matches ?? []);
        this.note.set(res.note ?? '');
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  safetyLabel(safety: string): string {
    return safety === 'toxic' ? 'Toxic — avoid'
      : safety === 'caution' ? 'Caution'
      : safety === 'safe' ? 'Generally safe'
      : 'Unknown';
  }
}
