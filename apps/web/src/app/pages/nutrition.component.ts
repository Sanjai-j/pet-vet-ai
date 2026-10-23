import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../core/api.service';
import { ToastService } from '../core/toast.service';
import { Pet, PetNutritionProfile } from '../core/models';

@Component({
  selector: 'app-nutrition',
  standalone: true,
  imports: [FormsModule, DatePipe, RouterLink, MatFormFieldModule, MatSelectModule, MatButtonModule],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">Nutrition</span>
          <h1>Food guidance for your pet</h1>
          <p>Personalized from administrator-approved knowledge only. Recipes are treats or supplements unless a professional nutritional adequacy statement exists.</p>
        </div>
        <a mat-stroked-button routerLink="/food">Check a food ↗</a>
      </div>

      @if (!pets().length && !loading()) {
        <div class="card empty">
          <span class="empty-icon">🐾</span>
          <p>Add a pet first — guidance is filtered to that animal's species, age, allergies and conditions.</p>
          <a mat-flat-button color="primary" routerLink="/onboarding">Add a pet</a>
        </div>
      }

      @if (pets().length) {
        <div class="card raised">
          <div class="form-grid">
            <mat-form-field appearance="outline">
              <mat-label>Which pet?</mat-label>
              <mat-select [(ngModel)]="petId" (ngModelChange)="loadProfile()">
                @for (pet of pets(); track pet.id) {
                  <mat-option [value]="pet.id">{{ pet.speciesIcon }} {{ pet.name }} ({{ pet.speciesName }})</mat-option>
                }
              </mat-select>
            </mat-form-field>
          </div>
        </div>
      }

      @if (loading()) {
        <div class="empty mt-2"><span class="spinner"></span> Loading approved nutrition knowledge…</div>
      }

      @if (profile(); as p) {
        @if (p.emergencyNotice; as emergency) {
          <div class="banner banner-danger mt-2">
            <span class="banner-icon">⚠️</span>
            <div><strong>{{ emergency.title }}</strong><p>{{ emergency.body }}</p>
              <a routerLink="/find-care">Find veterinary care now →</a>
            </div>
          </div>
        }

        @if (p.livestock; as stock) {
          <div class="banner banner-warn mt-2">
            <span class="banner-icon">🌾</span>
            <div><strong>Feed plan required — quantities are not generated</strong><p>{{ stock.planNote }}</p></div>
          </div>
        }

        <div class="kpi-row mt-2">
          <div class="stat"><span class="stat-label">Life stage</span><span class="stat-value">{{ stageLabel(p.pet.lifeStage) }}</span></div>
          <div class="stat"><span class="stat-label">Approved guidance</span><span class="stat-value">{{ p.knowledge.approvedGuidanceCount }}</span></div>
          <div class="stat"><span class="stat-label">Approved hazards</span><span class="stat-value">{{ p.knowledge.approvedHazardCount }}</span></div>
          <div class="stat"><span class="stat-label">Approved recipes</span><span class="stat-value">{{ p.knowledge.approvedRecipeCount }}</span></div>
        </div>
        <p class="tiny muted mt-1">{{ p.knowledge.note }}</p>

        @if (p.missingInfo.length) {
          <div class="banner banner-warn mt-2">
            <span class="banner-icon">📋</span>
            <div>
              <strong>Some guidance is withheld until this is recorded</strong>
              <ul class="small" style="margin:.4rem 0 0;padding-left:1.1rem">
                @for (item of p.missingInfo; track item) { <li>{{ item }}</li> }
              </ul>
              <a [routerLink]="['/pets', p.pet.id]">Update {{ p.pet.name }}'s profile →</a>
            </div>
          </div>
        }

        @if (p.guidance.length) {
          <h2 class="mt-3">Dietary guidance</h2>
          <div class="stack mt-1">
            @for (g of p.guidance; track g.id) {
              <div class="card">
                <div class="row" style="justify-content:space-between">
                  <h3 style="margin:0">{{ g.nutritionGoal || 'General nutrition' }}</h3>
                  <span class="badge badge-neutral">{{ g.lifeStage === 'all' ? 'All life stages' : stageLabel(g.lifeStage) }}</span>
                </div>
                <p class="small" style="white-space:pre-wrap">{{ g.generalDietGuidance }}</p>
                @if (g.suitableFoodsText) {
                  <div class="stat-label">Suitable foods</div>
                  <p class="small" style="white-space:pre-wrap">{{ g.suitableFoodsText }}</p>
                }
                @if (g.hazardsToAvoidText) {
                  <div class="stat-label">Foods to avoid</div>
                  <p class="small" style="white-space:pre-wrap">{{ g.hazardsToAvoidText }}</p>
                }
                @if (g.goalSpecificGuidance) {
                  <div class="stat-label">Specific to this goal</div>
                  <p class="small" style="white-space:pre-wrap">{{ g.goalSpecificGuidance }}</p>
                }
                @if (g.safetyCautions) {
                  <div class="banner banner-warn" style="margin-top:.5rem">
                    <span class="banner-icon">🛡️</span>
                    <div><strong>Cautions</strong><p>{{ g.safetyCautions }}</p></div>
                  </div>
                }
                @if (g.allergenWarnings.length) {
                  <div class="banner banner-danger" style="margin-top:.5rem">
                    <span class="banner-icon">🚫</span>
                    <div><strong>Conflicts with recorded allergies or restrictions</strong>
                      <p>Mentions: {{ g.allergenWarnings.join(', ') }}. Confirm with your veterinarian before feeding.</p>
                    </div>
                  </div>
                }
                <p class="tiny muted mb-0">
                  @if (g.sourceUrl) { <a [href]="g.sourceUrl" target="_blank" rel="noopener">Source ↗</a> · }
                  v{{ g.version }}@if (g.reviewedAt) { · reviewed {{ g.reviewedAt | date: 'mediumDate' }} }
                </p>
              </div>
            }
          </div>
        }

        @if (p.healthRules.length) {
          <h2 class="mt-3">Rules for recorded conditions</h2>
          <div class="stack mt-1">
            @for (rule of p.healthRules; track rule.id) {
              <div class="card">
                <div class="row" style="justify-content:space-between">
                  <h3 style="margin:0">{{ rule.conditionOrGoal }}</h3>
                  <span class="badge badge-warn">Matched: {{ rule.matchedOn.join(', ') }}</span>
                </div>
                <p class="small" style="white-space:pre-wrap">{{ rule.generalGuidance }}</p>
                <p class="small"><strong>Safety rule:</strong> {{ rule.safetyRule }}</p>
                @if (rule.referralRule) { <p class="small muted">When to refer: {{ rule.referralRule }}</p> }
              </div>
            }
          </div>
        }

        <div class="split mt-3">
          <div>
            <h2> Foods to avoid</h2>
            @if (!p.hazardCoverageKnown) {
              <div class="banner banner-warn" style="margin-top:.6rem">
                <span class="banner-icon">❓</span>
                <div><strong>Safety is unknown for this species</strong>
                  <p>No approved hazard records exist yet. Absence of records does not mean a food is safe — ask a veterinarian.</p></div>
              </div>
            }
            <div class="stack mt-1">
              @for (h of p.hazards; track h.id) {
                <div class="card" [class.food-toxic]="h.severity === 'toxic'" [class.food-caution]="h.severity === 'caution'">
                  <div class="row" style="justify-content:space-between">
                    <h3 style="margin:0">{{ h.foodOrSubstance }}</h3>
                    <span class="badge"
                      [class.badge-danger]="h.severity === 'toxic' || h.severity === 'dangerous' || h.severity === 'potentially_toxic'"
                      [class.badge-warn]="h.severity === 'caution'"
                      [class.badge-neutral]="h.severity === 'unknown' || h.severity === 'nutritionally_inappropriate'">
                      {{ severityLabel(h.severity) }}
                    </span>
                  </div>
                  <p class="small" style="margin:.5rem 0 .3rem"><strong>Risk:</strong> {{ h.risk }}</p>
                  <p class="small" style="margin:.3rem 0"><strong>What to do:</strong> {{ h.recommendedAction }}</p>
                  <p class="tiny muted mb-0">
                    {{ h.classification }}
                    @if (h.sourceUrl) { · <a [href]="h.sourceUrl" target="_blank" rel="noopener">Source ↗</a> }
                    · v{{ h.version }}
                  </p>
                </div>
              }
            </div>
            @if (!p.hazards.length && p.hazardCoverageKnown) {
              <div class="empty"><span class="empty-icon">✅</span>No approved hazard records list a food for this species.</div>
            }
          </div>

          <div>
            <h2>Recipes</h2>
            <p class="tiny muted">Every recipe below is a treat or supplementary food unless a validated nutritional adequacy statement exists. It does not replace a complete and balanced diet.</p>
            <div class="stack mt-1">
              @for (r of p.recipes; track r.id) {
                <div class="card">
                  <div class="row" style="justify-content:space-between">
                    <h3 style="margin:0">{{ r.recipeName }}</h3>
                    <span class="badge" [class.badge-teal]="!r.isSupplementary" [class.badge-warn]="r.isSupplementary">
                      {{ r.isSupplementary ? 'Treat / supplement' : 'Complete diet (validated)' }}
                    </span>
                  </div>
                  <div class="tiny muted">{{ r.dietRole }} · {{ r.applicability }}</div>

                  <div class="stat-label mt-1">Ingredients</div>
                  <ul class="small" style="margin:.2rem 0;padding-left:1.2rem">
                    @for (ing of r.ingredients; track ing) { <li>{{ ing }}</li> }
                  </ul>

                  <div class="stat-label">Preparation</div>
                  <ol class="small" style="margin:.2rem 0;padding-left:1.3rem">
                    @for (step of r.steps; track step) { <li>{{ step }}</li> }
                  </ol>

                  <div class="stat-label">Storage</div>
                  <p class="small" style="margin:.2rem 0">{{ r.storageNote }}</p>

                  <p class="small"><strong>Safety notes:</strong> {{ r.safetyNotes }}</p>

                  @if (r.allergenWarnings.length) {
                    <div class="banner banner-danger" style="margin-top:.5rem">
                      <span class="banner-icon">🚫</span>
                      <div><strong>Contains recorded allergens or restricted items</strong>
                        <p>{{ r.allergenWarnings.join(', ') }} — do not feed without veterinary confirmation.</p></div>
                    </div>
                  }
                  @if (r.completeDietWarning) {
                    <div class="banner banner-warn" style="margin-top:.5rem">
                      <span class="banner-icon">⚖️</span>
                      <div><strong>Not a complete diet</strong><p>{{ r.completeDietWarning }}</p></div>
                    </div>
                  }
                  <p class="tiny muted mb-0">v{{ r.version }}@if (r.reviewedAt) { · reviewed {{ r.reviewedAt | date: 'mediumDate' }} }</p>
                </div>
              }
              @if (!p.recipes.length) {
                <div class="empty"><span class="empty-icon">🍲</span>No approved recipes are published for this species yet.</div>
              }
            </div>
          </div>
        </div>

        <div class="split mt-3">
          <div class="card">
            <h3>Breed context</h3>
            <p class="small">{{ p.breedContext.note }}</p>
            @if (p.breedContext.applied && p.breedContext.guidance; as bg) {
              <p class="small">{{ bg.generalGuidance }}</p>
              <p class="tiny muted"><strong>Limitation:</strong> {{ bg.limitation }}</p>
              @if (bg.referralRule) { <p class="tiny muted"><strong>Referral:</strong> {{ bg.referralRule }}</p> }
            }
          </div>
          <div class="banner banner-info">
            <span class="banner-icon">ℹ️</span>
            <div><strong>Educational guidance, not a prescription</strong><p>{{ p.disclaimer }}</p>
              <p>For disease, allergies, growth, pregnancy/lactation or persistent symptoms, ask a veterinarian for an individualized plan.</p>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class NutritionComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  readonly pets = signal<Pet[]>([]);
  readonly profile = signal<PetNutritionProfile | null>(null);
  readonly loading = signal(false);
  petId = '';

  ngOnInit(): void {
    this.api.get<{ pets: Pet[] }>('/pets').subscribe({
      next: (res) => {
        this.pets.set(res.pets ?? []);
        if (res.pets?.length) {
          this.petId = res.pets[0].id;
          this.loadProfile();
        }
      },
      error: (err) => this.toast.error(err),
    });
  }

  loadProfile(): void {
    if (!this.petId) return;
    this.loading.set(true);
    this.profile.set(null);
    this.api.get<PetNutritionProfile>(`/pets/${this.petId}/nutrition`).subscribe({
      next: (p) => {
        this.profile.set(p);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(err);
      },
    });
  }

  stageLabel(stage: string): string {
    return stage === 'young' ? 'Young'
      : stage === 'adult' ? 'Adult'
      : stage === 'senior' ? 'Senior'
      : stage === 'unknown' ? 'Unknown'
      : 'All life stages';
  }

  severityLabel(severity: string): string {
    return severity === 'toxic' ? 'Toxic — avoid'
      : severity === 'potentially_toxic' ? 'Potentially toxic'
      : severity === 'dangerous' ? 'Dangerous'
      : severity === 'caution' ? 'Caution'
      : severity === 'nutritionally_inappropriate' ? 'Not appropriate to feed'
      : 'Unknown safety';
  }
}
