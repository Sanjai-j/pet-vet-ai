import { Component, ElementRef, OnDestroy, OnInit, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { WsService } from '../core/ws.service';
import { Appointment } from '../core/models';

@Component({
  selector: 'app-video-room',
  standalone: true,
  imports: [RouterLink, MatButtonModule],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">Video consultation</span>
          <h1>{{ appointment()?.petName || 'Consultation' }}</h1>
          <p>
            @if (appointment()) {
              {{ auth.isVet() ? 'Owner: ' + appointment()!.ownerName : 'Veterinarian: ' + appointment()!.vetName }}
              · {{ formatDateTime(appointment()!.scheduledFor) }}
            }
          </p>
        </div>
        <a mat-stroked-button routerLink="/appointments">Back to appointments</a>
      </div>

      @if (loading()) {
        <div class="loading-block"><span class="spinner"></span> Preparing the consultation room…</div>
      } @else if (appointment(); as appt) {
        @if (appt.status !== 'accepted') {
          <div class="card empty">
            <span class="empty-icon">🔒</span>
            <h3>The consultation room is closed</h3>
            <p class="muted">The appointment must be accepted before either participant can join. Current status: <strong>{{ appt.status }}</strong>.</p>
            <a mat-flat-button color="primary" routerLink="/appointments">View appointment</a>
          </div>
        } @else {
          @if (error()) {
            <div class="banner banner-danger" style="margin-bottom:1rem">
              <span class="banner-icon">⚠️</span>
              <div><strong>Call issue</strong><p>{{ error() }}</p></div>
            </div>
          }

          @if (!turnConfigured()) {
            <div class="banner banner-warn" style="margin-bottom:1rem">
              <span class="banner-icon">🌐</span>
              <div>
                <strong>STUN only</strong>
                <p>Only a public STUN server is configured. Calls work on many home networks but can fail on restrictive or carrier-grade NAT. Configure TURN for reliable connections.</p>
              </div>
            </div>
          }

          <div class="video-stage">
            <video #localVideo autoplay playsinline muted aria-label="Your camera"></video>
            <video #remoteVideo autoplay playsinline aria-label="Other participant"></video>
            @if (!localStreamReady()) {
              <div class="video-overlay">
                <span style="font-size:2.5rem">🎥</span>
                <h2 style="color:#fff;margin:0">Ready when you are</h2>
                <p style="max-width:42ch;margin:.3rem 0 0">Join the call to request camera and microphone access. Media travels directly between participants (peer-to-peer); this app does not record the call.</p>
                <button class="btn btn-primary" type="button" (click)="join()">Join consultation</button>
              </div>
            } @else if (!remoteStreamReady()) {
              <div class="video-overlay">
                <span class="spinner" style="border-top-color:#E08A2E;width:28px;height:28px"></span>
                <h2 style="color:#fff;margin:0">Waiting for the other participant</h2>
                <p style="margin:.3rem 0 0">{{ connectionStateLabel() }}</p>
              </div>
            }
          </div>

          <div class="video-controls">
            <button class="btn btn-secondary" type="button" [disabled]="!localStreamReady()" (click)="toggleMic()">
              {{ micOn() ? '🎙 Mute' : '🔇 Unmute' }}
            </button>
            <button class="btn btn-secondary" type="button" [disabled]="!localStreamReady()" (click)="toggleCamera()">
              {{ cameraOn() ? '📷 Camera off' : '📷 Camera on' }}
            </button>
            <button class="btn btn-danger" type="button" [disabled]="!localStreamReady()" (click)="leave()">Leave call</button>
            <span class="badge badge-neutral">{{ connectionStateLabel() }}</span>
          </div>

          <div class="split mt-3">
            <div class="card">
              <h3>Reason for consultation</h3>
              <p class="small">{{ appt.reason }}</p>
              @if (appt.responseNote) { <p class="small muted">Vet response: {{ appt.responseNote }}</p> }
              <div class="banner banner-info mt-1">
                <span class="banner-icon">🔐</span>
                <div>
                  <strong>Peer-to-peer media</strong>
                  <p>Signalling is authenticated over the app's WebSocket. Video and audio are not recorded or stored by Pet Vet AI. Use a private space and the attending owner's consent.</p>
                </div>
              </div>
            </div>
            <div class="card">
              <h3>Connection details</h3>
              <div class="cap-row"><span>Signalling</span><span class="badge" [class.badge-ok]="ws.connected()" [class.badge-warn]="!ws.connected()">{{ ws.connected() ? 'Connected' : 'Disconnected' }}</span></div>
              <div class="cap-row"><span>Relay</span><span class="badge" [class.badge-ok]="turnConfigured()" [class.badge-warn]="!turnConfigured()">{{ turnConfigured() ? 'TURN configured' : 'STUN only' }}</span></div>
              <div class="cap-row"><span>Peer state</span><span class="badge badge-neutral">{{ connectionStateLabel() }}</span></div>
              @if (!ws.connected()) {
                <p class="tiny muted mt-1">Reconnecting automatically. If this persists, check that the API service is running.</p>
              }
            </div>
          </div>
        }
      }
    </div>
  `,
})
export class VideoRoomComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly ws = inject(WsService);
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private toast = inject(ToastService);

  private localVideo = viewChild<ElementRef<HTMLVideoElement>>('localVideo');
  private remoteVideo = viewChild<ElementRef<HTMLVideoElement>>('remoteVideo');

  readonly appointment = signal<Appointment | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly localStreamReady = signal(false);
  readonly remoteStreamReady = signal(false);
  readonly micOn = signal(true);
  readonly cameraOn = signal(true);
  readonly connectionState = signal<RTCPeerConnectionState>('new');
  readonly turnConfigured = signal(false);
  readonly otherPresent = signal(false);

  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private appointmentId = '';
  private sentOffer = false;
  private joinedAck = false;
  private remoteDescriptionSet = false;

  ngOnInit(): void {
    this.appointmentId = this.route.snapshot.paramMap.get('id') ?? '';
    if (!this.appointmentId) return;
    this.api.get<{ appointment: Appointment }>(`/appointments/${this.appointmentId}`).subscribe({
      next: (res) => {
        this.appointment.set(res.appointment);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err instanceof Error ? err.message : 'Could not load the appointment.');
      },
    });
    this.api.get<any>('/config/webrtc').subscribe({
      next: (res) => {
        this.iceServers = res.iceServers ?? this.iceServers;
        this.turnConfigured.set(Boolean(res.turnConfigured));
      },
      error: () => undefined,
    });
    this.ws.webrtc$.subscribe((event) => this.onSignal(event));
  }

  connectionStateLabel(): string {
    if (!this.localStreamReady()) return 'Not joined';
    if (!this.ws.connected()) return 'Signalling offline';
    if (this.connectionState() === 'connected') return 'Connected';
    if (this.connectionState() === 'failed') return 'Connection failed — TURN may be required';
    if (this.connectionState() === 'disconnected') return 'Peer disconnected';
    if (this.remoteStreamReady()) return 'Media connected';
    return this.otherPresent() ? 'Negotiating media…' : 'Waiting for the other participant';
  }

  async join(): Promise<void> {
    if (!this.ws.connected()) {
      this.error.set('The live signalling connection is offline. Wait a moment for it to reconnect, then try again.');
      return;
    }
    this.error.set('');
    try {
      this.localStream = await this.requestMedia();
      const local = this.localVideo()?.nativeElement;
      if (local) {
        local.srcObject = this.localStream;
        await local.play().catch(() => undefined);
      }
      this.localStreamReady.set(true);
      this.sendSignal({ kind: 'join' });
    } catch (err) {
      const name = (err as DOMException)?.name;
      this.error.set(
        name === 'NotAllowedError'
          ? 'Camera or microphone permission was denied. Allow access in the browser and try again.'
          : name === 'NotFoundError'
            ? 'No camera or microphone was found on this device.'
            : name === 'TimeoutError'
              ? 'Camera access did not complete. Look for the browser permission prompt for this site, allow camera and microphone, then try again.'
              : 'Could not start local media. Check your camera and microphone.',
      );
    }
  }

  /** Camera permission prompts can stall silently on some browsers; surface that instead of hanging. */
  private requestMedia(): Promise<MediaStream> {
    return new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DOMException('Permission prompt timed out', 'TimeoutError'));
      }, 20_000);
      navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(
        (stream) => {
          clearTimeout(timer);
          resolve(stream);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private createPeer(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.localStream?.getTracks().forEach((track) => pc.addTrack(track, this.localStream!));
    pc.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal({ kind: 'candidate', candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      const remote = this.remoteVideo()?.nativeElement;
      if (remote && event.streams[0]) {
        remote.srcObject = event.streams[0];
        remote.play().catch(() => undefined);
        this.remoteStreamReady.set(true);
      }
    };
    pc.onconnectionstatechange = () => {
      this.connectionState.set(pc.connectionState);
      if (pc.connectionState === 'failed') {
        this.error.set('The peer connection failed. A TURN relay is usually required on restrictive networks.');
      }
    };
    return pc;
  }

  private async createOffer(): Promise<void> {
    if (!this.localStream) return;
    const pc = this.createPeer();
    if (this.sentOffer) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sentOffer = true;
    this.sendSignal({ kind: 'offer', sdp: pc.localDescription?.sdp });
  }

  private async onSignal(event: any): Promise<void> {
    if (event.appointmentId !== this.appointmentId) return;
    const signal = event.signal ?? {};
    if (event.fromUserId === this.auth.user()?.id) return;

    if (signal.kind === 'join') {
      this.otherPresent.set(true);
      if (!this.localStreamReady()) return;
      if (!this.joinedAck) {
        this.joinedAck = true;
        this.sendSignal({ kind: 'join' });
      }
      if (this.shouldInitiate(event.fromUserId)) await this.createOffer();
      return;
    }

    if (signal.kind === 'offer') {
      this.otherPresent.set(true);
      if (!this.localStream) {
        try {
          this.localStream = await this.requestMedia();
          const local = this.localVideo()?.nativeElement;
          if (local) local.srcObject = this.localStream;
          this.localStreamReady.set(true);
        } catch {
          this.error.set('Could not access your camera or microphone to answer the call.');
          return;
        }
      }
      const pc = this.createPeer();
      if (this.sentOffer && this.shouldInitiate(event.fromUserId)) return;
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        this.remoteDescriptionSet = true;
        await this.flushCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal({ kind: 'answer', sdp: answer.sdp });
      } catch (err) {
        this.error.set('Could not negotiate the call. Try leaving and rejoining.');
      }
      return;
    }

    if (signal.kind === 'answer') {
      if (!this.pc) return;
      try {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        this.remoteDescriptionSet = true;
        await this.flushCandidates();
      } catch {
        this.error.set('Could not complete call negotiation.');
      }
      return;
    }

    if (signal.kind === 'candidate') {
      if (!this.pc || !this.remoteDescriptionSet) {
        this.pendingCandidates.push(signal.candidate);
        return;
      }
      try {
        await this.pc.addIceCandidate(signal.candidate);
      } catch {
        // A late candidate can be safely ignored after the connection settles.
      }
      return;
    }

    if (signal.kind === 'leave') {
      this.remoteStreamReady.set(false);
      this.connectionState.set('disconnected');
      this.toast.info('The other participant left the call.');
    }
  }

  private shouldInitiate(otherUserId: string): boolean {
    return (this.auth.user()?.id ?? '') < otherUserId;
  }

  private async flushCandidates(): Promise<void> {
    if (!this.pc) return;
    for (const candidate of this.pendingCandidates.splice(0)) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        // ignore stale candidates
      }
    }
  }

  private sendSignal(signal: Record<string, unknown>): void {
    this.ws.send({ type: 'webrtc', appointmentId: this.appointmentId, signal });
  }

  toggleMic(): void {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.micOn.set(track.enabled);
  }

  toggleCamera(): void {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.cameraOn.set(track.enabled);
  }

  leave(): void {
    this.sendSignal({ kind: 'leave' });
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.pc?.close();
    this.pc = null;
    this.localStreamReady.set(false);
    this.remoteStreamReady.set(false);
    this.sentOffer = false;
    this.joinedAck = false;
    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.connectionState.set('new');
  }

  ngOnDestroy(): void {
    this.leave();
  }

  formatDateTime(value: string): string {
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
    }).format(new Date(value)) + ' IST';
  }
}
