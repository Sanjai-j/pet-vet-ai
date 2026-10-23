import { Component, OnInit, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { CareLog, CareTask, Pet, Vaccination, VaccinationCheckpoint, VaccinationPlan } from '../core/models';

@Component({
  selector: 'app-pet-detail',
  standalone: true,
  imports: [
    RouterLink, ReactiveFormsModule, MatTabsModule, MatFormFieldModule, MatInputModule,
    MatSelectModule, MatButtonModule, MatSlideToggleModule, DecimalPipe,
  ],
  template: `
    <div class="page">
      @if (loading()) {
        <div class="loading-block"><span class="spinner"></span> Loading pet profile…</div>
      } @else if (pet(); as p) {
        <div class="page-head">
          <div class="row" style="gap:1rem;align-items:flex-start">
            <span class="pet-avatar" style="width:76px;height:76px;font-size:2.3rem">
              @if (p.photoFileId) {
                <img [src]="photoUrl(p.photoFileId)" [alt]="p.name" />
              } @else {
                {{ p.speciesIcon }}
              }
            </span>
            <div>
              <span class="eyebrow">{{ p.speciesName }} · {{ breedLabel(p) }}</span>
              <h1 style="margin:0">{{ p.name }}</h1>
              <p class="muted small" style="margin:.25rem 0 0">
                {{ ageLabel(p) }} · {{ p.sex || 'sex unknown' }}
                @if (p.weightKg) { · {{ p.weightKg }} kg }
                @if (p.isHouseholdPet === false) { · farm / non-household animal }
              </p>
              <div class="row mt-1">
                <span class="badge badge-demo">Demo-capable platform</span>
                <span class="badge" [class.badge-warn]="aiCoverage() === 'not_supported'" [class.badge-teal]="aiCoverage() === 'limited'">
                  AI support: {{ aiCoverageLabel() }}
                </span>
                @if (p.currentVetName) { <span class="badge badge-neutral">Vet: {{ p.currentVetName }}</span> }
              </div>
            </div>
          </div>
          <div class="row">
            <a mat-stroked-button routerLink="/ai">Ask about {{ p.name }}</a>
            <a mat-flat-button color="primary" routerLink="/find-care">Book a vet</a>
          </div>
        </div>

        @if (!ownerView()) {
          <div class="banner banner-info" style="margin-bottom:1rem">
            <span class="banner-icon">🩺</span>
            <div><strong>Shared record</strong><p>You can view this record because of an accepted consultation. Only the owner can edit care routines.</p></div>
          </div>
        }

        <mat-tab-group animationDuration="180ms" mat-stretch-tabs="false" mat-align-tabs="start">
          <mat-tab label="Care today">
            <div class="stack" style="padding-top:1rem">
              @if (care(); as c) {
                <div class="card">
                  <div class="card-head">
                    <div><h3>Daily checklist</h3><p>{{ c.date }} · {{ c.timezone }} · {{ c.summary.completed }}/{{ c.summary.due }} complete</p></div>
                    <span class="badge badge-teal">{{ c.summary.due ? (c.summary.completed / c.summary.due * 100 | number:'1.0-0') : 0 }}%</span>
                  </div>
                  <div class="progress"><span [style.width.%]="c.summary.due ? (c.summary.completed / c.summary.due) * 100 : 0"></span></div>
                  @if (!c.tasks.length) {
                    <div class="empty"><span class="empty-icon">📋</span>No tasks due today. Add a routine in the Care plan tab.</div>
                  }
                  <div class="care-list mt-1">
                    @for (task of c.tasks; track task.id) {
                      <div class="care-item" [class.done]="task.completed">
                        <button
                          class="care-check"
                          type="button"
                          [class.done]="task.completed"
                          [disabled]="task.completed || !ownerView() || logging() === task.id"
                          [attr.aria-label]="'Mark ' + task.title + ' complete'"
                          (click)="completeTask(task)"
                        >✓</button>
                        <div style="flex:1">
                          <div class="row" style="justify-content:space-between">
                            <span class="care-title">{{ iconFor(task.type) }} {{ task.title }}</span>
                            <span class="tiny muted">{{ task.times?.join(', ') }}</span>
                          </div>
                          <div class="care-meta">{{ task.instructions || task.type }}</div>
                          @if (task.completedAt) {
                            <div class="tiny muted">Logged {{ timeOnly(task.completedAt) }}</div>
                          }
                        </div>
                      </div>
                    }
                  </div>
                </div>
              } @else {
                <div class="card"><div class="empty">No care data yet.</div></div>
              }
            </div>
          </mat-tab>

          <mat-tab label="Care plan">
            <div class="split" style="padding-top:1rem">
              <div class="card">
                <div class="card-head"><div><h3>Routines</h3><p>Feeding, water, walking, grooming and observation reminders.</p></div></div>
                @if (!tasks().length) {
                  <div class="empty"><span class="empty-icon">🗓️</span>No routines yet.</div>
                }
                @for (task of tasks(); track task.id) {
                  <div class="care-item">
                    <div class="timeline-dot">{{ iconFor(task.type) }}</div>
                    <div style="flex:1">
                      <div class="row" style="justify-content:space-between">
                        <span class="care-title">{{ task.title }}</span>
                        <span class="badge" [class.badge-ok]="task.isActive" [class.badge-neutral]="!task.isActive">{{ task.isActive ? 'active' : 'paused' }}</span>
                      </div>
                      <div class="care-meta">
                        {{ task.frequency }} · {{ task.times?.join(', ') || 'no set time' }} · {{ task.type }}
                      </div>
                      @if (task.instructions) { <div class="small muted">{{ task.instructions }}</div> }
                      @if (ownerView()) {
                        <div class="row mt-1">
                          <button mat-button (click)="toggleTask(task)">{{ task.isActive ? 'Pause' : 'Resume' }}</button>
                          <button mat-button color="warn" (click)="deleteTask(task)">Delete</button>
                        </div>
                      }
                    </div>
                  </div>
                }
              </div>

              @if (ownerView()) {
                <div class="card">
                  <h3>Add a routine</h3>
                  <form [formGroup]="taskForm" (ngSubmit)="addTask()" class="stack" style="gap:.5rem">
                    <div class="form-grid">
                      <mat-form-field appearance="outline">
                        <mat-label>Type</mat-label>
                        <mat-select formControlName="type">
                          @for (t of taskTypes; track t) { <mat-option [value]="t">{{ t }}</mat-option> }
                        </mat-select>
                      </mat-form-field>
                      <mat-form-field appearance="outline">
                        <mat-label>Frequency</mat-label>
                        <mat-select formControlName="frequency">
                          <mat-option value="daily">Daily</mat-option>
                          <mat-option value="weekly">Weekly</mat-option>
                          <mat-option value="monthly">Monthly</mat-option>
                          <mat-option value="once">One-off</mat-option>
                        </mat-select>
                      </mat-form-field>
                      <mat-form-field appearance="outline" class="full">
                        <mat-label>Title</mat-label>
                        <input matInput formControlName="title" placeholder="Morning walk" />
                      </mat-form-field>
                      <mat-form-field appearance="outline" class="full">
                        <mat-label>Times (24h, comma separated)</mat-label>
                        <input matInput formControlName="times" placeholder="07:30, 19:00" />
                        <mat-hint>Reminders only fire if you opt in to this category.</mat-hint>
                      </mat-form-field>
                      <mat-form-field appearance="outline" class="full">
                        <mat-label>Due date (for one-off tasks)</mat-label>
                        <input matInput type="date" formControlName="dueDate" />
                      </mat-form-field>
                      <mat-form-field appearance="outline" class="full">
                        <mat-label>Instructions</mat-label>
                        <textarea matInput rows="2" formControlName="instructions"></textarea>
                      </mat-form-field>
                    </div>
                    <button mat-flat-button color="primary" type="submit" [disabled]="savingTask()">Add routine</button>
                  </form>
                </div>
              }
            </div>
          </mat-tab>

          <mat-tab label="Vaccinations">
            @if (plan(); as p) {
              <div class="card" style="margin-top:1rem">
                <div class="card-head">
                  <div>
                    <h3>Vaccination plan</h3>
                    <p>Checkpoints from the approved reference schedule. Each date is guidance — confirm it with your veterinarian.</p>
                  </div>
                  @if (ownerView() && p.canGenerate) {
                    <button mat-stroked-button type="button" [disabled]="planBusy()" (click)="generatePlan()">Calculate checkpoints</button>
                  }
                </div>
                @if (p.message) { <p class="small muted">{{ p.message }}</p> }

                @for (cp of pendingCheckpoints(); track cp.id) {
                  <div class="care-item">
                    <div class="timeline-dot">🗓️</div>
                    <div style="flex:1">
                      <div class="row" style="justify-content:space-between;gap:.5rem">
                        <span class="care-title">{{ cp.vaccineName }}</span>
                        <span class="badge" [class.badge-danger]="dueState(cp.dueOn) === 'overdue'" [class.badge-warn]="dueState(cp.dueOn) === 'soon'" [class.badge-neutral]="dueState(cp.dueOn) === 'later'">{{ dueLabel(cp.dueOn) }}</span>
                      </div>
                      <div class="care-meta">Planned for {{ formatDate(cp.dueOn) }} · {{ originLabel(cp.origin) }}</div>
                      @if (cp.notes) { <div class="tiny muted">{{ cp.notes }}</div> }
                      @if (ownerView()) {
                        <div class="row" style="gap:.4rem;flex-wrap:wrap;margin-top:.4rem;align-items:center">
                          <button mat-flat-button color="primary" type="button" [disabled]="planBusy()" (click)="markDone(cp)">Done</button>
                          <input #dueInput type="date" [value]="cp.dueOn" style="padding:.35rem .5rem;border:1px solid #DCC9B4;border-radius:6px;font:inherit" />
                          <button mat-stroked-button type="button" [disabled]="planBusy()" (click)="moveCheckpoint(cp, dueInput.value)">Set date</button>
                          <button mat-button color="warn" type="button" (click)="removeCheckpoint(cp)">Remove</button>
                        </div>
                      }
                    </div>
                  </div>
                }
                @if (!pendingCheckpoints().length) {
                  <div class="empty"><span class="empty-icon">🗓️</span>No upcoming vaccination checkpoints.</div>
                }

                @if (doneCheckpoints().length) {
                  <div class="tiny muted" style="margin-top:.6rem">Completed</div>
                  @for (cp of doneCheckpoints(); track cp.id) {
                    <div class="row small" style="justify-content:space-between">
                      <span>✅ {{ cp.vaccineName }}</span>
                      <span class="muted">{{ formatDate(cp.completedOn || cp.dueOn) }}</span>
                    </div>
                  }
                }

                @if (ownerView()) {
                  <form [formGroup]="checkpointForm" (ngSubmit)="addCheckpoint()" class="row" style="gap:.4rem;flex-wrap:wrap;align-items:flex-start;margin-top:.6rem">
                    <mat-form-field appearance="outline" style="flex:2;min-width:180px">
                      <mat-label>Add a vaccination date</mat-label>
                      <input matInput formControlName="vaccineName" placeholder="Rabies booster" />
                    </mat-form-field>
                    <mat-form-field appearance="outline" style="flex:1;min-width:150px">
                      <mat-label>Date</mat-label>
                      <input matInput type="date" formControlName="dueOn" />
                    </mat-form-field>
                    <button mat-stroked-button type="submit" [disabled]="planBusy()">Add checkpoint</button>
                  </form>
                  <p class="tiny muted">You are notified on the date you pick (starting a week before), and again if you move it.</p>
                }

                @if (p.reference.length) {
                  <div class="tiny muted" style="margin-top:.7rem">Reference used for {{ p.pet.speciesCode }} — general guidance, not a prescription.</div>
                  @for (row of p.reference; track row.id) {
                    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:.5rem;border-top:1px solid #EDE0D0;padding-top:.4rem;margin-top:.4rem">
                      <div style="flex:1">
                        <div class="small">{{ row.vaccineName }}</div>
                        <div class="tiny muted">First dose: {{ row.firstDoseAgeText }}</div>
                        <div class="tiny muted">Booster: {{ row.boosterIntervalText }}</div>
                      </div>
                      <span class="badge" [class.badge-ok]="row.guidanceLevel === 'general_guidance'" [class.badge-warn]="row.guidanceLevel !== 'general_guidance'">{{ guidanceLabel(row) }}</span>
                    </div>
                  }
                }
              </div>
            }

            <div class="split" style="padding-top:1rem">
              <div class="card">
                <div class="card-head"><div><h3>Vaccination records</h3><p>Records are only what was documented — nothing is inferred.</p></div></div>
                @if (!vaccinations().length) {
                  <div class="empty"><span class="empty-icon">💉</span>No vaccination records yet.</div>
                }
                @for (v of vaccinations(); track v.id) {
                  <div class="care-item">
                    <div class="timeline-dot">💉</div>
                    <div style="flex:1">
                      <div class="row" style="justify-content:space-between">
                        <span class="care-title">{{ v.vaccineName }}</span>
                        <span class="badge" [class.badge-demo]="v.source === 'demo'" [class.badge-neutral]="v.source !== 'demo'">{{ sourceLabel(v.source) }}</span>
                      </div>
                      <div class="care-meta">
                        Given {{ formatDate(v.administeredOn) }}
                        @if (v.nextDueOn) { · next due {{ formatDate(v.nextDueOn) }} }
                      </div>
                      @if (v.notes) { <div class="small muted">{{ v.notes }}</div> }
                      @if (ownerView()) {
                        <button mat-button color="warn" (click)="deleteVaccination(v)">Remove</button>
                      }
                    </div>
                  </div>
                }
              </div>

              @if (ownerView()) {
                <div class="card">
                  <h3>Add a record</h3>
                  <p class="tiny muted">Entries you add are marked “owner reported”. Ask your vet to confirm them.</p>
                  <form [formGroup]="vaxForm" (ngSubmit)="addVaccination()" class="stack" style="gap:.4rem">
                    <mat-form-field appearance="outline">
                      <mat-label>Vaccine name</mat-label>
                      <input matInput formControlName="vaccineName" placeholder="Rabies" />
                    </mat-form-field>
                    <mat-form-field appearance="outline">
                      <mat-label>Administered on</mat-label>
                      <input matInput type="date" formControlName="administeredOn" />
                    </mat-form-field>
                    <mat-form-field appearance="outline">
                      <mat-label>Next due on</mat-label>
                      <input matInput type="date" formControlName="nextDueOn" />
                    </mat-form-field>
                    <mat-form-field appearance="outline">
                      <mat-label>Batch number</mat-label>
                      <input matInput formControlName="batchNumber" />
                    </mat-form-field>
                    <mat-form-field appearance="outline">
                      <mat-label>Notes</mat-label>
                      <textarea matInput rows="2" formControlName="notes"></textarea>
                    </mat-form-field>
                    <button mat-flat-button color="primary" type="submit" [disabled]="savingVax()">Add record</button>
                  </form>
                </div>
              }
            </div>
          </mat-tab>

          <mat-tab label="Activity">
            <div class="split" style="padding-top:1rem">
              <div class="card">
                <div class="card-head"><div><h3>Care log</h3><p>Meals, water, grooming, observations and weight.</p></div></div>
                @if (!logs().length) {
                  <div class="empty"><span class="empty-icon">📝</span>No activity logged yet.</div>
                }
                <div class="timeline">
                  @for (log of logs(); track log.id) {
                    <div class="timeline-item">
                      <div class="timeline-dot">{{ iconFor(log.type) }}</div>
                      <div class="timeline-body">
                        <div class="row" style="justify-content:space-between">
                          <span class="timeline-title">{{ log.type }}</span>
                          <span class="tiny muted">{{ formatDateTime(log.loggedAt) }}</span>
                        </div>
                        @if (log.notes) { <div class="small">{{ log.notes }}</div> }
                        @if (log.value && log.value['weightKg']) { <div class="small">Weight: {{ log.value['weightKg'] }} kg</div> }
                        <div class="tiny muted">{{ log.loggedByName || 'Recorded' }}</div>
                      </div>
                    </div>
                  }
                </div>
              </div>

              @if (ownerView()) {
                <div class="card">
                  <h3>Log something</h3>
                  <form [formGroup]="logForm" (ngSubmit)="addLog()" class="stack" style="gap:.4rem">
                    <mat-form-field appearance="outline">
                      <mat-label>What are you logging?</mat-label>
                      <mat-select formControlName="type">
                        <mat-option value="observation">Observation</mat-option>
                        <mat-option value="feeding">Meal</mat-option>
                        <mat-option value="water">Water check</mat-option>
                        <mat-option value="grooming">Grooming</mat-option>
                        <mat-option value="walk">Walk / exercise</mat-option>
                        <mat-option value="weight">Weight</mat-option>
                      </mat-select>
                    </mat-form-field>
                    @if (logForm.controls.type.value === 'weight') {
                      <mat-form-field appearance="outline">
                        <mat-label>Weight (kg)</mat-label>
                        <input matInput type="number" step="0.1" formControlName="weightKg" />
                      </mat-form-field>
                    }
                    <mat-form-field appearance="outline">
                      <mat-label>Notes</mat-label>
                      <textarea matInput rows="3" formControlName="notes" placeholder="Appetite, energy, stool, water — anything you noticed"></textarea>
                    </mat-form-field>
                    <button mat-flat-button color="primary" type="submit" [disabled]="savingLog()">Save log</button>
                  </form>
                </div>
              }
            </div>
          </mat-tab>

          <mat-tab label="Profile">
            <div class="card" style="margin-top:1rem">
              <div class="card-head">
                <div><h3>Pet profile</h3><p>Update anything as you learn more. Unknown fields stay unknown.</p></div>
                @if (ownerView()) {
                  <button mat-stroked-button (click)="startEdit()">Edit profile</button>
                }
              </div>

              @if (!editing()) {
                <div class="grid grid-3">
                  <div><div class="stat-label">Species</div><div>{{ p.speciesName }}</div></div>
                  <div><div class="stat-label">Breed</div><div>{{ p.breedName || p.customBreed || 'Not specified' }}</div></div>
                  <div><div class="stat-label">Sex</div><div>{{ p.sex || 'Unknown' }}</div></div>
                  <div><div class="stat-label">Birth date</div><div>{{ formatDate(p.birthDate) }}</div></div>
                  <div><div class="stat-label">Weight</div><div>{{ p.weightKg ? p.weightKg + ' kg' : 'Not recorded' }}</div></div>
                  <div><div class="stat-label">Weight measured</div><div>{{ formatDate(p.weightMeasuredOn) }}</div></div>
                  <div><div class="stat-label">Activity</div><div>{{ p.activityLevel || 'Unknown' }}</div></div>
                  <div><div class="stat-label">Environment</div><div>{{ p.livingEnvironment || 'Not specified' }}</div></div>
                  <div><div class="stat-label">Lifestyle</div><div>{{ p.lifestyle || 'Not specified' }}</div></div>
                  <div><div class="stat-label">Allergies</div><div>{{ p.allergies || 'None recorded' }}</div></div>
                  <div><div class="stat-label">Conditions</div><div>{{ p.conditions || 'None recorded' }}</div></div>
                  <div><div class="stat-label">Medications</div><div>{{ p.medications || 'None recorded' }}</div></div>
                </div>
                <hr class="divider" />
                <div class="grid grid-2">
                  <div><div class="stat-label">Feeding routine</div><div>{{ p.feedingNotes || 'Not specified' }}</div></div>
                  <div><div class="stat-label">Food preferences</div><div>{{ p.foodPreferences || 'Not specified' }}</div></div>
                  <div><div class="stat-label">Dietary restrictions</div><div>{{ p.dietaryRestrictions || 'Not specified' }}</div></div>
                  <div><div class="stat-label">Current vet</div><div>{{ p.currentVetName || 'Not specified' }}{{ p.currentVetClinic ? ' · ' + p.currentVetClinic : '' }}</div></div>
                </div>
                @if (sharedWith().length) {
                  <div class="banner banner-teal mt-2">
                    <span class="banner-icon">🤝</span>
                    <div><strong>Shared with</strong><p>{{ sharedNames() }}</p></div>
                  </div>
                }
                <div class="mt-2">
                  <span class="field-label">Profile photo</span>
                  @if (ownerView()) {
                    <input type="file" accept="image/png,image/jpeg,image/webp" (change)="uploadPhoto($event)" />
                  }
                  @if (uploading()) { <span class="small muted">Uploading…</span> }
                </div>
              } @else {
                <form [formGroup]="profileForm" (ngSubmit)="saveProfile()">
                  <div class="form-grid">
                    <mat-form-field appearance="outline"><mat-label>Name</mat-label><input matInput formControlName="name" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Sex</mat-label>
                      <mat-select formControlName="sex"><mat-option value="unknown">Unknown</mat-option><mat-option value="male">Male</mat-option><mat-option value="female">Female</mat-option></mat-select>
                    </mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Birth date</mat-label><input matInput type="date" formControlName="birthDate" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Estimated age (months)</mat-label><input matInput type="number" formControlName="ageEstimateMonths" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Weight (kg)</mat-label><input matInput type="number" step="0.1" formControlName="weightKg" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Weight measured on</mat-label><input matInput type="date" formControlName="weightMeasuredOn" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Activity level</mat-label>
                      <mat-select formControlName="activityLevel"><mat-option value="unknown">Unknown</mat-option><mat-option value="low">Low</mat-option><mat-option value="moderate">Moderate</mat-option><mat-option value="high">High</mat-option></mat-select>
                    </mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Living environment</mat-label><input matInput formControlName="livingEnvironment" /></mat-form-field>
                    <mat-form-field appearance="outline" class="full"><mat-label>Feeding routine</mat-label><textarea matInput rows="2" formControlName="feedingNotes"></textarea></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Food preferences</mat-label><input matInput formControlName="foodPreferences" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Dietary restrictions</mat-label><input matInput formControlName="dietaryRestrictions" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Allergies</mat-label><input matInput formControlName="allergies" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Conditions</mat-label><input matInput formControlName="conditions" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Medications</mat-label><input matInput formControlName="medications" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Current vet</mat-label><input matInput formControlName="currentVetName" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Clinic</mat-label><input matInput formControlName="currentVetClinic" /></mat-form-field>
                  </div>
                  <div class="form-actions">
                    <button mat-button type="button" (click)="editing.set(false)">Cancel</button>
                    <button mat-flat-button color="primary" type="submit" [disabled]="savingProfile()">Save profile</button>
                  </div>
                </form>
              }
            </div>
          </mat-tab>
        </mat-tab-group>
      }
    </div>
  `,
})
export class PetDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private fb = inject(FormBuilder);

  readonly pet = signal<Pet | null>(null);
  readonly tasks = signal<CareTask[]>([]);
  readonly vaccinations = signal<Vaccination[]>([]);
  readonly logs = signal<CareLog[]>([]);
  readonly care = signal<any>(null);
  readonly sharedWith = signal<any[]>([]);
  readonly loading = signal(true);
  readonly editing = signal(false);
  readonly uploading = signal(false);
  readonly savingProfile = signal(false);
  readonly savingTask = signal(false);
  readonly savingVax = signal(false);
  readonly plan = signal<VaccinationPlan | null>(null);
  readonly planBusy = signal(false);
  readonly savingLog = signal(false);
  readonly logging = signal<string | null>(null);

  readonly taskTypes = ['feeding', 'water', 'walk', 'grooming', 'medication', 'observation', 'other'];

  readonly profileForm = this.fb.group({
    name: ['', Validators.required],
    sex: ['unknown'],
    birthDate: [''],
    ageEstimateMonths: [null as number | null],
    weightKg: [null as number | null],
    weightMeasuredOn: [''],
    activityLevel: ['unknown'],
    livingEnvironment: [''],
    feedingNotes: [''],
    foodPreferences: [''],
    dietaryRestrictions: [''],
    allergies: [''],
    conditions: [''],
    medications: [''],
    currentVetName: [''],
    currentVetClinic: [''],
  });

  readonly taskForm = this.fb.nonNullable.group({
    type: ['feeding'],
    frequency: ['daily'],
    title: ['', Validators.required],
    times: ['07:30'],
    dueDate: [''],
    instructions: [''],
  });

  readonly vaxForm = this.fb.nonNullable.group({
    vaccineName: ['', Validators.required],
    administeredOn: [''],
    nextDueOn: [''],
    batchNumber: [''],
    notes: [''],
  });

  readonly checkpointForm = this.fb.nonNullable.group({
    vaccineName: ['', Validators.required],
    dueOn: [this.todayIso(), Validators.required],
  });

  readonly logForm = this.fb.nonNullable.group({
    type: ['observation'],
    notes: [''],
    weightKg: [null as number | null],
  });

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.router.navigate(['/dashboard']);
      return;
    }
    this.load(id);
  }

  load(id: string): void {
    this.loading.set(true);
    this.api.get<any>(`/pets/${id}`).subscribe({
      next: (res) => {
        this.pet.set(res.pet);
        this.tasks.set(res.careTasks ?? []);
        this.vaccinations.set(res.vaccinations ?? []);
        this.logs.set(res.recentLogs ?? []);
        this.sharedWith.set(res.sharedWith ?? []);
        this.patchProfileForm(res.pet);
        this.loading.set(false);
        this.loadCare(id);
        this.loadPlan(id);
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(err);
      },
    });
  }

  loadCare(id: string): void {
    this.api.get<any>(`/pets/${id}/care`).subscribe({
      next: (res) => this.care.set(res),
      error: () => undefined,
    });
  }

  ownerView(): boolean {
    const user = this.auth.user();
    return Boolean(user && (user.role === 'admin' || user.id === this.pet()?.ownerId));
  }

  breedLabel(p: Pet): string {
    return p.breedName || p.customBreed || 'Breed not specified';
  }

  ageLabel(p: Pet): string {
    if (p.birthDate) {
      const months = Math.max(0, Math.floor((Date.now() - new Date(p.birthDate).getTime()) / (30.44 * 86400000)));
      return this.monthsLabel(months);
    }
    return p.ageEstimateMonths != null ? `~${this.monthsLabel(p.ageEstimateMonths)}` : 'Age unknown';
  }

  monthsLabel(months: number): string {
    if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
    const y = Math.floor(months / 12);
    return `${y} year${y === 1 ? '' : 's'}`;
  }

  sharedNames(): string {
    return this.sharedWith().map((v) => `${v.fullName}${v.clinicName ? ' (' + v.clinicName + ')' : ''}`).join(', ');
  }

  aiCoverage(): string {
    const species = this.pet()?.speciesCode;
    return species === 'dog' || species === 'cat' ? 'limited' : 'not_supported';
  }

  aiCoverageLabel(): string {
    return this.aiCoverage() === 'limited' ? 'Limited — symptoms only' : 'Not supported for diagnosis';
  }

  iconFor(type: string): string {
    const map: Record<string, string> = {
      feeding: '🍲', water: '💧', walk: '🐕', grooming: '🪮', medication: '💊',
      vaccination: '💉', observation: '👀', weight: '⚖️', other: '📌',
    };
    return map[type] ?? '📌';
  }

  sourceLabel(source: string): string {
    return source === 'vet_recorded' ? 'Vet recorded' : source === 'demo' ? 'Demo record' : 'Owner reported';
  }

  photoUrl(fileId: string): string {
    return `${this.api.fileUrl(fileId)}?token=${encodeURIComponent(this.auth.token() ?? '')}`;
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return 'Not recorded';
    return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
  }

  timeOnly(value: string): string {
    return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(value));
  }

  formatDateTime(value: string): string {
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
    }).format(new Date(value));
  }

  completeTask(task: CareTask): void {
    const pet = this.pet();
    if (!pet || !this.ownerView()) return;
    this.logging.set(task.id);
    this.api.post(`/pets/${pet.id}/care/logs`, { type: task.type, taskId: task.id, notes: 'Logged from checklist' }).subscribe({
      next: () => {
        this.logging.set(null);
        this.toast.success(`${task.title} logged`);
        this.loadCare(pet.id);
        this.reloadLogs(pet.id);
      },
      error: (err) => {
        this.logging.set(null);
        this.toast.error(err);
      },
    });
  }

  reloadLogs(petId: string): void {
    this.api.get<any>(`/pets/${petId}`).subscribe({ next: (res) => this.logs.set(res.recentLogs ?? []) });
  }

  addTask(): void {
    const pet = this.pet();
    if (!pet || this.taskForm.invalid) {
      this.taskForm.markAllAsTouched();
      return;
    }
    const v = this.taskForm.getRawValue();
    const times = v.times.split(',').map((t) => t.trim()).filter(Boolean);
    if (times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) {
      this.toast.info('Use 24-hour times such as 07:30 or 19:00.');
      return;
    }
    if (v.frequency === 'once' && !v.dueDate) {
      this.toast.info('A one-off task needs a due date.');
      return;
    }
    this.savingTask.set(true);
    this.api.post(`/pets/${pet.id}/care/tasks`, {
      type: v.type,
      title: v.title,
      frequency: v.frequency,
      times,
      dueDate: v.dueDate || null,
      instructions: v.instructions || null,
    }).subscribe({
      next: () => {
        this.savingTask.set(false);
        this.taskForm.reset({ type: 'feeding', frequency: 'daily', title: '', times: '07:30', dueDate: '', instructions: '' });
        this.toast.success('Routine added');
        this.load(pet.id);
      },
      error: (err) => {
        this.savingTask.set(false);
        this.toast.error(err);
      },
    });
  }

  toggleTask(task: CareTask): void {
    const pet = this.pet();
    if (!pet) return;
    this.api.patch(`/care/tasks/${task.id}`, { isActive: !task.isActive }).subscribe({
      next: () => this.load(pet.id),
      error: (err) => this.toast.error(err),
    });
  }

  deleteTask(task: CareTask): void {
    const pet = this.pet();
    if (!pet) return;
    if (!confirm(`Delete “${task.title}”? Past logs are kept.`)) return;
    this.api.delete(`/care/tasks/${task.id}`).subscribe({
      next: () => {
        this.toast.success('Routine removed');
        this.load(pet.id);
      },
      error: (err) => this.toast.error(err),
    });
  }

  addVaccination(): void {
    const pet = this.pet();
    if (!pet || this.vaxForm.invalid) {
      this.vaxForm.markAllAsTouched();
      return;
    }
    const v = this.vaxForm.getRawValue();
    this.savingVax.set(true);
    this.api.post(`/pets/${pet.id}/vaccinations`, {
      vaccineName: v.vaccineName,
      administeredOn: v.administeredOn || null,
      nextDueOn: v.nextDueOn || null,
      batchNumber: v.batchNumber || null,
      notes: v.notes || null,
    }).subscribe({
      next: () => {
        this.savingVax.set(false);
        this.toast.success('Vaccination record added');
        this.load(pet.id);
      },
      error: (err) => {
        this.savingVax.set(false);
        this.toast.error(err);
      },
    });
  }

  deleteVaccination(v: Vaccination): void {
    const pet = this.pet();
    if (!pet || !confirm(`Remove the ${v.vaccineName} record?`)) return;
    this.api.delete(`/pets/${pet.id}/vaccinations/${v.id}`).subscribe({
      next: () => this.load(pet.id),
      error: (err) => this.toast.error(err),
    });
  }

  loadPlan(id: string): void {
    this.api.get<VaccinationPlan>(`/pets/${id}/vaccination-plan`).subscribe({
      next: (plan) => this.plan.set(plan),
      error: () => this.plan.set(null),
    });
  }

  pendingCheckpoints(): VaccinationCheckpoint[] {
    return (this.plan()?.checkpoints ?? []).filter((cp) => cp.status === 'pending');
  }

  doneCheckpoints(): VaccinationCheckpoint[] {
    return (this.plan()?.checkpoints ?? []).filter((cp) => cp.status === 'done');
  }

  /** Today's calendar date in the app's timezone, not the UTC date. */
  private todayIso(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  }

  private dayDiff(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  }

  dueState(dueOn: string): 'overdue' | 'soon' | 'later' {
    const left = this.dayDiff(this.todayIso(), dueOn);
    if (left < 0) return 'overdue';
    return left <= 14 ? 'soon' : 'later';
  }

  dueLabel(dueOn: string): string {
    const left = this.dayDiff(this.todayIso(), dueOn);
    if (left === 0) return 'Due today';
    if (left < 0) return `${Math.abs(left)} day(s) overdue`;
    return `In ${left} day(s)`;
  }

  originLabel(origin: string): string {
    return origin === 'owner' ? 'your date' : origin === 'follow_up' ? 'follow-up from the booster interval' : 'from the reference schedule';
  }

  guidanceLabel(row: { guidanceLevel: string }): string {
    const map: Record<string, string> = {
      general_guidance: 'Reference — vet confirms',
      vet_decision: 'Vet decides',
      programme_only: 'Programme only',
      avian_review: 'Avian vet review',
    };
    return map[row.guidanceLevel] ?? 'Vet decides';
  }

  generatePlan(): void {
    const pet = this.pet();
    if (!pet) return;
    this.planBusy.set(true);
    this.api.post<{ created: number; message: string }>(`/pets/${pet.id}/vaccination-plan/generate`, {}).subscribe({
      next: (res) => {
        this.planBusy.set(false);
        this.toast.success(res.message || `${res.created} checkpoint(s) created`);
        this.loadPlan(pet.id);
      },
      error: (err) => {
        this.planBusy.set(false);
        this.toast.error(err);
      },
    });
  }

  markDone(cp: VaccinationCheckpoint): void {
    const pet = this.pet();
    if (!pet) return;
    if (!confirm(`Mark ${cp.vaccineName} as given today?`)) return;
    this.planBusy.set(true);
    this.api.post<{ next: { dueOn: string } | null }>(`/vaccination-checkpoints/${cp.id}/done`, {}).subscribe({
      next: (res) => {
        this.planBusy.set(false);
        this.toast.success(res.next ? `Recorded. Next follow-up planned for ${this.formatDate(res.next.dueOn)}.` : 'Recorded as done');
        this.load(pet.id);
      },
      error: (err) => {
        this.planBusy.set(false);
        this.toast.error(err);
      },
    });
  }

  moveCheckpoint(cp: VaccinationCheckpoint, date: string): void {
    const pet = this.pet();
    if (!pet) return;
    if (!date) {
      this.toast.error(new Error('Pick a date first'));
      return;
    }
    this.planBusy.set(true);
    this.api.patch(`/vaccination-checkpoints/${cp.id}`, { dueOn: date }).subscribe({
      next: () => {
        this.planBusy.set(false);
        this.toast.success(`Moved to ${this.formatDate(date)} — you will be reminded then`);
        this.loadPlan(pet.id);
      },
      error: (err) => {
        this.planBusy.set(false);
        this.toast.error(err);
      },
    });
  }

  removeCheckpoint(cp: VaccinationCheckpoint): void {
    const pet = this.pet();
    if (!pet || !confirm(`Remove the ${cp.vaccineName} checkpoint?`)) return;
    this.planBusy.set(true);
    this.api.delete(`/vaccination-checkpoints/${cp.id}`).subscribe({
      next: () => {
        this.planBusy.set(false);
        this.toast.success('Checkpoint removed');
        this.loadPlan(pet.id);
      },
      error: (err) => {
        this.planBusy.set(false);
        this.toast.error(err);
      },
    });
  }

  addCheckpoint(): void {
    const pet = this.pet();
    if (!pet || this.checkpointForm.invalid) {
      this.checkpointForm.markAllAsTouched();
      return;
    }
    const value = this.checkpointForm.getRawValue();
    this.planBusy.set(true);
    this.api.post(`/pets/${pet.id}/vaccination-checkpoints`, {
      vaccineName: value.vaccineName,
      dueOn: value.dueOn,
    }).subscribe({
      next: () => {
        this.planBusy.set(false);
        this.toast.success('Checkpoint added — you will be notified on that date');
        this.checkpointForm.controls.vaccineName.reset('');
        this.loadPlan(pet.id);
      },
      error: (err) => {
        this.planBusy.set(false);
        this.toast.error(err);
      },
    });
  }

  addLog(): void {
    const pet = this.pet();
    if (!pet) return;
    const v = this.logForm.getRawValue();
    if (!v.notes && !v.weightKg) {
      this.toast.info('Add a note or a weight before saving.');
      return;
    }
    this.savingLog.set(true);
    this.api.post(`/pets/${pet.id}/care/logs`, {
      type: v.type,
      notes: v.notes || null,
      value: v.type === 'weight' && v.weightKg ? { weightKg: v.weightKg } : {},
    }).subscribe({
      next: () => {
        this.savingLog.set(false);
        this.toast.success('Logged');
        this.logForm.reset({ type: 'observation', notes: '', weightKg: null });
        this.load(pet.id);
      },
      error: (err) => {
        this.savingLog.set(false);
        this.toast.error(err);
      },
    });
  }

  uploadPhoto(event: Event): void {
    const pet = this.pet();
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!pet || !file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('purpose', 'pet_photo');
    form.append('petId', pet.id);
    this.uploading.set(true);
    this.api.upload('/files', form).subscribe({
      next: (res) => {
        this.api.patch(`/pets/${pet.id}`, { photoFileId: res.file.id }).subscribe({
          next: () => {
            this.uploading.set(false);
            this.toast.success('Photo updated');
            this.load(pet.id);
          },
          error: (err) => {
            this.uploading.set(false);
            this.toast.error(err);
          },
        });
      },
      error: (err) => {
        this.uploading.set(false);
        this.toast.error(err);
      },
    });
  }

  startEdit(): void {
    const pet = this.pet();
    if (pet) this.patchProfileForm(pet);
    this.editing.set(true);
  }

  patchProfileForm(pet: Pet): void {
    this.profileForm.patchValue({
      name: pet.name,
      sex: pet.sex ?? 'unknown',
      birthDate: pet.birthDate ?? '',
      ageEstimateMonths: pet.ageEstimateMonths ?? null,
      weightKg: pet.weightKg != null ? Number(pet.weightKg) : null,
      weightMeasuredOn: pet.weightMeasuredOn ?? '',
      activityLevel: pet.activityLevel ?? 'unknown',
      livingEnvironment: pet.livingEnvironment ?? '',
      feedingNotes: pet.feedingNotes ?? '',
      foodPreferences: pet.foodPreferences ?? '',
      dietaryRestrictions: pet.dietaryRestrictions ?? '',
      allergies: pet.allergies ?? '',
      conditions: pet.conditions ?? '',
      medications: pet.medications ?? '',
      currentVetName: pet.currentVetName ?? '',
      currentVetClinic: pet.currentVetClinic ?? '',
    });
  }

  saveProfile(): void {
    const pet = this.pet();
    if (!pet || this.profileForm.invalid) {
      this.profileForm.markAllAsTouched();
      return;
    }
    const v = this.profileForm.getRawValue();
    this.savingProfile.set(true);
    const payload = {
      name: v.name,
      sex: v.sex,
      birthDate: v.birthDate || null,
      ageEstimateMonths: v.ageEstimateMonths ?? null,
      weightKg: v.weightKg ?? null,
      weightMeasuredOn: v.weightMeasuredOn || null,
      activityLevel: v.activityLevel,
      livingEnvironment: v.livingEnvironment || null,
      feedingNotes: v.feedingNotes || null,
      foodPreferences: v.foodPreferences || null,
      dietaryRestrictions: v.dietaryRestrictions || null,
      allergies: v.allergies || null,
      conditions: v.conditions || null,
      medications: v.medications || null,
      currentVetName: v.currentVetName || null,
      currentVetClinic: v.currentVetClinic || null,
    };
    this.api.patch(`/pets/${pet.id}`, payload).subscribe({
      next: (res: any) => {
        this.savingProfile.set(false);
        this.pet.set(res.pet);
        this.editing.set(false);
        this.toast.success('Profile saved');
      },
      error: (err) => {
        this.savingProfile.set(false);
        this.toast.error(err);
      },
    });
  }
}
