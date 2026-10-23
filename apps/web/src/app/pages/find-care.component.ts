import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { DirectoryVet, MapsConfig, NearbyClinic, Pet, VetSlot } from '../core/models';

const SPECIES = [
  { code: 'dog', label: 'Dog' },
  { code: 'cat', label: 'Cat' },
  { code: 'bird', label: 'Bird' },
  { code: 'cow', label: 'Cattle' },
  { code: 'goat', label: 'Goat' },
  { code: 'other', label: 'Other' },
];

/**
 * Nearby hospital discovery + the verified veterinarian directory.
 *
 * Two very different things are shown side by side on purpose:
 *  - hospital listings come from OpenStreetMap (free, keyless) or Google Places
 *    when a key is configured. A listing is never a Pet Vet AI verification;
 *  - veterinarians are only listed after a Pet Vet AI administrator approved
 *    their credentials, and only those vets can be booked.
 */
@Component({
  selector: 'app-find-care',
  standalone: true,
  imports: [
    FormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule,
  ],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">Find care</span>
          <h1>Vet hospitals near you</h1>
          <p>
            Share your location to see the closest veterinary clinics and animal hospitals, in distance order.
            You can also book with a veterinarian whose credentials Pet Vet AI has reviewed.
          </p>
        </div>
        <a mat-stroked-button routerLink="/appointments">My appointments</a>
      </div>

      <div class="card">
        <div class="form-grid">
          <mat-form-field appearance="outline">
            <mat-label>City or area</mat-label>
            <input matInput [(ngModel)]="city" (keydown.enter)="search()" placeholder="Bengaluru" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>What are you looking for?</mat-label>
            <input matInput [(ngModel)]="query" (keydown.enter)="search()" placeholder="24 hour hospital, dermatology…" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Species</mat-label>
            <mat-select [(ngModel)]="species" (ngModelChange)="search()">
              <mat-option value="">Any species</mat-option>
              @for (s of speciesOptions; track s.code) {
                <mat-option [value]="s.code">{{ s.label }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Radius</mat-label>
            <mat-select [(ngModel)]="radiusKm" (ngModelChange)="search()">
              @for (r of radii; track r) {
                <mat-option [value]="r">{{ r }} km</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>
        <div class="row">
          <button class="btn btn-primary" type="button" (click)="search()" [disabled]="loading()">
            {{ loading() ? 'Searching…' : 'Search' }}
          </button>
          <button class="btn btn-secondary" type="button" (click)="useLocation()" [disabled]="locating()">
            {{ locating() ? 'Locating…' : '📍 Use my location' }}
          </button>
          <label class="row-tight small">
            <input type="checkbox" [(ngModel)]="onlyAvailable" (change)="search()" />
            Only vets with open slots in the next 14 days
          </label>
          @if (geoUsed()) { <span class="badge badge-teal">Sorted by distance</span> }
          <span class="spacer"></span>
          @if (nearest() != null) { <span class="tiny muted">Nearest listed: {{ nearest() }} km</span> }
        </div>
      </div>

      @if (notice()) {
        <div class="banner banner-info" style="margin-top:1rem">
          <span class="banner-icon">🗺️</span>
          <div>
            <strong>{{ providerLabel() }}</strong>
            <p>{{ notice() }}</p>
            @if (attribution(); as credit) {
              <p class="tiny">
                <a [href]="credit.url" target="_blank" rel="noopener">{{ credit.text }}</a>
              </p>
            }
          </div>
        </div>
      }

      <div class="split mt-2">
        <div class="stack">
          <div class="section-title" style="margin-top:0">
            <h2>Nearby hospitals & clinics</h2><span class="badge badge-neutral">{{ clinics().length }}</span>
          </div>
          @if (loading()) {
            <div class="card"><div class="loading-block"><span class="spinner"></span> Searching…</div></div>
          }
          @for (clinic of clinics(); track clinic.id) {
            <div class="card provider-card">
              <div class="provider-top">
                <div>
                  <div class="provider-title">{{ clinic.name }}</div>
                  <div class="provider-meta">{{ clinic.address }}</div>
                </div>
                <div class="row-tight">
                  @if (clinic.dataSource === 'independently_verified') {
                    <span class="badge badge-ok">Pet Vet AI verified</span>
                  } @else if (clinic.dataSource === 'google_places') {
                    <span class="badge badge-neutral" title="A Google listing is not a Pet Vet AI verification">Google listing</span>
                  } @else {
                    <span class="badge badge-neutral" title="Community-mapped from OpenStreetMap; not verified by Pet Vet AI">OpenStreetMap</span>
                  }
                  @if (clinic.emergencyAvailable) {
                    <span class="badge badge-warn" title="This listing says it is open 24×7 or accepts emergencies">24×7 / emergency</span>
                  }
                  @if (clinic.rating != null) {
                    <span class="badge badge-neutral">★ {{ clinic.rating }}@if (clinic.reviewCount) { ({{ clinic.reviewCount }}) }</span>
                  }
                </div>
              </div>
              @if (clinic.openingHours) { <div class="provider-meta">{{ clinic.openingHours }}</div> }
              @if (clinic.phone) { <div class="provider-meta">☎ {{ clinic.phone }}</div> }
              <div class="row" style="justify-content:space-between">
                <span class="tiny muted">
                  @if (clinic.distanceKm != null) { {{ clinic.distanceKm }} km away · }
                  {{ clinic.bookableVetIds.length }} bookable vet(s)
                </span>
                <a class="btn btn-secondary btn-sm" [href]="clinic.directionsUrl" target="_blank" rel="noopener">Open in Maps ↗</a>
              </div>
              <span class="map-note">{{ clinic.speciesNote }}</span>
            </div>
          }
          @if (!loading() && !clinics().length) {
            <div class="card empty">
              <span class="empty-icon">🏥</span>
              @if (searchEnabled()) {
                No veterinary hospital is mapped here yet. Try a wider radius, the nearest large city, or clear the
                search term — and call the clinic before travelling.
              } @else {
                Nearby hospital search is switched off on this server. An administrator can enable the free
                OpenStreetMap lookup or configure a Google Maps key.
              }
            </div>
          }
        </div>

        <div class="stack">
          <div class="section-title" style="margin-top:0">
            <h2>Verified veterinarians</h2><span class="badge badge-neutral">{{ vets().length }}</span>
          </div>
          <p class="tiny muted" style="margin:0 0 .5rem">
            Only veterinarians whose registration details an administrator reviewed appear here. A Google Maps
            listing is never enough to be listed.
          </p>
          @for (vet of vets(); track vet.id) {
            <div class="card">
              <div class="provider-top">
                <div>
                  <div class="provider-title">{{ vet.fullName }}</div>
                  <div class="provider-meta">
                    {{ vet.clinicName || 'Independent practice' }} · {{ vet.city || 'Location not set' }}
                    @if (vet.distanceKm != null) { · {{ vet.distanceKm }} km away }
                  </div>
                </div>
                <span class="badge badge-ok" title="Reviewed by a Pet Vet AI administrator">✓ Verified</span>
              </div>
              @if (vet.bio) { <p class="small muted">{{ vet.bio }}</p> }
              <div class="chip-row">
                @for (sp of vet.specialties; track sp) { <span class="chip">{{ sp }}</span> }
                @for (l of vet.languages; track l) { <span class="chip">{{ l }}</span> }
                @for (t of vet.consultationTypes; track t) { <span class="chip">{{ modeLabel(t) }}</span> }
              </div>
              <div class="provider-meta">
                {{ vet.experienceYears ?? '—' }} years
                @if (vet.qualification) { · {{ vet.qualification }} }
                · {{ vet.consultationFeeInr ? '₹' + vet.consultationFeeInr : 'Fee not listed' }}
              </div>
              <div class="row">
                <button class="btn btn-primary btn-sm" type="button" (click)="openBooking(vet)">
                  {{ selectedVetId() === vet.id ? 'Choose a time below' : 'Book appointment' }}
                </button>
                <button class="btn btn-secondary btn-sm" type="button" (click)="messageVet(vet)">Message</button>
              </div>
            </div>
          }
          @if (!vets().length) {
            <div class="card empty">
              <span class="empty-icon">🩺</span>
              No verified veterinarian matches this filter yet. Try another city or clear the species filter.
            </div>
          }
        </div>
      </div>

      @if (selectedVet(); as vet) {
        <div class="card raised mt-3" id="booking">
          <div class="card-head">
            <div>
              <h3>Book with {{ vet.fullName }}</h3>
              <p>{{ vet.clinicName || 'Independent practice' }} · {{ vet.city || 'Online' }}</p>
            </div>
            <button class="btn btn-ghost btn-sm" type="button" (click)="closeBooking()">Close</button>
          </div>

          @if (!pets().length) {
            <div class="banner banner-info">
              <span class="banner-icon">🐾</span>
              <div><strong>Add a pet first</strong><p>Appointments are always linked to a pet profile.</p><a routerLink="/onboarding">Add a pet →</a></div>
            </div>
          } @else {
            @if (loadingSlots()) {
              <div class="loading-block"><span class="spinner"></span> Loading open times…</div>
            } @else if (!slots().length) {
              <div class="banner banner-warn">
                <span class="banner-icon">🗓️</span>
                <div>
                  <strong>No open slots published</strong>
                  <p>This veterinarian has not published availability for the next three weeks. Send a message to ask about their schedule.</p>
                </div>
              </div>
            } @else {
              <div class="slot-days">
                @for (day of slotDays(); track day.date) {
                  <div>
                    <div class="stat-label">{{ day.label }}</div>
                    <div class="availability">
                      @for (slot of day.slots; track slot.id) {
                        <button
                          type="button"
                          class="slot"
                          [class.slot-active]="selectedSlotId() === slot.id"
                          (click)="selectedSlotId.set(slot.id)"
                          [attr.aria-pressed]="selectedSlotId() === slot.id"
                        >{{ slot.startTime }} · {{ modeLabel(slot.consultationType) }}</button>
                      }
                    </div>
                  </div>
                }
              </div>

              <div class="form-grid mt-2">
                <mat-form-field appearance="outline">
                  <mat-label>Pet</mat-label>
                  <mat-select [(ngModel)]="petId">
                    @for (pet of pets(); track pet.id) {
                      <mat-option [value]="pet.id">{{ pet.speciesIcon }} {{ pet.name }} ({{ pet.speciesName }})</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
                <mat-form-field appearance="outline" class="full">
                  <mat-label>Reason for the visit</mat-label>
                  <textarea matInput rows="2" [(ngModel)]="reason" placeholder="What is happening, and for how long?"></textarea>
                </mat-form-field>
              </div>
              <div class="row" style="justify-content:flex-end">
                <span class="tiny muted">Requests start as pending until the veterinarian accepts. The slot is held for you.</span>
                <button
                  class="btn btn-primary"
                  type="button"
                  (click)="book()"
                  [disabled]="booking() || !selectedSlotId() || reason.trim().length < 5 || !petId"
                >{{ booking() ? 'Requesting…' : 'Request appointment' }}</button>
              </div>
            }
          }
        </div>
      }
    </div>
  `,
})
export class FindCareComponent implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private router = inject(Router);

  readonly speciesOptions = SPECIES;
  readonly radii = [5, 10, 25, 50];

  city = '';
  query = '';
  species = '';
  radiusKm = 10;
  onlyAvailable = false;

  readonly clinics = signal<NearbyClinic[]>([]);
  readonly vets = signal<DirectoryVet[]>([]);
  readonly pets = signal<Pet[]>([]);
  readonly notice = signal('');
  readonly provider = signal<'google_places' | 'openstreetmap' | 'disabled'>('openstreetmap');
  readonly attribution = signal<{ text: string; url: string } | null>(null);
  readonly searchEnabled = computed(() => this.provider() !== 'disabled');
  readonly providerLabel = computed(() => {
    if (this.provider() === 'google_places') return 'Google Maps results';
    if (this.provider() === 'openstreetmap') return 'OpenStreetMap results';
    return 'Hospital search unavailable';
  });
  readonly loading = signal(true);
  readonly locating = signal(false);
  readonly geoUsed = signal(false);
  readonly nearest = signal<number | null>(null);

  readonly selectedVet = signal<DirectoryVet | null>(null);
  readonly selectedVetId = computed(() => this.selectedVet()?.id ?? null);
  readonly slots = signal<VetSlot[]>([]);
  readonly loadingSlots = signal(false);
  readonly selectedSlotId = signal<string | null>(null);
  readonly booking = signal(false);
  readonly slotDays = computed(() => {
    const groups = new Map<string, VetSlot[]>();
    for (const slot of this.slots()) {
      const key = slot.slotDate.slice(0, 10);
      groups.set(key, [...(groups.get(key) ?? []), slot]);
    }
    return [...groups.entries()].map(([date, slots]) => ({
      date,
      label: new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short',
      }),
      slots,
    }));
  });

  petId = '';
  reason = '';
  private coords: { lat: number; lng: number } | null = null;

  ngOnInit(): void {
    this.city = this.auth.user()?.city ?? '';
    this.api.get<{ pets: Pet[] }>('/pets').subscribe({
      next: (res) => {
        this.pets.set(res.pets);
        this.petId = res.pets[0]?.id ?? '';
      },
    });
    this.api.get<MapsConfig>('/maps/config').subscribe({
      next: (cfg) => this.provider.set(cfg.nearbyProvider ?? 'openstreetmap'),
      error: () => undefined,
    });
    this.search();
  }

  modeLabel(type: string): string {
    return type === 'video' ? 'Video' : type === 'chat' ? 'Chat' : 'In person';
  }

  search(): void {
    this.loading.set(true);
    this.api
      .get<{
        clinics: NearbyClinic[];
        source: 'google_places' | 'openstreetmap' | 'none';
        notice: string;
        attribution: { text: string; url: string } | null;
        origin: unknown;
      }>('/maps/clinics', {
        city: this.city.trim() || undefined,
        q: this.query.trim() || undefined,
        lat: this.coords?.lat,
        lng: this.coords?.lng,
        radiusKm: this.radiusKm,
        limit: 20,
      })
      .subscribe({
        next: (res) => {
          this.clinics.set(res.clinics ?? []);
          this.notice.set(res.notice ?? '');
          this.attribution.set(res.attribution ?? null);
          if (res.source !== 'none') this.provider.set(res.source);
          this.loading.set(false);
          this.loadVets();
        },
        error: (err) => {
          this.loading.set(false);
          this.clinics.set([]);
          this.attribution.set(null);
          this.notice.set(ApiService.message(err));
          this.toast.error(err);
          this.loadVets();
        },
      });
  }

  private loadVets(): void {
    this.api
      .get<{ veterinarians: DirectoryVet[] }>('/directory/vets', {
        city: this.coords ? undefined : this.city.trim() || undefined,
        species: this.species || undefined,
        clinic: !this.coords && this.query.trim() ? this.query.trim() : undefined,
        lat: this.coords?.lat,
        lng: this.coords?.lng,
        availableWithinDays: this.onlyAvailable ? 14 : undefined,
      })
      .subscribe({
        next: (res) => {
          const rows = res.veterinarians ?? [];
          // Distance sorting is done server-side when coordinates are present.
          this.vets.set(rows);
          const distances = [
            ...this.clinics().map((c) => c.distanceKm),
            ...rows.map((v) => v.distanceKm),
          ].filter((d): d is number => typeof d === 'number');
          this.nearest.set(distances.length ? Math.min(...distances) : null);
        },
        error: (err) => this.toast.error(err),
      });
  }

  useLocation(): void {
    if (!navigator.geolocation) {
      this.toast.info('This browser does not support location. Enter a city instead.');
      return;
    }
    this.locating.set(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        this.geoUsed.set(true);
        this.locating.set(false);
        this.search();
      },
      () => {
        this.locating.set(false);
        this.toast.info('Location permission was not granted. Enter a city instead.');
      },
      { timeout: 8000 },
    );
  }

  openBooking(vet: DirectoryVet): void {
    this.selectedVet.set(vet);
    this.selectedSlotId.set(null);
    this.loadingSlots.set(true);
    this.api.get<{ slots: VetSlot[] }>('/slots', { vetId: vet.id }).subscribe({
      next: (res) => {
        this.slots.set(res.slots ?? []);
        this.loadingSlots.set(false);
      },
      error: (err) => {
        this.slots.set([]);
        this.loadingSlots.set(false);
        this.toast.error(err);
      },
    });
    setTimeout(() => document.getElementById('booking')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  closeBooking(): void {
    this.selectedVet.set(null);
    this.selectedSlotId.set(null);
    this.slots.set([]);
  }

  book(): void {
    const vet = this.selectedVet();
    const slotId = this.selectedSlotId();
    if (!vet || !slotId || !this.petId) return;
    if (this.reason.trim().length < 5) {
      this.toast.info('Tell the veterinarian what this appointment is about.');
      return;
    }
    const slot = this.slots().find((s) => s.id === slotId);
    this.booking.set(true);
    this.api
      .post('/appointments', {
        petId: this.petId,
        vetId: vet.id,
        slotId,
        mode: slot?.consultationType === 'in_person' ? 'in_person' : 'video',
        reason: this.reason.trim(),
      })
      .subscribe({
        next: () => {
          this.booking.set(false);
          this.toast.success('Appointment requested. You will be notified when the veterinarian responds.');
          this.router.navigate(['/appointments']);
        },
        error: (err) => {
          this.booking.set(false);
          this.toast.error(err);
          // Someone else may have taken the slot — refresh the open times.
          this.api.get<{ slots: VetSlot[] }>('/slots', { vetId: vet.id }).subscribe({
            next: (res) => {
              this.slots.set(res.slots ?? []);
              this.selectedSlotId.set(null);
            },
          });
        },
      });
  }

  messageVet(vet: DirectoryVet): void {
    if (!this.petId) {
      this.toast.info('Add a pet before starting a conversation.');
      return;
    }
    this.api.post<{ thread: any }>('/threads', { vetId: vet.id, petId: this.petId }).subscribe({
      next: (res) => this.router.navigate(['/messages'], { queryParams: { thread: res.thread.id } }),
      error: (err) => this.toast.error(err),
    });
  }
}
