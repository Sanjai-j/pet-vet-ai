import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DatePipe, JsonPipe, SlicePipe } from '@angular/common';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ApiService } from '../core/api.service';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [
    RouterLink, FormsModule, ReactiveFormsModule, DatePipe, JsonPipe, SlicePipe, MatFormFieldModule, MatInputModule,
    MatSelectModule, MatButtonModule, MatSlideToggleModule,
  ],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">Administration</span>
          <h1>Platform console</h1>
          <p>Verification, approved knowledge, capability transparency, catalogs and audit. Actions are logged.</p>
        </div>
        <a mat-stroked-button routerLink="/dashboard">Platform overview</a>
      </div>

      <div class="admin-tabs">
        @for (tab of tabs; track tab.value) {
          <button type="button" [class.active]="tabValue() === tab.value" (click)="tabValue.set(tab.value)">{{ tab.label }}</button>
        }
      </div>

      @if (tabValue() === 'overview') {
        @if (stats(); as s) {
          <div class="kpi-row">
            <div class="stat"><span class="stat-label">Owners</span><span class="stat-value">{{ s['owners'] }}</span></div>
            <div class="stat"><span class="stat-label">Pets</span><span class="stat-value">{{ s['pets'] }}</span></div>
            <div class="stat"><span class="stat-label">Vets pending</span><span class="stat-value">{{ s['vets_pending'] }}</span></div>
            <div class="stat"><span class="stat-label">Vets verified</span><span class="stat-value">{{ s['vets_verified'] }}</span></div>
            <div class="stat"><span class="stat-label">Pending appts</span><span class="stat-value">{{ s['appointments_pending'] }}</span></div>
            <div class="stat"><span class="stat-label">Knowledge pending</span><span class="stat-value">{{ s['knowledge_pending'] }}</span></div>
            <div class="stat"><span class="stat-label">Vaccine schedules pending</span><span class="stat-value">{{ s['vaccine_schedules_pending'] }}</span></div>
            <div class="stat"><span class="stat-label">Open reports</span><span class="stat-value">{{ s['reports_open'] }}</span></div>
            <div class="stat"><span class="stat-label">AI messages 24h</span><span class="stat-value">{{ s['ai_messages_24h'] }}</span></div>
          </div>
        }
        <div class="split mt-2">
          <div class="card">
            <div class="card-head"><div><h3>Review queue</h3><p>Unverified veterinarians cannot be booked or listed.</p></div><button class="btn btn-secondary btn-sm" type="button" (click)="tabValue.set('vets')">Open verification</button></div>
            @for (vet of pendingVets(); track vet.id) {
              <div class="care-item">
                <div class="timeline-dot">🩺</div>
                <div style="flex:1">
                  <div class="care-title">{{ vet.fullName }} · {{ vet.licenseNumber }}</div>
                  <div class="care-meta">{{ vet.council }} · {{ vet.clinicName || 'Clinic not listed' }}</div>
                </div>
              </div>
            }
            @if (!pendingVets().length) { <div class="empty"><span class="empty-icon">✅</span>No pending verifications.</div> }
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Safety controls</h3><p>AI can be disabled globally without affecting emergency red-flag checks.</p></div></div>
            <div class="cap-row"><span>AI assistance</span><span class="badge" [class.badge-ok]="aiSettings()['enabled']" [class.badge-danger]="!aiSettings()['enabled']">{{ aiSettings()['enabled'] ? 'Enabled' : 'Disabled' }}</span></div>
            <div class="cap-row"><span>Language model</span><span class="badge" [class.badge-ok]="aiSettings()['llmEnabled']" [class.badge-warn]="!aiSettings()['llmEnabled']">{{ aiSettings()['llmEnabled'] ? 'Allowed if configured' : 'Blocked' }}</span></div>
            <p class="tiny muted mt-1">Emergency rules run before any AI answer and cannot be switched off by a model setting.</p>
            <button class="btn btn-secondary btn-sm" type="button" (click)="tabValue.set('system')">Open AI settings</button>
          </div>
        </div>
      }

      @if (tabValue() === 'vets') {
        <div class="card">
          <div class="card-head"><div><h3>Veterinarian verification</h3><p>Review credentials, then approve or reject. Notes are sent to the veterinarian.</p></div>
            <div class="pill-tabs">
              @for (filter of vetFilters; track filter.value) {
                <button type="button" [class.active]="vetFilter() === filter.value" (click)="vetFilter.set(filter.value)">{{ filter.label }}</button>
              }
            </div>
          </div>
          @for (vet of filteredVets(); track vet.id) {
            <div class="card tight" style="margin-bottom:.7rem;background:#FFFCF6">
              <div class="row" style="justify-content:space-between">
                <div>
                  <strong>{{ vet.fullName }}</strong>
                  <div class="small muted">{{ vet.email }} · {{ vet.city }}, {{ vet.state }}</div>
                </div>
                <span class="badge" [class.badge-warn]="vet.verificationStatus === 'pending'" [class.badge-ok]="vet.verificationStatus === 'verified'" [class.badge-danger]="vet.verificationStatus === 'rejected'">{{ vet.verificationStatus }}</span>
              </div>
              <div class="grid grid-3 mt-1">
                <div><div class="stat-label">License</div><div class="small mono">{{ vet.licenseNumber }}</div></div>
                <div><div class="stat-label">Council</div><div class="small">{{ vet.council }}</div></div>
                <div><div class="stat-label">Experience</div><div class="small">{{ vet.experienceYears ?? '—' }} years</div></div>
                <div><div class="stat-label">Clinic</div><div class="small">{{ vet.clinicName || '—' }}</div></div>
                <div><div class="stat-label">Species</div><div class="small">{{ vet.species?.join(', ') }}</div></div>
                <div><div class="stat-label">Fee</div><div class="small">{{ vet.feeInr ? '₹' + vet.feeInr : '—' }}</div></div>
              </div>
              @if (vet.bio) { <p class="small muted mt-1">{{ vet.bio }}</p> }
              @if (vet.verificationNotes) { <p class="tiny muted">Previous notes: {{ vet.verificationNotes }}</p> }
              <div class="row mt-1">
                <button class="btn btn-primary btn-sm" type="button" (click)="verify(vet, 'verified')">Approve</button>
                <button class="btn btn-secondary btn-sm" type="button" (click)="verify(vet, 'rejected')">Reject</button>
                <span class="tiny muted">Synthetic demo credential — approval is a product workflow demo, not a real license check.</span>
              </div>
            </div>
          }
          @if (!filteredVets().length) { <div class="empty"><span class="empty-icon">🩺</span>No veterinarians in this filter.</div> }
        </div>

        <div class="card mt-2">
          <div class="card-head">
            <div><h3>Verification applications</h3><p>Credential packs submitted by veterinarians. Approving publishes the profile in the directory and makes the vet bookable.</p></div>
            <div class="pill-tabs">
              @for (filter of applicationFilters; track filter.value) {
                <button type="button" [class.active]="applicationFilter() === filter.value" (click)="applicationFilter.set(filter.value)">{{ filter.label }}</button>
              }
            </div>
          </div>
          @for (app of filteredApplications(); track app.id) {
            <div class="card tight" style="margin-bottom:.7rem;background:#FFFCF6">
              <div class="row" style="justify-content:space-between">
                <div>
                  <strong>{{ app.fullName }}</strong>
                  <div class="small muted">{{ app.email }} · {{ app.city || '—' }}, {{ app.state || '—' }}</div>
                </div>
                <span class="badge"
                  [class.badge-warn]="app.status === 'submitted' || app.status === 'under_review' || app.status === 'additional_info_required'"
                  [class.badge-ok]="app.status === 'approved'"
                  [class.badge-danger]="app.status === 'rejected'">{{ app.status }}</span>
              </div>
              <div class="grid grid-3 mt-1">
                <div><div class="stat-label">Licence</div><div class="small mono">{{ app.licenseNumber || '—' }}</div></div>
                <div><div class="stat-label">Authority</div><div class="small">{{ app.registrationAuthority || '—' }}</div></div>
                <div><div class="stat-label">Qualification</div><div class="small">{{ app.qualification || '—' }}</div></div>
                <div><div class="stat-label">Experience</div><div class="small">{{ app.experienceYears ?? '—' }} years</div></div>
                <div><div class="stat-label">Documents</div><div class="small">{{ app.documentCount }} attached</div></div>
                <div><div class="stat-label">Submitted</div><div class="small">{{ app.submittedAt | slice: 0:10 }}</div></div>
              </div>
              @if (app.summary) { <p class="small muted mt-1">{{ app.summary }}</p> }
              @if (app.reviewNotes) { <p class="tiny muted">Previous notes: {{ app.reviewNotes }}</p> }
              @for (docId of app.documentIds; track docId) {
                <a class="tiny" [href]="api.fileUrl(docId)" target="_blank" rel="noopener">Attachment ↗</a>
              }
              <input class="input mt-1" style="width:100%" placeholder="Reviewer notes (sent to the veterinarian)"
                     [ngModel]="noteFor(app.id)" (ngModelChange)="setNote(app.id, $event)" />
              <div class="row mt-1">
                <button class="btn btn-secondary btn-sm" type="button" (click)="transitionApplication(app, 'under_review')" [disabled]="app.status === 'approved' || app.status === 'rejected'">Start review</button>
                <button class="btn btn-secondary btn-sm" type="button" (click)="transitionApplication(app, 'additional_info_required')">Need more info</button>
                <button class="btn btn-primary btn-sm" type="button" (click)="transitionApplication(app, 'approved')" [disabled]="app.status === 'approved'">Approve</button>
                <button class="btn btn-secondary btn-sm" type="button" (click)="transitionApplication(app, 'rejected')" [disabled]="app.status === 'rejected'">Reject</button>
                <span class="tiny muted">Demo workflow — no real registration register is queried.</span>
              </div>
            </div>
          }
          @if (!filteredApplications().length) { <div class="empty"><span class="empty-icon">📄</span>No applications in this filter.</div> }
        </div>

        <div class="card mt-2">
          <div class="card-head"><div><h3>Clinic association requests</h3><p>A veterinarian may claim a Google Maps listing. Nothing is linked until an administrator approves it.</p></div></div>
          @for (assoc of associations(); track assoc.id) {
            <div class="care-item">
              <div class="timeline-dot">🏥</div>
              <div style="flex:1">
                <div class="care-title">{{ assoc.clinicName }} — {{ assoc.vetName }}</div>
                <div class="care-meta">{{ assoc.status }}@if (assoc.evidence) { · {{ assoc.evidence }} }</div>
              </div>
              @if (assoc.status === 'pending') {
                <div class="row-tight">
                  <button class="btn btn-primary btn-sm" type="button" (click)="transitionAssociation(assoc, 'approved')">Approve</button>
                  <button class="btn btn-secondary btn-sm" type="button" (click)="transitionAssociation(assoc, 'rejected')">Reject</button>
                </div>
              }
            </div>
          }
          @if (!associations().length) { <div class="empty"><span class="empty-icon">🔗</span>No clinic association requests.</div> }
        </div>
      }

      @if (tabValue() === 'knowledge') {
        <div class="split">
          <div class="card">
            <div class="card-head"><div><h3>Knowledge documents</h3><p>Only approved documents are retrievable by the AI. Editing an approved document returns it to review.</p></div>
              <div class="pill-tabs">
                @for (filter of knowledgeFilters; track filter.value) {
                  <button type="button" [class.active]="knowledgeFilter() === filter.value" (click)="knowledgeFilter.set(filter.value)">{{ filter.label }}</button>
                }
              </div>
            </div>
            @for (doc of filteredKnowledge(); track doc.id) {
              <div class="card tight" style="margin-bottom:.7rem;background:#FFFCF6">
                <div class="row" style="justify-content:space-between">
                  <div>
                    <strong>{{ doc.title }}</strong>
                    <div class="tiny muted">{{ doc.sourceOrg }} · {{ doc.category }} · species: {{ doc.species?.join(', ') }}</div>
                  </div>
                  <div class="row-tight">
                    @if (doc.isDemo) { <span class="badge badge-demo">Demo corpus</span> }
                    <span class="badge" [class.badge-warn]="doc.status === 'pending'" [class.badge-ok]="doc.status === 'approved'" [class.badge-danger]="doc.status === 'rejected'">{{ doc.status }}</span>
                  </div>
                </div>
                <div class="knowledge-body mt-1">{{ expandedDoc() === doc.id ? doc.content : (doc.content | slice:0:280) + (doc.content.length > 280 ? '…' : '') }}</div>
                <div class="row mt-1">
                  <button class="btn btn-ghost btn-sm" type="button" (click)="expandedDoc.set(expandedDoc() === doc.id ? null : doc.id)">{{ expandedDoc() === doc.id ? 'Collapse' : 'Read full text' }}</button>
                  <span class="spacer"></span>
                  <button class="btn btn-primary btn-sm" type="button" (click)="review(doc, 'approved')">Approve</button>
                  <button class="btn btn-secondary btn-sm" type="button" (click)="review(doc, 'rejected')">Reject</button>
                </div>
                @if (doc.reviewNotes) { <p class="tiny muted">Review notes: {{ doc.reviewNotes }}</p> }
              </div>
            }
            @if (!filteredKnowledge().length) { <div class="empty"><span class="empty-icon">📚</span>No documents in this filter.</div> }
          </div>

          <form [formGroup]="knowledgeForm" (ngSubmit)="addKnowledge()" class="card">
            <h3>Add a knowledge document</h3>
            <p class="tiny muted">Documents enter the review queue. Do not upload copyrighted material you cannot use.</p>
            <mat-form-field appearance="outline"><mat-label>Title</mat-label><input matInput formControlName="title" /></mat-form-field>
            <div class="field">
              <span class="field-label">Species</span>
              <div class="row">
                @for (sp of speciesOptions; track sp.code) {
                  <label class="check-row" style="border:1px solid var(--line);border-radius:999px;padding:.25rem .6rem;margin:0">
                    <input type="checkbox" [checked]="docSpecies().includes(sp.code)" (change)="toggleDocSpecies(sp.code)" />
                    <span>{{ sp.name }}</span>
                  </label>
                }
              </div>
            </div>
            <mat-form-field appearance="outline"><mat-label>Category</mat-label><input matInput formControlName="category" placeholder="emergency, nutrition…" /></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Source organization</mat-label><input matInput formControlName="sourceOrg" /></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Source URL (optional)</mat-label><input matInput formControlName="sourceUrl" /></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Published year</mat-label><input matInput type="number" formControlName="publishedYear" /></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Content</mat-label><textarea matInput rows="8" formControlName="content" placeholder="General, safe reference text with clear limits."></textarea></mat-form-field>
            <mat-slide-toggle formControlName="isDemo">Mark as synthetic demo content</mat-slide-toggle>
            <button mat-flat-button color="primary" type="submit" [disabled]="savingDoc()" style="margin-top:.8rem">{{ savingDoc() ? 'Submitting…' : 'Submit for review' }}</button>
          </form>
        </div>
      }

      @if (tabValue() === 'vaccines') {
        <div class="banner banner-info" style="margin-bottom:1rem">
          <span class="banner-icon">💉</span>
          <div><strong>Imported vaccination schedules reach pet owners only after approval</strong><p>Only approved rows that state a concrete age and general guidance can create age-based checkpoints. Rows that need a veterinary decision stay reference text.</p></div>
        </div>
        <div class="card">
          <div class="card-head">
            <div><h3>Vaccination schedule reference</h3><p>Import a workbook with npm run import:vaccine-schedule -- &lt;file.xlsx&gt;. A pending row schedules nothing.</p></div>
            <div class="pill-tabs">
              @for (filter of vaccineFilters; track filter.value) {
                <button type="button" [class.active]="vaccineFilter() === filter.value" (click)="vaccineFilter.set(filter.value)">{{ filter.label }}</button>
              }
            </div>
          </div>
          @for (row of filteredVaccineSchedules(); track row.id) {
            <div class="card tight" style="margin-bottom:.7rem;background:#FFFCF6">
              <div class="row" style="justify-content:space-between">
                <div>
                  <strong>{{ row.vaccineName }}</strong>
                  <div class="tiny muted">{{ row.speciesLabel }} · {{ row.referenceBasis }} · {{ row.guidanceLevel }}</div>
                </div>
                <div class="row-tight">
                  @if (row.isDemo) { <span class="badge badge-demo">Demo row</span> }
                  @if (row.autoAssignable) { <span class="badge badge-ok">Can schedule</span> }
                  <span class="badge" [class.badge-warn]="row.status === 'pending'" [class.badge-ok]="row.status === 'approved'" [class.badge-danger]="row.status === 'rejected'">{{ row.status }}</span>
                </div>
              </div>
              <div class="grid grid-3 mt-1">
                <div><div class="stat-label">First dose</div><div class="small">{{ row.firstDoseAgeText }}</div></div>
                <div><div class="stat-label">Primary series</div><div class="small">{{ row.primarySeriesText }}</div></div>
                <div><div class="stat-label">Booster</div><div class="small">{{ row.boosterIntervalText }}</div></div>
              </div>
              @if (row.mustCheck) { <p class="tiny muted">Check before scheduling: {{ row.mustCheck }}</p> }
              @if (row.reviewNotes) { <p class="tiny muted">Review notes: {{ row.reviewNotes }}</p> }
              <div class="row mt-1">
                <button class="btn btn-primary btn-sm" type="button" (click)="reviewVaccineSchedule(row, 'approved')">Approve</button>
                <button class="btn btn-secondary btn-sm" type="button" (click)="reviewVaccineSchedule(row, 'rejected')">Reject</button>
                <span class="spacer"></span>
                <span class="tiny muted">{{ row.reviewedBy ? 'Reviewed by ' + row.reviewedBy : 'Not reviewed yet' }}</span>
              </div>
            </div>
          }
          @if (!filteredVaccineSchedules().length) { <div class="empty"><span class="empty-icon">💉</span>No schedule rows in this filter.</div> }
        </div>
      }

      @if (tabValue() === 'nutrition') {
        <div class="banner banner-info" style="margin-bottom:1rem">
          <span class="banner-icon">🥗</span>
          <div><strong>Only approved records reach pet owners and the RAG knowledge base</strong><p>Imported workbook rows start as pending. Editing an approved record returns it to this queue. Every decision is versioned.</p></div>
        </div>

        <div class="kpi-row">
          @for (q of nutritionQueue(); track q.kind) {
            <div class="stat">
              <span class="stat-label">{{ kindLabel(q.kind) }}</span>
              <span class="stat-value">{{ q.pending }}</span>
              <span class="tiny muted">pending · {{ q.approved }} approved · {{ q.rejected }} rejected</span>
            </div>
          }
        </div>

        <div class="card mt-2">
          <div class="card-head">
            <div><h3>Review nutrition records</h3><p>Approve, reject, edit, or inspect the version history of each record.</p></div>
            <div class="pill-tabs">
              @for (k of nutritionKinds; track k.value) {
                <button type="button" [class.active]="nutritionKind() === k.value" (click)="selectNutritionKind(k.value)">{{ k.label }}</button>
              }
            </div>
          </div>
          <div class="row" style="margin-bottom:.7rem;flex-wrap:wrap;gap:.5rem;align-items:center">
            <div class="pill-tabs">
              @for (f of nutritionStatusFilters; track f.value) {
                <button type="button" [class.active]="nutritionStatus() === f.value" (click)="nutritionStatus.set(f.value); loadNutritionRecords()">{{ f.label }}</button>
              }
            </div>
            <span class="spacer"></span>
            <mat-form-field appearance="outline" style="width:180px">
              <mat-label>Species</mat-label>
              <mat-select [(ngModel)]="nutritionSpecies" (ngModelChange)="loadNutritionRecords()">
                @for (sp of nutritionSpeciesOptions; track sp.value) {
                  <mat-option [value]="sp.value">{{ sp.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <button class="btn btn-primary btn-sm" type="button"
                    [disabled]="bulkBusy() || !pendingNutritionCount()"
                    (click)="bulkReview('approved')">
              {{ bulkBusy() ? 'Working…' : 'Approve all pending' }}
            </button>
            <button class="btn btn-secondary btn-sm" type="button"
                    [disabled]="bulkBusy() || !pendingNutritionCount()"
                    (click)="bulkReview('rejected')">Reject all pending</button>
          </div>

          @for (rec of nutritionRecords(); track rec.id) {
            <div class="card tight" style="margin-bottom:.7rem;background:#FFFCF6">
              <div class="row" style="justify-content:space-between">
                <div>
                  <strong>{{ nutritionTitle(rec) }}</strong>
                  <div class="tiny muted">{{ nutritionSummary(rec) }}</div>
                </div>
                <span class="badge"
                  [class.badge-warn]="rec.review_status === 'pending'"
                  [class.badge-ok]="rec.review_status === 'approved'"
                  [class.badge-danger]="rec.review_status === 'rejected'">{{ rec.review_status }}</span>
              </div>
              <p class="small mt-1" style="margin-bottom:.3rem">{{ nutritionBody(rec) }}</p>
              <p class="tiny muted" style="margin:0">
                v{{ rec.version }} · updated {{ rec.updated_at | date:'mediumDate' }}
                @if (rec.review_notes) { · notes: {{ rec.review_notes }} }
              </p>

              @if (editingNutrition() === rec) {
                <div class="mt-1" style="border-top:1px dashed var(--line);padding-top:.7rem">
                  @for (field of nutritionEditable[nutritionKind()]; track field) {
                    @if (field === 'severity') {
                      <mat-form-field appearance="outline">
                        <mat-label>Severity</mat-label>
                        <mat-select [(ngModel)]="nutritionEdit[field]">
                          <mat-option value="toxic">toxic</mat-option>
                          <mat-option value="potentially_toxic">potentially_toxic</mat-option>
                          <mat-option value="dangerous">dangerous</mat-option>
                          <mat-option value="caution">caution</mat-option>
                          <mat-option value="nutritionally_inappropriate">nutritionally_inappropriate</mat-option>
                          <mat-option value="unknown">unknown</mat-option>
                        </mat-select>
                      </mat-form-field>
                    } @else if (field === 'storageKnown') {
                      <mat-slide-toggle [(ngModel)]="nutritionEdit[field]">Storage instructions are known</mat-slide-toggle>
                    } @else {
                      <mat-form-field appearance="outline">
                        <mat-label>{{ fieldLabel(field) }}</mat-label>
                        <textarea matInput rows="3" [(ngModel)]="nutritionEdit[field]"></textarea>
                      </mat-form-field>
                    }
                  }
                  <div class="row">
                    <button class="btn btn-primary btn-sm" type="button" (click)="saveNutritionEdit()">Save changes</button>
                    <button class="btn btn-ghost btn-sm" type="button" (click)="editingNutrition.set(null)">Cancel</button>
                  </div>
                </div>
              }

              @if (expandedNutritionVersion() === rec.id) {
                <div class="mt-1" style="border-top:1px dashed var(--line);padding-top:.7rem">
                  <div class="stat-label">Version history</div>
                  @for (v of nutritionVersions()[rec.id] ?? []; track v.id) {
                    <div class="tiny muted">v{{ v.version }} · {{ v.action }} · {{ v.actorName || 'import' }} · {{ v.createdAt | date:'short' }}@if (v.notes) { — {{ v.notes }} }</div>
                  }
                  @if (!(nutritionVersions()[rec.id] ?? []).length) { <p class="tiny muted" style="margin:0">No version entries recorded.</p> }
                </div>
              }

              <div class="row mt-1">
                <button class="btn btn-secondary btn-sm" type="button" (click)="editNutrition(rec)">Edit</button>
                <button class="btn btn-ghost btn-sm" type="button" (click)="toggleNutritionVersions(rec)">{{ expandedNutritionVersion() === rec.id ? 'Hide history' : 'History' }}</button>
                <span class="spacer"></span>
                <button class="btn btn-primary btn-sm" type="button" (click)="reviewNutrition(rec, 'approved')" [disabled]="rec.review_status === 'approved'">Approve</button>
                <button class="btn btn-secondary btn-sm" type="button" (click)="reviewNutrition(rec, 'rejected')" [disabled]="rec.review_status === 'rejected'">Reject</button>
                @if (rec.review_status === 'rejected') {
                  <button class="btn btn-ghost btn-sm" type="button" (click)="reviewNutrition(rec, 'pending')">Reopen</button>
                }
              </div>
            </div>
          }
          @if (!nutritionRecords().length) {
            <div class="empty"><span class="empty-icon">🥗</span>No {{ kindLabel(nutritionKind()).toLowerCase() }} records in this filter. Import the starter workbook with <span class="mono">npm run import:workbook</span>.</div>
          }
        </div>
      }

      @if (tabValue() === 'catalog') {
        <div class="split">
          <div class="card">
            <div class="card-head"><div><h3>Species and breeds</h3><p>The catalog drives onboarding options. Deactivate rather than delete to preserve history.</p></div></div>
            @for (sp of species(); track sp.code) {
              <div class="card tight" style="margin-bottom:.7rem;background:#FFFCF6">
                <div class="row" style="justify-content:space-between">
                  <strong>{{ sp.icon }} {{ sp.name }} <span class="tiny muted">({{ sp.code }})</span></strong>
                  <div class="row-tight">
                    <span class="badge badge-neutral">{{ breedCount(sp.code) }} breeds</span>
                    <button class="btn btn-ghost btn-sm" type="button" (click)="toggleSpeciesActive(sp)">{{ sp.is_active ? 'Deactivate' : 'Activate' }}</button>
                  </div>
                </div>
                <div class="chip-row mt-1">
                  @for (breed of breedsFor(sp.code); track breed.id) {
                    <span class="chip">
                      {{ breed.name }}
                      @if (!breed.is_active) { <span class="badge badge-neutral">off</span> }
                      <button class="icon-btn" style="width:22px;height:22px;font-size:.7rem" type="button" (click)="toggleBreed(breed)" [attr.aria-label]="'Toggle ' + breed.name">✕</button>
                    </span>
                  }
                </div>
              </div>
            }
          </div>
          <form [formGroup]="breedForm" (ngSubmit)="addBreed()" class="card">
            <h3>Add a breed</h3>
            <mat-form-field appearance="outline">
              <mat-label>Species</mat-label>
              <mat-select formControlName="speciesCode">
                @for (sp of species(); track sp.code) { <mat-option [value]="sp.code">{{ sp.name }}</mat-option> }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Breed or animal type</mat-label><input matInput formControlName="name" /></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Notes (optional)</mat-label><textarea matInput rows="2" formControlName="notes"></textarea></mat-form-field>
            <mat-slide-toggle formControlName="isUnknown">This is my “Other / Unknown” option</mat-slide-toggle>
            <button mat-flat-button color="primary" type="submit" style="margin-top:.8rem">Add breed</button>
          </form>
        </div>
      }

      @if (tabValue() === 'capabilities') {
        <div class="banner banner-info" style="margin-bottom:1rem">
          <span class="banner-icon">📊</span>
          <div><strong>Capability status must reflect evidence</strong><p>Do not mark a task “validated” because a model can answer. Technical tests are not clinical validation.</p></div>
        </div>
        <div class="grid grid-2">
          @for (cap of capabilities(); track cap.id) {
            <div class="card">
              <div class="row" style="justify-content:space-between">
                <strong>{{ cap.speciesName }} · {{ cap.task }}</strong>
                <span class="badge" [class.badge-ok]="cap.status === 'validated'" [class.badge-warn]="cap.status === 'limited'" [class.badge-danger]="cap.status === 'not_supported'">{{ cap.status }}</span>
              </div>
              <mat-form-field appearance="outline" style="margin-top:.6rem">
                <mat-label>Status</mat-label>
                <mat-select [(ngModel)]="cap.status">
                  <mat-option value="validated">Validated</mat-option>
                  <mat-option value="limited">Limited</mat-option>
                  <mat-option value="not_supported">Not yet supported</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Evidence summary</mat-label>
                <textarea matInput rows="2" [(ngModel)]="cap.evidenceSummary"></textarea>
              </mat-form-field>
              <button class="btn btn-secondary btn-sm" type="button" (click)="saveCapability(cap)">Save capability</button>
            </div>
          }
        </div>
      }

      @if (tabValue() === 'users') {
        <div class="card">
          <div class="card-head"><div><h3>Users</h3><p>Disabling an account blocks sign-in immediately. You cannot disable yourself.</p></div>
            <div class="row"><input class="input" style="width:220px" [(ngModel)]="userQuery" placeholder="Search name or email" /><button class="btn btn-secondary btn-sm" type="button" (click)="loadUsers()">Search</button></div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Pets</th><th>Created</th><th>Status</th><th></th></tr></thead>
              <tbody>
                @for (user of users(); track user.id) {
                  <tr>
                    <td>{{ user.fullName }}</td>
                    <td class="mono">{{ user.email }}</td>
                    <td><span class="badge badge-neutral">{{ user.role }}</span></td>
                    <td>{{ user.petCount }}</td>
                    <td class="tiny">{{ user.createdAt | date:'mediumDate' }}</td>
                    <td><span class="badge" [class.badge-danger]="user.disabled" [class.badge-ok]="!user.disabled">{{ user.disabled ? 'disabled' : 'active' }}</span></td>
                    <td><button class="btn btn-ghost btn-sm" type="button" (click)="toggleUser(user)">{{ user.disabled ? 'Enable' : 'Disable' }}</button></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        <div class="card mt-2">
          <div class="card-head"><div><h3>Audit log</h3><p>Recent privileged actions.</p></div></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
              <tbody>
                @for (entry of audit(); track entry.id) {
                  <tr>
                    <td class="tiny">{{ entry.createdAt | date:'short' }}</td>
                    <td class="small">{{ entry.actorName || 'system' }}</td>
                    <td class="mono">{{ entry.action }}</td>
                    <td class="small">{{ entry.entity }}{{ entry.entityId ? ' · ' + entry.entityId : '' }}</td>
                    <td class="tiny muted">{{ entry.meta | json }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      }

      @if (tabValue() === 'system') {
        <div class="split">
          <div class="card">
            <div class="card-head"><div><h3>AI settings</h3><p>Emergency red-flag detection always runs. These settings control general AI answers.</p></div></div>
            <div class="switch-row">
              <div><strong>Enable AI assistance</strong><p>Disabling returns a transparent message and a veterinary referral.</p></div>
              <mat-slide-toggle [ngModel]="aiEnabled()" (ngModelChange)="aiEnabled.set($event)"></mat-slide-toggle>
            </div>
            <div class="switch-row">
              <div><strong>Allow configured language model</strong><p>If no provider key is configured, the deterministic reference composer is used instead.</p></div>
              <mat-slide-toggle [ngModel]="llmEnabled()" (ngModelChange)="llmEnabled.set($event)"></mat-slide-toggle>
            </div>
            <mat-form-field appearance="outline" style="margin-top:.8rem">
              <mat-label>Global disclaimer</mat-label>
              <textarea matInput rows="3" [(ngModel)]="disclaimer"></textarea>
            </mat-form-field>
            <button mat-flat-button color="primary" type="button" (click)="saveAiSettings()">Save AI settings</button>

            <div class="divider"></div>
            <h3>Technical evaluation runs</h3>
            <p class="tiny muted">Technical regression results only — not clinical validation.</p>
            @for (run of evaluations(); track run.id) {
              <div class="care-item">
                <div class="timeline-dot">🧪</div>
                <div>
                  <div class="care-title">{{ run.name }}</div>
                  <div class="care-meta">{{ run.capability }} · {{ run.passed }}/{{ run.datasetSize }} passed · {{ run.createdAt | date:'mediumDate' }}</div>
                </div>
              </div>
            }
            @if (!evaluations().length) { <p class="small muted">No evaluation runs recorded.</p> }
          </div>

          <div class="stack">
            <div class="card">
              <h3>Content reports</h3>
              @for (report of reports(); track report.id) {
                <div class="card tight" style="margin-bottom:.5rem;background:#FFFCF6">
                  <div class="row" style="justify-content:space-between">
                    <strong class="small">{{ report.targetType }} · {{ report.targetId }}</strong>
                    <span class="badge" [class.badge-warn]="report.status === 'open'" [class.badge-ok]="report.status === 'resolved'">{{ report.status }}</span>
                  </div>
                  <p class="small" style="margin:.3rem 0">{{ report.reason }}</p>
                  @if (report.status === 'open') {
                    <div class="row">
                      <button class="btn btn-secondary btn-sm" type="button" (click)="resolveReport(report, 'resolved')">Resolve</button>
                      <button class="btn btn-ghost btn-sm" type="button" (click)="resolveReport(report, 'dismissed')">Dismiss</button>
                    </div>
                  }
                </div>
              }
              @if (!reports().length) { <div class="empty"><span class="empty-icon">✅</span>No reports.</div> }
            </div>
            <div class="banner banner-teal">
              <span class="banner-icon">🔐</span>
              <div><strong>Administrator access is logged</strong><p>Every verification, knowledge approval, catalog change and settings update is recorded in the audit trail.</p></div>
            </div>
          </div>
        </div>
      }

      @if (action(); as act) {
        <div class="modal-backdrop" role="dialog" aria-modal="true" [attr.aria-label]="act.title">
          <div class="card raised modal-card">
            <h3>{{ act.title }}</h3>
            <p class="small muted">{{ act.label }}</p>
            <textarea class="input" rows="3" [(ngModel)]="actionNote" [placeholder]="act.required ? 'Required note' : 'Optional note'"></textarea>
            <div class="form-actions">
              <button class="btn btn-secondary" type="button" (click)="action.set(null)">Cancel</button>
              <button class="btn btn-primary" type="button" (click)="confirmAction()">Confirm</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class AdminComponent implements OnInit {
  readonly api = inject(ApiService);
  private toast = inject(ToastService);
  private fb = inject(FormBuilder);

  readonly tabValue = signal('overview');
  readonly tabs = [
    { label: 'Overview', value: 'overview' },
    { label: 'Veterinarians', value: 'vets' },
    { label: 'Knowledge', value: 'knowledge' },
    { label: 'Nutrition', value: 'nutrition' },
    { label: 'Vaccines', value: 'vaccines' },
    { label: 'Catalog', value: 'catalog' },
    { label: 'Capabilities', value: 'capabilities' },
    { label: 'Users & audit', value: 'users' },
    { label: 'System & AI', value: 'system' },
  ];

  readonly stats = signal<Record<string, number> | null>(null);
  readonly vets = signal<any[]>([]);
  readonly vetFilter = signal('pending');
  readonly knowledge = signal<any[]>([]);
  readonly knowledgeFilter = signal('pending');
  readonly expandedDoc = signal<string | null>(null);
  readonly species = signal<any[]>([]);
  readonly breeds = signal<any[]>([]);
  readonly capabilities = signal<any[]>([]);
  readonly users = signal<any[]>([]);
  readonly audit = signal<any[]>([]);
  readonly reports = signal<any[]>([]);
  readonly evaluations = signal<any[]>([]);
  readonly aiSettings = signal<Record<string, any>>({});
  readonly aiEnabled = signal(true);
  readonly llmEnabled = signal(true);
  disclaimer = '';
  userQuery = '';

  readonly applications = signal<any[]>([]);
  readonly associations = signal<any[]>([]);
  readonly applicationFilter = signal('submitted');
  readonly applicationFilters = [
    { label: 'New', value: 'submitted' },
    { label: 'In review', value: 'under_review' },
    { label: 'Need info', value: 'additional_info_required' },
    { label: 'Approved', value: 'approved' },
    { label: 'Rejected', value: 'rejected' },
    { label: 'All', value: '' },
  ];
  private reviewNotes = new Map<string, string>();

  readonly vetFilters = [
    { label: 'Pending', value: 'pending' },
    { label: 'Verified', value: 'verified' },
    { label: 'Rejected', value: 'rejected' },
    { label: 'All', value: '' },
  ];
  readonly knowledgeFilters = [
    { label: 'Pending', value: 'pending' },
    { label: 'Approved', value: 'approved' },
    { label: 'Rejected', value: 'rejected' },
    { label: 'All', value: '' },
  ];
  readonly vaccineSchedules = signal<any[]>([]);
  readonly vaccineFilter = signal('pending');
  readonly vaccineFilters = [
    { label: 'Pending', value: 'pending' },
    { label: 'Approved', value: 'approved' },
    { label: 'Rejected', value: 'rejected' },
    { label: 'All', value: '' },
  ];
  readonly speciesOptions = [
    { code: 'dog', name: 'Dogs' }, { code: 'cat', name: 'Cats' }, { code: 'bird', name: 'Birds' },
    { code: 'cow', name: 'Cattle' }, { code: 'goat', name: 'Goats' }, { code: 'other', name: 'Other' },
  ];
  readonly docSpecies = signal<string[]>(['dog']);

  // ── Nutrition knowledge review ──
  readonly nutritionQueue = signal<any[]>([]);
  readonly nutritionRecords = signal<any[]>([]);
  readonly nutritionKind = signal<string>('hazard');
  readonly nutritionStatus = signal('pending');
  readonly editingNutrition = signal<any | null>(null);
  readonly expandedNutritionVersion = signal<string | null>(null);
  readonly nutritionVersions = signal<Record<string, any[]>>({});
  nutritionEdit: Record<string, any> = {};
  readonly nutritionKinds = [
    { label: 'Foods to avoid', value: 'hazard' },
    { label: 'Suitable foods', value: 'guidance' },
    { label: 'Recipes', value: 'recipe' },
    { label: 'Health rules', value: 'health_rule' },
    { label: 'Breed context', value: 'breed' },
    { label: 'Sources', value: 'source' },
  ];
  readonly nutritionStatusFilters = [
    { label: 'Pending', value: 'pending' },
    { label: 'Approved', value: 'approved' },
    { label: 'Rejected', value: 'rejected' },
    { label: 'All', value: 'all' },
  ];
  readonly nutritionSpecies = signal('');
  readonly nutritionSpeciesOptions = [
    { value: '', label: 'All species' },
    { value: 'dog', label: '🐕 Dog' },
    { value: 'cat', label: '🐈 Cat' },
    { value: 'bird', label: '🦜 Bird' },
    { value: 'cow', label: '🐄 Cow' },
    { value: 'goat', label: '🐐 Goat' },
    { value: 'other', label: '🐾 Other' },
  ];
  readonly bulkBusy = signal(false);
  readonly nutritionEditable: Record<string, string[]> = {
    guidance: ['generalDietGuidance', 'suitableFoodsText', 'hazardsToAvoidText', 'recipeGuidanceText', 'goalSpecificGuidance', 'safetyCautions', 'disclaimer'],
    hazard: ['classification', 'severity', 'risk', 'recommendedAction'],
    recipe: ['dietRole', 'applicability', 'safetyNotes', 'storageInstructions', 'storageKnown'],
    breed: ['generalGuidance', 'limitation', 'referralRule'],
    health_rule: ['generalGuidance', 'safetyRule', 'referralRule'],
    source: ['usageNotes'],
  };

  readonly knowledgeForm = this.fb.nonNullable.group({
    title: ['', Validators.required],
    category: ['general', Validators.required],
    sourceOrg: ['', Validators.required],
    sourceUrl: [''],
    publishedYear: [null as number | null],
    content: ['', [Validators.required, Validators.minLength(50)]],
    isDemo: [true],
  });

  readonly breedForm = this.fb.nonNullable.group({
    speciesCode: ['dog', Validators.required],
    name: ['', Validators.required],
    notes: [''],
    isUnknown: [false],
  });

  ngOnInit(): void {
    this.loadAll();
  }

  loadAll(): void {
    this.api.get<any>('/admin/stats').subscribe({ next: (res) => this.stats.set(res.stats) });
    this.api.get<any>('/admin/vets').subscribe({ next: (res) => this.vets.set(res.veterinarians ?? []) });
    this.api.get<any>('/admin/knowledge').subscribe({ next: (res) => this.knowledge.set(res.documents ?? []) });
    this.loadVaccineSchedules();
    this.api.get<any>('/admin/species').subscribe({
      next: (res) => {
        this.species.set(res.species ?? []);
        this.breeds.set(res.breeds ?? []);
      },
    });
    this.api.get<any>('/capabilities').subscribe({ next: (res) => this.capabilities.set(res.capabilities ?? []) });
    this.api.get<any>('/admin/users').subscribe({ next: (res) => this.users.set(res.users ?? []) });
    this.api.get<any>('/admin/audit').subscribe({ next: (res) => this.audit.set(res.entries ?? []) });
    this.api.get<any>('/admin/reports').subscribe({ next: (res) => this.reports.set(res.reports ?? []) });
    this.api.get<any>('/admin/evaluations').subscribe({ next: (res) => this.evaluations.set(res.evaluations ?? []) });
    this.api.get<any>('/directory/admin/applications').subscribe({
      next: (res) => this.applications.set(res.applications ?? []),
    });
    this.api.get<any>('/admin/nutrition/queue').subscribe({
      next: (res) => this.nutritionQueue.set(res.queue ?? []),
    });
    this.loadNutritionRecords();
    this.api.get<any>('/directory/admin/associations').subscribe({
      next: (res) => this.associations.set(res.associations ?? []),
    });
    this.api.get<any>('/admin/settings').subscribe({
      next: (res) => {
        const ai = (res.settings ?? []).find((s: any) => s.key === 'ai')?.value ?? {};
        this.aiSettings.set(ai);
        this.aiEnabled.set(ai.enabled !== false);
        this.llmEnabled.set(ai.llmEnabled !== false);
        this.disclaimer = ai.disclaimer ?? '';
      },
    });
  }

  pendingVets(): any[] {
    return this.vets().filter((v) => v.verificationStatus === 'pending');
  }

  filteredVets(): any[] {
    const filter = this.vetFilter();
    return filter ? this.vets().filter((v) => v.verificationStatus === filter) : this.vets();
  }

  filteredApplications(): any[] {
    const filter = this.applicationFilter();
    return filter ? this.applications().filter((a) => a.status === filter) : this.applications();
  }

  noteFor(id: string): string {
    return this.reviewNotes.get(id) ?? '';
  }

  setNote(id: string, value: string): void {
    this.reviewNotes.set(id, value);
  }

  transitionApplication(app: any, action: 'under_review' | 'additional_info_required' | 'approved' | 'rejected'): void {
    const notes = this.noteFor(app.id).trim();
    if (action === 'rejected' && !notes) {
      this.toast.info('Add a reason before rejecting — the applicant reads it.');
      return;
    }
    this.api
      .post(`/directory/admin/applications/${app.id}/transition`, { action, notes: notes || undefined })
      .subscribe({
        next: () => {
          this.toast.success(`Application ${action.replace('_', ' ')}`);
          this.reviewNotes.delete(app.id);
          this.loadAll();
        },
        error: (err) => this.toast.error(err),
      });
  }

  transitionAssociation(assoc: any, action: 'approved' | 'rejected'): void {
    this.api
      .post(`/directory/admin/associations/${assoc.id}/transition`, { action })
      .subscribe({
        next: () => {
          this.toast.success(`Clinic link ${action}`);
          this.loadAll();
        },
        error: (err) => this.toast.error(err),
      });
  }

  filteredKnowledge(): any[] {
    const filter = this.knowledgeFilter();
    return filter ? this.knowledge().filter((d) => d.status === filter) : this.knowledge();
  }

  filteredVaccineSchedules(): any[] {
    const filter = this.vaccineFilter();
    return filter ? this.vaccineSchedules().filter((row) => row.status === filter) : this.vaccineSchedules();
  }

  loadVaccineSchedules(): void {
    this.api.get<any>('/admin/vaccine-schedules').subscribe({
      next: (res) => this.vaccineSchedules.set(res.schedules ?? []),
    });
  }

  reviewVaccineSchedule(row: any, status: 'approved' | 'rejected'): void {
    const reviewNotes = status === 'approved'
      ? 'Approved in the admin console. Dates remain general guidance; the owner confirms each one with a veterinarian.'
      : 'Rejected in the admin console.';
    this.api.patch(`/admin/vaccine-schedules/${row.id}`, { status, reviewNotes }).subscribe({
      next: () => {
        this.toast.success(`Schedule ${status}`);
        this.loadVaccineSchedules();
      },
      error: (err) => this.toast.error(err),
    });
  }

  breedCount(speciesCode: string): number {
    return this.breeds().filter((b) => b.species_code === speciesCode && b.is_active).length;
  }

  breedsFor(speciesCode: string): any[] {
    return this.breeds().filter((b) => b.species_code === speciesCode);
  }

  verify(vet: any, status: 'verified' | 'rejected'): void {
    this.actionNote = '';
    this.action.set({
      kind: 'verify',
      record: vet,
      status,
      title: status === 'verified' ? `Approve ${vet.fullName}` : `Reject ${vet.fullName}`,
      label: status === 'verified'
        ? 'Verification note. This demo cannot validate a real license, so approval only demonstrates the workflow.'
        : 'Reason for rejection (sent to the veterinarian).',
      required: status === 'rejected',
    });
  }

  review(doc: any, status: 'approved' | 'rejected'): void {
    this.actionNote = '';
    this.action.set({
      kind: 'review',
      record: doc,
      status,
      title: status === 'approved' ? `Approve “${doc.title}”` : `Reject “${doc.title}”`,
      label: status === 'approved'
        ? 'Review note (optional). Approved documents become retrievable by the AI immediately.'
        : 'Reason for rejection. Documented clinical review responsibility is required.',
      required: status === 'rejected',
    });
  }

  confirmAction(): void {
    const action = this.action();
    if (!action) return;
    const note = this.actionNote.trim();
    if (action.required && !note) {
      this.toast.info('A note is required for this decision.');
      return;
    }
    const done = (message: string) => () => {
      this.action.set(null);
      this.toast.success(message);
      this.loadAll();
    };
    const fail = (err: unknown) => this.toast.error(err);

    if (action.kind === 'verify') {
      this.api.patch(`/admin/vets/${action.record.id}/verification`, {
        status: action.status,
        notes: note || undefined,
      }).subscribe({ next: done(`Veterinarian ${action.status}`), error: fail });
      return;
    }
    if (action.kind === 'review') {
      this.api.patch(`/admin/knowledge/${action.record.id}`, {
        status: action.status,
        reviewNotes: note || undefined,
      }).subscribe({ next: done(`Document ${action.status}`), error: fail });
      return;
    }
    if (action.kind === 'nutritionReview') {
      this.api.post(`/admin/nutrition/${action.record.recordKind}/${action.record.id}/review`, {
        status: action.status,
        notes: note || undefined,
      }).subscribe({ next: done(`Record ${action.status}`), error: fail });
      return;
    }
    if (action.kind === 'nutritionBulk') {
      this.bulkBusy.set(true);
      this.api.post(`/admin/nutrition/${action.record.recordKind}/bulk-review`, {
        status: action.status,
        allPending: true,
        species: action.record.species || undefined,
        notes: note || undefined,
      }).subscribe({
        next: (res: any) => {
          this.bulkBusy.set(false);
          this.action.set(null);
          this.toast.success(
            `${res.updated} record(s) ${action.status}` +
            (res.skippedAlreadyReviewed ? `, ${res.skippedAlreadyReviewed} already reviewed and left unchanged` : ''),
          );
          this.loadNutritionRecords();
          this.api.get<any>('/admin/nutrition/queue').subscribe({
            next: (q) => this.nutritionQueue.set(q.queue ?? []),
          });
        },
        error: (err) => {
          this.bulkBusy.set(false);
          fail(err);
        },
      });
      return;
    }
    this.api.patch(`/admin/reports/${action.record.id}`, {
      status: action.status,
      resolution: note || undefined,
    }).subscribe({ next: done('Report updated'), error: fail });
  }

  readonly action = signal<{
    kind: 'verify' | 'review' | 'report' | 'nutritionReview' | 'nutritionBulk';
    record: any;
    status: string;
    title: string;
    label: string;
    required: boolean;
  } | null>(null);
  actionNote = '';

  toggleDocSpecies(code: string): void {
    this.docSpecies.update((list) => (list.includes(code) ? list.filter((c) => c !== code) : [...list, code]));
  }

  addKnowledge(): void {
    if (this.knowledgeForm.invalid || !this.docSpecies().length) {
      this.knowledgeForm.markAllAsTouched();
      if (!this.docSpecies().length) this.toast.info('Select at least one species.');
      return;
    }
    const v = this.knowledgeForm.getRawValue();
    this.savingDoc.set(true);
    this.api.post('/admin/knowledge', {
      title: v.title,
      species: this.docSpecies(),
      category: v.category,
      sourceOrg: v.sourceOrg,
      sourceUrl: v.sourceUrl || null,
      publishedYear: v.publishedYear,
      content: v.content,
      isDemo: v.isDemo,
    }).subscribe({
      next: () => {
        this.savingDoc.set(false);
        this.toast.success('Document submitted for review');
        this.knowledgeForm.reset({ title: '', category: 'general', sourceOrg: '', sourceUrl: '', publishedYear: null, content: '', isDemo: true });
        this.knowledgeFilter.set('pending');
        this.loadAll();
      },
      error: (err) => {
        this.savingDoc.set(false);
        this.toast.error(err);
      },
    });
  }

  readonly savingDoc = signal(false);

  addBreed(): void {
    if (this.breedForm.invalid) {
      this.breedForm.markAllAsTouched();
      return;
    }
    const v = this.breedForm.getRawValue();
    this.api.post('/admin/breeds', {
      speciesCode: v.speciesCode,
      name: v.name,
      notes: v.notes || undefined,
      isUnknown: v.isUnknown,
    }).subscribe({
      next: () => {
        this.toast.success('Breed added');
        this.breedForm.patchValue({ name: '', notes: '', isUnknown: false });
        this.loadAll();
      },
      error: (err) => this.toast.error(err),
    });
  }

  toggleBreed(breed: any): void {
    this.api.patch(`/admin/breeds/${breed.id}`, { isActive: !breed.is_active }).subscribe({
      next: () => this.loadAll(),
      error: (err) => this.toast.error(err),
    });
  }

  toggleSpeciesActive(sp: any): void {
    this.api.patch(`/admin/species/${sp.code}`, { isActive: !sp.is_active }).subscribe({
      next: () => this.loadAll(),
      error: (err) => this.toast.error(err),
    });
  }

  saveCapability(cap: any): void {
    this.api.patch(`/admin/capabilities/${cap.id}`, {
      status: cap.status,
      evidenceSummary: cap.evidenceSummary,
    }).subscribe({
      next: () => {
        this.toast.success('Capability updated');
        this.loadAll();
      },
      error: (err) => this.toast.error(err),
    });
  }

  // ── Nutrition knowledge review ───────────────────────

  loadNutritionRecords(): void {
    this.api
      .get<any>(`/admin/nutrition/${this.nutritionKind()}`, {
        status: this.nutritionStatus(),
        species: this.nutritionSpecies() || undefined,
        limit: 50,
      })
      .subscribe({
        next: (res) => this.nutritionRecords.set(res.records ?? []),
        error: (err) => this.toast.error(err),
      });
  }

  pendingNutritionCount(): number {
    const kind = this.nutritionKind();
    const entry = this.nutritionQueue().find((q) => q.kind === kind);
    return entry?.pending ?? 0;
  }

  bulkReview(status: 'approved' | 'rejected'): void {
    const kind = this.nutritionKind();
    const count = this.pendingNutritionCount();
    const species = this.nutritionSpecies();
    if (!count) {
      this.toast.info('No pending records to review in this filter.');
      return;
    }
    this.actionNote = '';
    this.action.set({
      kind: 'nutritionBulk',
      record: { recordKind: kind, species },
      status,
      title: `${status === 'approved' ? 'Approve' : 'Reject'} all pending ${this.kindLabel(kind).toLowerCase()}`,
      label:
        `This applies to every pending record in the current filter` +
        (species ? ` (species: ${species})` : ' (all species)') +
        `. Records already reviewed are never changed. ${status === 'approved'
          ? 'Approved records become visible to pet owners and the AI immediately.'
          : 'Rejected records stay out of owner-facing guidance.'}`,
      required: status === 'rejected',
    });
  }

  selectNutritionKind(kind: string): void {
    this.nutritionKind.set(kind);
    this.editingNutrition.set(null);
    this.expandedNutritionVersion.set(null);
    this.loadNutritionRecords();
  }

  kindLabel(kind: string): string {
    return this.nutritionKinds.find((k) => k.value === kind)?.label ?? kind;
  }

  nutritionTitle(rec: any): string {
    const kind = this.nutritionKind();
    if (kind === 'hazard') return rec.food_or_substance ?? '—';
    if (kind === 'recipe') return rec.recipe_name ?? '—';
    if (kind === 'guidance') return rec.nutrition_goal || rec.record_key || 'Guidance';
    if (kind === 'breed') return rec.breed_or_type ?? '—';
    if (kind === 'health_rule') return rec.condition_or_goal ?? '—';
    return rec.source_name ?? rec.url ?? 'Source';
  }

  nutritionSummary(rec: any): string {
    const kind = this.nutritionKind();
    const parts: string[] = [];
    if (rec.species_code) parts.push(rec.species_code);
    if (rec.species_codes?.length) parts.push(rec.species_codes.join(', '));
    if (rec.life_stage && rec.life_stage !== 'all') parts.push(rec.life_stage);
    if (kind === 'hazard' && rec.classification) parts.push(rec.classification);
    if (kind === 'recipe' && rec.diet_role) parts.push(rec.diet_role);
    if (kind === 'source' && rec.url) parts.push(rec.url);
    if (rec.record_key) parts.push(rec.record_key);
    return parts.join(' · ') || '—';
  }

  nutritionBody(rec: any): string {
    const kind = this.nutritionKind();
    const key = (
      { guidance: 'general_diet_guidance', hazard: 'risk', recipe: 'safety_notes',
        breed: 'general_guidance', health_rule: 'general_guidance', source: 'usage_notes' } as Record<string, string>
    )[kind];
    let text = key ? String(rec[key] ?? '') : '';
    if (kind === 'hazard' && rec.recommended_action) text += ` — Action: ${rec.recommended_action}`;
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }

  editNutrition(rec: any): void {
    const kind = this.nutritionKind();
    const edit: Record<string, any> = {};
    for (const field of this.nutritionEditable[kind] ?? []) {
      const column = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      edit[field] = rec[column] ?? (field === 'storageKnown' ? false : '');
    }
    this.nutritionEdit = edit;
    this.editingNutrition.set(rec);
  }

  saveNutritionEdit(): void {
    const rec = this.editingNutrition();
    if (!rec) return;
    const payload: Record<string, unknown> = {};
    for (const field of this.nutritionEditable[this.nutritionKind()] ?? []) {
      let value = this.nutritionEdit[field];
      if (field === 'storageKnown') value = !!value;
      if (field === 'storageInstructions' && !String(value ?? '').trim()) value = null;
      payload[field] = value;
    }
    this.api.patch(`/admin/nutrition/${this.nutritionKind()}/${rec.id}`, payload).subscribe({
      next: () => {
        this.toast.success('Record saved — editing an approved record returns it to the review queue');
        this.editingNutrition.set(null);
        this.loadNutritionRecords();
        this.api.get<any>('/admin/nutrition/queue').subscribe({
          next: (res) => this.nutritionQueue.set(res.queue ?? []),
        });
      },
      error: (err) => this.toast.error(err),
    });
  }

  reviewNutrition(rec: any, status: 'approved' | 'rejected' | 'pending'): void {
    this.actionNote = '';
    this.action.set({
      kind: 'nutritionReview',
      record: { ...rec, recordKind: this.nutritionKind() },
      status,
      title:
        status === 'approved' ? `Approve “${this.nutritionTitle(rec)}”`
        : status === 'rejected' ? `Reject “${this.nutritionTitle(rec)}”`
        : `Reopen “${this.nutritionTitle(rec)}”`,
      label:
        status === 'rejected'
          ? 'Reason for rejection — kept in the record version history.'
          : status === 'approved'
            ? 'Review note (optional). Approved records become visible to pet owners immediately.'
            : 'Note for reopening (optional).',
      required: status === 'rejected',
    });
  }

  toggleNutritionVersions(rec: any): void {
    if (this.expandedNutritionVersion() === rec.id) {
      this.expandedNutritionVersion.set(null);
      return;
    }
    this.api.get<any>(`/admin/nutrition/${this.nutritionKind()}/${rec.id}/versions`).subscribe({
      next: (res) => {
        this.nutritionVersions.update((v) => ({ ...v, [rec.id]: res.versions ?? [] }));
        this.expandedNutritionVersion.set(rec.id);
      },
      error: (err) => this.toast.error(err),
    });
  }

  fieldLabel(field: string): string {
    return field.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }

  loadUsers(): void {
    this.api.get<any>('/admin/users', { q: this.userQuery.trim() }).subscribe({
      next: (res) => this.users.set(res.users ?? []),
      error: (err) => this.toast.error(err),
    });
  }

  toggleUser(user: any): void {
    this.api.patch(`/admin/users/${user.id}`, { disabled: !user.disabled }).subscribe({
      next: () => {
        this.toast.success(user.disabled ? 'Account enabled' : 'Account disabled');
        this.loadUsers();
      },
      error: (err) => this.toast.error(err),
    });
  }

  saveAiSettings(): void {
    this.api.patch('/admin/settings/ai', {
      enabled: this.aiEnabled(),
      llmEnabled: this.llmEnabled(),
      disclaimer: this.disclaimer,
    }).subscribe({
      next: () => {
        this.toast.success('AI settings saved');
        this.loadAll();
      },
      error: (err) => this.toast.error(err),
    });
  }

  resolveReport(report: any, status: 'resolved' | 'dismissed'): void {
    this.actionNote = '';
    this.action.set({
      kind: 'report',
      record: report,
      status,
      title: status === 'resolved' ? 'Resolve report' : 'Dismiss report',
      label: 'Resolution note (optional, kept in the audit trail).',
      required: false,
    });
  }
}
