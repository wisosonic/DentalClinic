import type { Knex } from 'knex';

const ESC = '!';
const escapeLike = (s: string) => s.replace(/[!%_]/g, (c) => ESC + c);

/**
 * Every whitespace-separated word of `q` must appear in at least one of `columns`
 * ("hicham cheaib" finds fname=hicham, lname=cheaib). Parameterized; wildcards in the
 * input are matched literally. `!` is the escape character because it means the same in
 * SQLite and MySQL, unlike backslash.
 */
export function whereWords(qb: Knex.QueryBuilder, columns: string[], q: string | undefined): void {
  const words = (q ?? '').split(/\s+/).filter(Boolean).slice(0, 6);
  for (const word of words) {
    const pattern = `%${escapeLike(word.toLowerCase())}%`;
    qb.where((w) => {
      for (const col of columns) w.orWhereRaw(`LOWER(??) LIKE ? ESCAPE '${ESC}'`, [col, pattern]);
    });
  }
}
