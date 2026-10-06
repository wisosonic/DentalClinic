import { useState } from 'react';
import TableCell, { type TableCellProps } from '@mui/material/TableCell';
import TableSortLabel from '@mui/material/TableSortLabel';

export type Order = 'asc' | 'desc';

/** Which column a table is sorted by, and which way. Clicking the same column flips the direction. */
export function useSort<K extends string>(initial: K, initialOrder: Order = 'asc') {
  const [sort, setSort] = useState<{ key: K; order: Order }>({ key: initial, order: initialOrder });
  const toggle = (key: K) => setSort((s) => (s.key === key ? { key, order: s.order === 'asc' ? 'desc' : 'asc' } : { key, order: 'asc' }));
  return { ...sort, toggle };
}

/** A column header that sorts the table when clicked (and works from the keyboard). */
export function SortCell<K extends string>({
  field, sort, children, ...cell
}: { field: K; sort: { key: K; order: Order; toggle: (key: K) => void } } & Omit<TableCellProps, 'sortDirection'>) {
  const active = sort.key === field;
  return (
    <TableCell {...cell} sortDirection={active ? sort.order : false}>
      <TableSortLabel active={active} direction={active ? sort.order : 'asc'} onClick={() => sort.toggle(field)}>
        {children}
      </TableSortLabel>
    </TableCell>
  );
}

/** Sorts rows in the browser, for tables that show every row at once. Text compares naturally and ignores case; blanks go last. */
export function sortRows<T>(rows: T[], value: (row: T) => string | number | null | undefined, order: Order): T[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sign = order === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const xe = x == null || x === '';
    const ye = y == null || y === '';
    if (xe || ye) return xe && ye ? 0 : xe ? 1 : -1; // blanks last in both directions
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return collator.compare(String(x), String(y)) * sign;
  });
}
