import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { Breed, Pet, Species } from '../core/models';

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule,
    MatSelectModule, MatSlideToggleModule,
  ],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">First steps</span>
          <h1>Welcome to Pet Vet AI! Let's get to know your pet.</h1>
          <p>Nothing is assumed. Skip anything you don't know — you can update it later.</p>
        </div>
      </div>

      <div class="wizard-card card raised">
        <div class="wizard-steps" aria-label="Onboarding progress">
          <div class="wizard-step" [class.active]="step() === 0" [class.done]="step() > 0">1 · Species</div>
          <div class="wizard-step" [class.active]="step() === 1" [class.done]="step() > 1">2 · Breed</div>
          <div class="wizard-step" [class.active]="step() === 2">3 · About your pet</div>
        </div>

        @if (error()) {
          <div class="banner banner-danger" role="alert" style="margin-bottom:1rem">
            <span class="banner-icon">⚠️</span>
            <div><strong>Could not save</strong><p>{{ error() }}</p></div>
          </div>
        }

        @if (step() === 0) {
          <h2>Which animal are you adding?</h2>
          <p class="muted small">Species selection changes the available breed list and the AI's known limits.</p>
          <div class="species-grid mt-2">
            @for (sp of species(); track sp.code) {
              <button
                type="button"
                class="species-card"
                [class.selected]="speciesCode() === sp.code"
                (click)="chooseSpecies(sp)"
              >
                <span class="species-emoji" aria-hidden="true">{{ sp.icon }}</span>
                <strong>{{ sp.name }}</strong>
                <span>{{ sp.description }}</span>
              </button>
            }
          </div>
          @if (!species().length) {
            <div class="loading-block"><span class="spinner"></span> Loading species…</div>
          }
          <div class="form-actions">
            <button class="btn btn-primary" type="button" [disabled]="!speciesCode()" (click)="step.set(1)">
              Continue to breed
            </button>
          </div>
        }

        @if (step() === 1) {
          <h2>Breed or animal type</h2>
          <p class="muted small">
            {{ speciesName(speciesCode()) }} catalog. This is editable, not a ranking.
            If you don't know the breed, that is completely fine.
          </p>

          <mat-form-field appearance="outline" style="margin-top:.8rem">
            <mat-label>Search breeds</mat-label>
            <input matInput [value]="breedSearch()" (input)="breedSearch.set($any($event.target).value)" placeholder="Start typing…" />
          </mat-form-field>

          <div class="chip-row" style="margin-bottom:.8rem">
            <button
              type="button"
              class="chip"
              [style.border-color]="breedId() === null && !customBreed() ? 'var(--brand)' : null"
              (click)="chooseBreed(null, '', false)"
            >Skip — I'm not sure</button>
            @for (breed of filteredBreeds(); track breed.id) {
              <button
                type="button"
                class="chip"
                [style.border-color]="breedId() === breed.id ? 'var(--brand)' : null"
                [style.background]="breedId() === breed.id ? 'var(--brand-soft)' : null"
                (click)="chooseBreed(breed.id, breed.name, breed.isUnknown)"
              >{{ breed.name }}</button>
            }
            @if (breeds().length && !filteredBreeds().length) {
              <span class="small muted">No catalog match. Use “Other / Unknown” below.</span>
            }
          </div>

          <div class="form-grid">
            <mat-form-field appearance="outline" class="full">
              <mat-label>Custom breed or mix (optional)</mat-label>
              <input matInput [value]="customBreed()" (input)="customBreed.set($any($event.target).value)" placeholder="e.g. Indie mix, rescued, unknown" />
              <mat-hint>Use this for mixed breeds or local names that aren't in the catalog.</mat-hint>
            </mat-form-field>
          </div>

          <div class="banner banner-info">
            <span class="banner-icon">🔎</span>
            <div>
              <strong>Breed catalogs are illustrative</strong>
              <p>The seeded catalog is a starting point for India and is not a verified ranking. Administrators can expand it.</p>
            </div>
          </div>

          <div class="form-actions">
            <button class="btn btn-secondary" type="button" (click)="step.set(0)">Back</button>
            <button class="btn btn-primary" type="button" (click)="step.set(2)">Continue</button>
          </div>
        }

        @if (step() === 2) {
          <h2>About your pet</h2>
          <p class="muted small">Only the name is required. Weight, age and medical history are never invented for you.</p>

          <form [formGroup]="petForm" (ngSubmit)="createPet()" novalidate style="margin-top:1rem">
            <div class="form-grid">
              <mat-form-field appearance="outline" class="full">
                <mat-label>Pet's name</mat-label>
                <input matInput formControlName="name" placeholder="e.g. Bruno" />
                @if (petForm.controls.name.touched && petForm.controls.name.invalid) {
                  <mat-error>Give your pet a name</mat-error>
                }
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Sex</mat-label>
                <mat-select formControlName="sex">
                  <mat-option value="unknown">Not sure / unknown</mat-option>
                  <mat-option value="male">Male</mat-option>
                  <mat-option value="female">Female</mat-option>
                </mat-select>
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Date of birth (if known)</mat-label>
                <input matInput type="date" formControlName="birthDate" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Estimated age (months)</mat-label>
                <input matInput type="number" min="0" max="600" formControlName="ageEstimateMonths" />
                <mat-hint>Leave blank if unknown</mat-hint>
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Weight (kg)</mat-label>
                <input matInput type="number" min="0" step="0.1" formControlName="weightKg" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Weight measured on</mat-label>
                <input matInput type="date" formControlName="weightMeasuredOn" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Activity level</mat-label>
                <mat-select formControlName="activityLevel">
                  <mat-option value="unknown">Not sure</mat-option>
                  <mat-option value="low">Low</mat-option>
                  <mat-option value="moderate">Moderate</mat-option>
                  <mat-option value="high">High</mat-option>
                </mat-select>
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Living environment</mat-label>
                <input matInput formControlName="livingEnvironment" placeholder="Apartment, house with garden, farm…" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Indoor / outdoor lifestyle</mat-label>
                <mat-select formControlName="lifestyle">
                  <mat-option value="">Not sure</mat-option>
                  <mat-option value="indoor">Mostly indoor</mat-option>
                  <mat-option value="indoor_outdoor">Indoor and outdoor</mat-option>
                  <mat-option value="outdoor">Mostly outdoor</mat-option>
                </mat-select>
              </mat-form-field>

              @if (needsHouseholdChoice()) {
                <div class="field full">
                  <mat-slide-toggle formControlName="isHouseholdPet">
                    Kept as a household companion (not primarily for farming)
                  </mat-slide-toggle>
                  <div class="field-hint">Care expectations differ between household animals and farm animals.</div>
                </div>
              }

              <mat-form-field appearance="outline" class="full">
                <mat-label>Feeding routine</mat-label>
                <textarea matInput rows="2" formControlName="feedingNotes" placeholder="Meals, portions, timings — whatever you already do"></textarea>
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Food preferences</mat-label>
                <input matInput formControlName="foodPreferences" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Dietary restrictions</mat-label>
                <input matInput formControlName="dietaryRestrictions" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Known allergies</mat-label>
                <input matInput formControlName="allergies" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Existing conditions</mat-label>
                <input matInput formControlName="conditions" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Current medications</mat-label>
                <input matInput formControlName="medications" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Last grooming date (if relevant)</mat-label>
                <input matInput type="date" formControlName="lastGroomingOn" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Current veterinarian</mat-label>
                <input matInput formControlName="currentVetName" />
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Clinic</mat-label>
                <input matInput formControlName="currentVetClinic" />
              </mat-form-field>

              <div class="field full">
                <span class="field-label">Profile photo (optional)</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" (change)="uploadPhoto($event)" />
                <div class="field-hint">JPG, PNG or WebP. Private to your account and vets you share records with.</div>
                @if (uploading()) {
                  <div class="small muted mt-1"><span class="spinner"></span> Uploading…</div>
                }
                @if (photoFileId()) {
                  <div class="row mt-1">
                    <img [src]="photoUrl(photoFileId()!)" alt="Uploaded pet photo preview" style="width:88px;height:88px;object-fit:cover;border-radius:14px;border:1px solid var(--line)" />
                    <span class="badge badge-ok">Photo attached</span>
                  </div>
                }
                <div class="field-hint">Vaccination records can be added after the profile is created.</div>
              </div>
            </div>

            <div class="banner banner-teal">
              <span class="banner-icon">🔒</span>
              <div>
                <strong>Your pet's data is private</strong>
                <p>Only you, administrators with a legitimate support reason, and veterinarians you book or message can see these records.</p>
              </div>
            </div>

            <div class="form-actions">
              <button class="btn btn-secondary" type="button" (click)="step.set(1)">Back</button>
              <button class="btn btn-ghost" type="button" (click)="skipOptional()">Skip optional details</button>
              <button class="btn btn-primary" type="submit" [disabled]="saving()">
                {{ saving() ? 'Adding…' : 'Add ' + (petForm.controls.name.value || 'pet') }}
              </button>
            </div>
          </form>
        }
      </div>
    </div>
  `,
})
export class OnboardingComponent implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private fb = inject(FormBuilder);
  private toast = inject(ToastService);

  readonly step = signal(0);
  readonly species = signal<Species[]>([]);
  readonly breeds = signal<Breed[]>([]);
  readonly breedSearch = signal('');
  readonly speciesCode = signal('dog');
  readonly breedId = signal<string | null>(null);
  readonly customBreed = signal('');
  readonly error = signal('');
  readonly saving = signal(false);
  readonly uploading = signal(false);
  readonly photoFileId = signal<string | null>(null);

  readonly petForm = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(60)]],
    sex: ['unknown'],
    birthDate: [''],
    ageEstimateMonths: [null as number | null],
    weightKg: [null as number | null],
    weightMeasuredOn: [''],
    activityLevel: ['unknown'],
    livingEnvironment: [''],
    lifestyle: [''],
    feedingNotes: [''],
    foodPreferences: [''],
    dietaryRestrictions: [''],
    allergies: [''],
    conditions: [''],
    medications: [''],
    lastGroomingOn: [''],
    currentVetName: [''],
    currentVetClinic: [''],
    isHouseholdPet: [true],
  });

  ngOnInit(): void {
    this.api.get<{ species: Species[] }>('/species').subscribe({
      next: (res) => this.species.set(res.species),
      error: (err) => this.toast.error(err),
    });
  }

  filteredBreeds(): Breed[] {
    const query = this.breedSearch().trim().toLowerCase();
    return this.breeds().filter((b) => !query || b.name.toLowerCase().includes(query));
  }

  speciesName(code: string): string {
    return this.species().find((s) => s.code === code)?.name ?? '';
  }

  needsHouseholdChoice(): boolean {
    return ['bird', 'cow', 'goat'].includes(this.speciesCode());
  }

  chooseSpecies(sp: Species): void {
    if (this.speciesCode() === sp.code) return;
    this.speciesCode.set(sp.code);
    this.breedId.set(null);
    this.customBreed.set('');
    this.breedSearch.set('');
    this.breeds.set([]);
    this.api.get<{ breeds: Breed[] }>(`/species/${sp.code}/breeds`).subscribe({
      next: (res) => this.breeds.set(res.breeds),
      error: (err) => this.toast.error(err),
    });
  }

  chooseBreed(id: string | null, name: string, _unknown: boolean): void {
    this.breedId.set(id);
    if (name && !name.toLowerCase().includes('unknown')) {
      this.customBreed.set(name);
    } else if (!id) {
      this.customBreed.set('');
    }
  }

  skipOptional(): void {
    const name = this.petForm.controls.name.value?.trim();
    if (!name) {
      this.petForm.controls.name.markAsTouched();
      return;
    }
    this.createPet();
  }

  uploadPhoto(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('purpose', 'pet_photo');
    this.uploading.set(true);
    this.api.upload('/files', form).subscribe({
      next: (res) => {
        this.photoFileId.set(res.file.id);
        this.uploading.set(false);
      },
      error: (err) => {
        this.uploading.set(false);
        this.toast.error(err);
      },
    });
  }

  photoUrl(id: string): string {
    return `${this.api.fileUrl(id)}?token=${encodeURIComponent(this.auth.token() ?? '')}`;
  }

  createPet(): void {
    this.error.set('');
    if (this.petForm.controls.name.invalid) {
      this.petForm.controls.name.markAsTouched();
      this.error.set('Give your pet a name to continue.');
      return;
    }
    const v = this.petForm.getRawValue();
    const payload: Record<string, unknown> = {
      name: v.name?.trim(),
      speciesCode: this.speciesCode(),
      breedId: this.breedId(),
      customBreed: this.customBreed() || undefined,
      sex: v.sex || 'unknown',
      birthDate: v.birthDate || undefined,
      ageEstimateMonths: v.ageEstimateMonths ?? undefined,
      weightKg: v.weightKg ?? undefined,
      weightMeasuredOn: v.weightMeasuredOn || undefined,
      activityLevel: v.activityLevel || 'unknown',
      livingEnvironment: v.livingEnvironment || undefined,
      lifestyle: v.lifestyle || undefined,
      feedingNotes: v.feedingNotes || undefined,
      foodPreferences: v.foodPreferences || undefined,
      dietaryRestrictions: v.dietaryRestrictions || undefined,
      allergies: v.allergies || undefined,
      conditions: v.conditions || undefined,
      medications: v.medications || undefined,
      lastGroomingOn: v.lastGroomingOn || undefined,
      currentVetName: v.currentVetName || undefined,
      currentVetClinic: v.currentVetClinic || undefined,
      photoFileId: this.photoFileId() ?? undefined,
      isHouseholdPet: this.needsHouseholdChoice() ? v.isHouseholdPet : undefined,
    };
    this.saving.set(true);
    this.api.post<{ pet: Pet }>('/pets', payload).subscribe({
      next: (res) => {
        this.saving.set(false);
        this.toast.success(`${res.pet.name} added. Your care checklist and safety guidance are ready.`);
        this.router.navigate(['/pets', res.pet.id]);
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(ApiService.message(err));
      },
    });
  }
}
