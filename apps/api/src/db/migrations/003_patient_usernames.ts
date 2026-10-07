import type { Knex } from 'knex';

/**
 * Every patient has a username, made from their name when they are registered (owner decision 2026-10-07), and a
 * login can sign in with it. `patients.username` reserves it; `users.username` is what the sign-in looks up once
 * the patient has a login (created with the patient card). Existing patients get theirs here.
 */
const plain = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('patients', (t) => {
    t.string('username', 40).nullable();
    t.unique(['username'], 'patients_username_unique');
  });
  await knex.schema.alterTable('users', (t) => {
    t.string('username', 40).nullable();
    t.unique(['username'], 'users_username_unique');
  });

  const taken = new Set<string>((await knex('users').whereNotNull('username').select('username')).map((r: { username: string }) => r.username));
  const patients = await knex('patients').select('id', 'patient_identifier', 'fname', 'lname').orderBy('id');
  for (const p of patients as { id: number; patient_identifier: string; fname: string; lname: string }[]) {
    const first = plain(String(p.fname).trim().split(/\s+/)[0] ?? '');
    const last = plain(String(p.lname));
    const base = (first && last ? `${first}.${last}` : first || last || `patient${plain(String(p.patient_identifier))}`).slice(0, 36);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
    taken.add(name);
    await knex('patients').where({ id: p.id }).update({ username: name });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropUnique(['username'], 'users_username_unique');
    t.dropColumn('username');
  });
  await knex.schema.alterTable('patients', (t) => {
    t.dropUnique(['username'], 'patients_username_unique');
    t.dropColumn('username');
  });
}
