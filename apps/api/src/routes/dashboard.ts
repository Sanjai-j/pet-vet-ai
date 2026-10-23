import { Router } from 'express';
import { asyncHandler } from '../errors.js';
import { many, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { PET_COLUMNS } from '../access.js';
import { careForPet } from '../services/care.js';
import { addDays, todayInTz } from '../util.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const date = todayInTz();
    const db = await one<{ now: string }>('SELECT now() AS now');

    let petWhere = 'p.owner_id = $1';
    const petParams: unknown[] = [user.id];
    if (user.role === 'vet') {
      petWhere = `EXISTS (SELECT 1 FROM appointments a WHERE a.pet_id = p.id AND a.vet_id = $1 AND a.status IN ('accepted','completed'))`;
    }
    if (user.role === 'admin') {
      petWhere = '1 = 1';
      petParams.length = 0;
    }

    const pets = await many<{ id: string; name: string; speciesIcon: string }>(
      `SELECT ${PET_COLUMNS} FROM pets p
       JOIN species s ON s.code = p.species_code
       LEFT JOIN breeds b ON b.id = p.breed_id
       WHERE ${petWhere} ORDER BY p.created_at`,
      petParams,
    );

    const care = [];
    for (const pet of pets) {
      const summary = await careForPet(pet.id, date);
      care.push({
        petId: pet.id,
        petName: pet.name,
        speciesIcon: pet.speciesIcon,
        due: summary.summary.due,
        completed: summary.summary.completed,
        tasks: summary.tasks.slice(0, 4),
      });
    }

    const upcomingVaccinations = await many(
      `SELECT v.id, v.vaccine_name AS "vaccineName", v.next_due_on AS "nextDueOn",
              p.id AS "petId", p.name AS "petName"
       FROM vaccinations v JOIN pets p ON p.id = v.pet_id
       WHERE p.owner_id = $1 AND v.next_due_on IS NOT NULL
         AND v.next_due_on <= $2::date
       UNION ALL
       SELECT vc.id, vc.vaccine_name, vc.due_on, p.id, p.name
       FROM vaccination_checkpoints vc JOIN pets p ON p.id = vc.pet_id
       WHERE p.owner_id = $1 AND vc.status = 'pending'
         AND vc.due_on <= $2::date
       ORDER BY 3 LIMIT 10`,
      [user.id, addDays(date, 60)],
    );

    const appointmentWhere =
      user.role === 'vet' ? 'a.vet_id = $1' : user.role === 'owner' ? 'a.owner_id = $1' : '1 = 1';
    const appointments = await many(
      `SELECT a.id, a.scheduled_for AS "scheduledFor", a.mode, a.status, a.reason,
              p.name AS "petName", p.id AS "petId",
              owner.full_name AS "ownerName", vet.full_name AS "vetName"
       FROM appointments a
       JOIN pets p ON p.id = a.pet_id
       JOIN users owner ON owner.id = a.owner_id
       JOIN users vet ON vet.id = a.vet_id
       WHERE ${appointmentWhere} AND a.status IN ('pending','accepted')
       ORDER BY a.scheduled_for LIMIT 10`,
      user.role === 'admin' ? [] : [user.id],
    );

    const notifications = await many(
      `SELECT id, title, body, kind, link, read_at AS "readAt", created_at AS "createdAt"
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [user.id],
    );
    const unread = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [user.id],
    );

    const prefs = await one<{ notification_prefs: unknown; privacy: unknown }>(
      'SELECT notification_prefs, privacy FROM users WHERE id = $1',
      [user.id],
    );

    let vetQueue = 0;
    if (user.role === 'admin') {
      const q = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM vet_profiles WHERE verification_status = 'pending'`,
      );
      vetQueue = Number(q?.n ?? 0);
    }
    if (user.role === 'vet') {
      const q = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM appointments WHERE vet_id = $1 AND status = 'pending'`,
        [user.id],
      );
      vetQueue = Number(q?.n ?? 0);
    }

    res.json({
      date,
      serverTime: db?.now,
      care,
      pets,
      upcomingVaccinations,
      appointments,
      notifications,
      unreadNotifications: Number(unread?.n ?? 0),
      notificationPrefs: prefs?.notification_prefs ?? {},
      privacy: prefs?.privacy ?? {},
      vetQueue,
    });
  }),
);
