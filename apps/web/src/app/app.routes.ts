import { Routes } from '@angular/router';
import { authGuard, roleGuard } from './core/guards';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./pages/login.component').then((m) => m.LoginComponent),
    title: 'Sign in — Pet Vet AI',
  },
  {
    path: 'register',
    loadComponent: () => import('./pages/register.component').then((m) => m.RegisterComponent),
    title: 'Create an account — Pet Vet AI',
  },
  {
    path: 'onboarding',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/onboarding.component').then((m) => m.OnboardingComponent),
    title: 'Add your pet — Pet Vet AI',
  },
  {
    path: 'dashboard',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/dashboard.component').then((m) => m.DashboardComponent),
    title: 'Dashboard — Pet Vet AI',
  },
  {
    path: 'pets/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/pet-detail.component').then((m) => m.PetDetailComponent),
    title: 'Pet profile — Pet Vet AI',
  },
  {
    path: 'ai',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/ai-chat.component').then((m) => m.AiChatComponent),
    title: 'Pet Vet AI — general information',
  },
  {
    path: 'food',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/food-safety.component').then((m) => m.FoodSafetyComponent),
    title: 'Food safety — Pet Vet AI',
  },
  {
    path: 'nutrition',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/nutrition.component').then((m) => m.NutritionComponent),
    title: 'Nutrition — Pet Vet AI',
  },
  {
    path: 'find-care',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/find-care.component').then((m) => m.FindCareComponent),
    title: 'Find veterinary care — Pet Vet AI',
  },
  {
    path: 'appointments',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/appointments.component').then((m) => m.AppointmentsComponent),
    title: 'Appointments — Pet Vet AI',
  },
  {
    path: 'messages',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/messages.component').then((m) => m.MessagesComponent),
    title: 'Messages — Pet Vet AI',
  },
  {
    path: 'video/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/video-room.component').then((m) => m.VideoRoomComponent),
    title: 'Video consultation — Pet Vet AI',
  },
  {
    path: 'vet',
    canActivate: [authGuard, roleGuard(['vet'])],
    loadComponent: () => import('./pages/vet-portal.component').then((m) => m.VetPortalComponent),
    title: 'Practice — Pet Vet AI',
  },
  {
    path: 'vet/apply',
    canActivate: [authGuard, roleGuard(['vet'])],
    loadComponent: () =>
      import('./pages/vet-application.component').then((m) => m.VetApplicationComponent),
    title: 'Verification application — Pet Vet AI',
  },
  {
    path: 'admin',
    canActivate: [authGuard, roleGuard(['admin'])],
    loadComponent: () => import('./pages/admin.component').then((m) => m.AdminComponent),
    title: 'Administration — Pet Vet AI',
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/settings.component').then((m) => m.SettingsComponent),
    title: 'Settings — Pet Vet AI',
  },
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: '**', redirectTo: 'dashboard' },
];
